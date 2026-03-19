/**
 * Integration test: ZenBPM → n8n worker round-trip
 *
 * Steps:
 *  1. Deploy the echo BPMN process definition via the ZenBPM REST API.
 *  2. Start a process instance with known input variables.
 *  3. Start the n8n worker (in-process) so it picks up the service task.
 *  4. Poll the REST API until the instance reaches state "completed".
 *  5. Assert that the instance variables contain the expected output
 *     produced by the n8n Set node.
 *
 * The test uses only built-in Node.js modules and the project's own
 * source — no test framework is required.  It exits with code 0 on
 * success and 1 on failure.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

import { loadConfig } from '../src/config/loader';
import { ZenbpmGrpcClient } from '../src/grpc/client';
import { JobDispatcher } from '../src/worker/dispatcher';
import { buildRegistry } from '../src/worker/registry';

// ─── Configuration ────────────────────────────────────────────────────────────

// IPv6 hostname for http.request (no brackets — URL.hostname keeps them, http.request doesn't want them)
const ZENBPM_HOST = '::1';
const ZENBPM_PORT = 8080;
const TEST_CONFIG  = path.resolve(__dirname, 'fixtures/test-config.yaml');
const BPMN_FILE    = path.resolve(__dirname, 'fixtures/echo-process.bpmn');

/** Input variables sent when the process instance is started. */
const INPUT_VARS = { greeting: 'hello-from-test', value: 42 };

/** Maximum time to wait for the instance to complete (ms). */
const POLL_TIMEOUT_MS = 30_000;
/** Interval between poll requests (ms). */
const POLL_INTERVAL_MS = 500;

// ─── Minimal HTTP helpers ─────────────────────────────────────────────────────

function httpRequest(options: http.RequestOptions & { body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** Multipart/form-data upload of a single file field. */
function uploadFile(apiPath: string, fieldName: string, filePath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const boundary = `----FormBoundary${Date.now().toString(16)}`;
    const fileContent = fs.readFileSync(filePath);
    const fileName    = path.basename(filePath);

    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
      `Content-Type: application/xml\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body   = Buffer.concat([header, fileContent, footer]);

    const options: http.RequestOptions = {
      hostname: ZENBPM_HOST,
      port:     ZENBPM_PORT,
      path:     apiPath,
      method:   'POST',
      headers: {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function jsonPost(apiPath: string, payload: unknown): Promise<{ status: number; body: string }> {
  const body = JSON.stringify(payload);
  return httpRequest({
    hostname: ZENBPM_HOST,
    port:     ZENBPM_PORT,
    path:     apiPath,
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });
}

function jsonGet(apiPath: string): Promise<{ status: number; body: string }> {
  return httpRequest({
    hostname: ZENBPM_HOST,
    port:     ZENBPM_PORT,
    path:     apiPath,
    method:   'GET',
  });
}

/**
 * Extract an int64 key from a raw JSON string by field name.
 * Using JSON.parse() loses precision for values > Number.MAX_SAFE_INTEGER (2^53-1),
 * which ZenBPM int64 keys routinely exceed.  Regex extraction preserves the exact
 * digit string so it can be injected verbatim into subsequent request bodies.
 */
function extractInt64(rawJson: string, fieldName: string): string {
  const re = new RegExp(`"${fieldName}"\\s*:\\s*(\\d+)`);
  const m = rawJson.match(re);
  if (!m) throw new Error(`Could not extract int64 field "${fieldName}" from: ${rawJson}`);
  return m[1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deployProcess(): Promise<string> {
  console.log('[Test] Deploying BPMN process definition...');
  const res = await uploadFile('/v1/process-definitions', 'resource', BPMN_FILE);
  if (res.status === 201) {
    // Extract key as raw string — JSON.parse would lose int64 precision
    const key = extractInt64(res.body, 'processDefinitionKey');
    console.log(`[Test] Deployed process definition key: ${key}`);
    return key;
  }
  if (res.status === 409) {
    // Duplicate — the key appears as a number in the error message string
    const key = res.body.match(/(\d{15,})/)?.[1];
    if (!key) throw new Error(`Deploy conflict but could not extract key: ${res.body}`);
    console.log(`[Test] Process definition already deployed, reusing key: ${key}`);
    return key;
  }
  throw new Error(`Deploy failed (HTTP ${res.status}): ${res.body}`);
}

async function startInstance(processDefinitionKey: string): Promise<string> {
  console.log('[Test] Starting process instance...');
  // Inject the key verbatim as a JSON number literal to avoid float precision loss
  const rawBody = `{"processDefinitionKey":${processDefinitionKey},"variables":${JSON.stringify(INPUT_VARS)}}`;
  const res = await httpRequest({
    hostname: ZENBPM_HOST,
    port:     ZENBPM_PORT,
    path:     '/v1/process-instances',
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(rawBody),
    },
    body: rawBody,
  });
  if (res.status !== 201) {
    throw new Error(`Start instance failed (HTTP ${res.status}): ${res.body}`);
  }
  // Extract instance key as raw string to preserve int64 precision
  const key = extractInt64(res.body, 'key');
  console.log(`[Test] Started process instance key: ${key}`);
  return key;
}

interface ProcessInstance {
  state:     string;
  variables: Record<string, unknown>;
}

async function pollUntilCompleted(instanceKey: string): Promise<ProcessInstance> {
  console.log(`[Test] Polling instance ${instanceKey} until completed (timeout ${POLL_TIMEOUT_MS}ms)...`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    // Use list endpoint — direct GET by key returns a partition-routing error
    // on single-node ZenBPM deployments.
    const res = await jsonGet('/v1/process-instances?size=100');
    if (res.status !== 200) {
      console.warn(`[Test] Poll returned HTTP ${res.status}, retrying...`);
      continue;
    }

    // Locate the JSON object for our instance by searching for its exact key literal.
    // We cannot use JSON.parse because int64 keys lose precision when parsed as
    // JS numbers.  Instead, extract the "state" and "variables" that appear
    // immediately after the key in the response body.
    if (!res.body.includes(`"key":${instanceKey}`)) continue;

    // Extract state — appears in the object containing our key
    const stateMatch = res.body.match(
      new RegExp(`"key":${instanceKey}[^}]*?"state":\\s*"([^"]+)"`),
    ) ?? res.body.match(
      new RegExp(`"state":\\s*"([^"]+)"[^}]*?"key":${instanceKey}`),
    );
    const state = stateMatch ? stateMatch[1] : 'unknown';
    console.log(`[Test] Instance state: ${state}`);

    if (state === 'completed') {
      // Extract variables — parse the variables object from the raw body.
      // The variables field is a plain JSON object without int64 keys, so
      // JSON.parse is safe here.
      const varMatch = res.body.match(
        new RegExp(`"key":${instanceKey}.*?"variables":\\s*(\\{[^}]*\\})`),
      ) ?? res.body.match(
        new RegExp(`"variables":\\s*(\\{[^}]*\\})[^}]*"key":${instanceKey}`),
      );
      const variables = varMatch ? (JSON.parse(varMatch[1]) as Record<string, unknown>) : {};
      return { state, variables };
    }

    if (state === 'terminated' || state === 'failed') {
      throw new Error(`Instance ended with unexpected state: ${state}`);
    }
  }

  throw new Error(`Timed out after ${POLL_TIMEOUT_MS}ms waiting for instance to complete.`);
}

// ─── Worker lifecycle ─────────────────────────────────────────────────────────

async function startWorker(): Promise<{ stop: () => Promise<void> }> {
  console.log('[Test] Starting worker...');
  const config     = loadConfig(TEST_CONFIG);
  const grpcClient = new ZenbpmGrpcClient({
    address:  config.zenbpm.address,
    clientId: config.zenbpm.clientId,
  });
  const registry   = await buildRegistry(config);
  const dispatcher = new JobDispatcher(grpcClient, registry);
  await grpcClient.connect();
  dispatcher.start();
  console.log('[Test] Worker started.');
  return {
    stop: async () => {
      console.log('[Test] Stopping worker...');
      await grpcClient.stop();
    },
  };
}

// ─── Assertions ───────────────────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── Main test ────────────────────────────────────────────────────────────────

async function runTest(): Promise<void> {
  console.log('\n=== ZenBPM worker integration test ===\n');

  // 1. Deploy process definition
  const processDefinitionKey = await deployProcess();

  // 2. Start worker before creating instance so it is already subscribed
  const worker = await startWorker();

  // 3. Start a process instance
  const instanceKey = await startInstance(processDefinitionKey);

  // 4. Poll until completed
  let instance: ProcessInstance;
  try {
    instance = await pollUntilCompleted(instanceKey);
  } finally {
    await worker.stop();
  }

  // 5. Assert output variables
  console.log('\n[Test] Instance variables after completion:');
  console.log(JSON.stringify(instance.variables, null, 2));

  const vars = instance.variables as Record<string, unknown>;

  assert('worker_marker' in vars,   'variables should contain worker_marker');
  assert('echoed_greeting' in vars, 'variables should contain echoed_greeting');
  assert('echoed_value' in vars,    'variables should contain echoed_value');

  assertEq(vars['worker_marker'],   'n8n-worker-ok',      'worker_marker');
  assertEq(vars['echoed_greeting'], INPUT_VARS.greeting,  'echoed_greeting');
  assertEq(vars['echoed_value'],    INPUT_VARS.value,      'echoed_value');

  console.log('\n=== TEST PASSED ===\n');
}

runTest()
  .then(() => process.exit(0))
  .catch((err: Error) => {
    console.error('\n=== TEST FAILED ===');
    console.error(err.message);
    process.exit(1);
  });
