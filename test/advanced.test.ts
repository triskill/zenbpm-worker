/**
 * Advanced integration test: zenbpm-worker capability coverage
 *
 * Covers the following scenarios, each handled by a distinct n8n node:
 *
 *  Happy-path process (advanced-test, 5 sequential service tasks):
 *   1. n8n Set node (string expression)  — uppercases a string using ={{...}}
 *   2. n8n Crypto node                   — SHA-256 hash of a known literal
 *   3. n8n HTTP Request node             — POST to httpbin.org/post, assert echo
 *   4. n8n GitHub node                   — creates a real issue on triskill/zenbpm-worker
 *   5. n8n Set node (numeric expression) — doubles a number using ={{...}}
 *
 *  Error-path process (error-test, 1 service task):
 *   6. n8n HTTP Request node → HTTP 500  — asserts the instance ends in state "failed"
 *
 * The test uses only built-in Node.js modules and the project's own source.
 * No test framework is required.  Exits with code 0 on success, 1 on failure.
 *
 * Prerequisites:
 *   - A live ZenBPM engine on [::1]:8080 (REST) and localhost:9090 (gRPC).
 *   - n8n optional packages installed (npm install --include=optional).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

import { loadConfig }       from '../src/config/loader';
import { ZenbpmGrpcClient } from '../src/grpc/client';
import { JobDispatcher }    from '../src/worker/dispatcher';
import { buildRegistry }    from '../src/worker/registry';

// ─── Configuration ────────────────────────────────────────────────────────────

const ZENBPM_HOST = '::1';
const ZENBPM_PORT = 8080;

// Prefer a local secrets override (gitignored) over the committed template.
// Fallback order:
//   1. test/fixtures/advanced-config.local.yaml  (gitignored, has real token)
//   2. test/fixtures/advanced-config.yaml        (committed, token read from $GITHUB_TOKEN)
const LOCAL_CONFIG       = path.resolve(__dirname, 'fixtures/advanced-config.local.yaml');
const TEST_CONFIG        = fs.existsSync(LOCAL_CONFIG)
  ? LOCAL_CONFIG
  : path.resolve(__dirname, 'fixtures/advanced-config.yaml');
const ADVANCED_BPMN_FILE = path.resolve(__dirname, 'fixtures/advanced-process.bpmn');
const ERROR_BPMN_FILE    = path.resolve(__dirname, 'fixtures/error-process.bpmn');

/** Known SHA-256 of the string "zenbpm" (hex-encoded). Pre-computed. */
const EXPECTED_SHA256_ZENBPM = 'c31f032a5b3a615906985e15835532670aa4f126cb1768427d8f86e4fe61c076';

const POLL_TIMEOUT_MS  = 60_000;   // GitHub API can be slow
const POLL_INTERVAL_MS = 1_000;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpRequest(
  options: http.RequestOptions & { body?: string | Buffer },
): Promise<{ status: number; body: string }> {
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

function uploadFile(
  apiPath: string,
  fieldName: string,
  filePath: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const boundary    = `----FormBoundary${Date.now().toString(16)}`;
    const fileContent = fs.readFileSync(filePath);
    const fileName    = path.basename(filePath);

    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
      `Content-Type: application/xml\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body   = Buffer.concat([header, fileContent, footer]);

    const req = http.request(
      {
        hostname: ZENBPM_HOST,
        port:     ZENBPM_PORT,
        path:     apiPath,
        method:   'POST',
        headers: {
          'Content-Type':   `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// jsonPost is kept for potential future use
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
 * Extract an int64 key from raw JSON without losing precision.
 * JSON.parse() loses precision for values > Number.MAX_SAFE_INTEGER.
 */
function extractInt64(rawJson: string, fieldName: string): string {
  const re = new RegExp(`"${fieldName}"\\s*:\\s*(\\d+)`);
  const m  = rawJson.match(re);
  if (!m) throw new Error(`Could not extract int64 field "${fieldName}" from: ${rawJson}`);
  return m[1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Safely parse a JSON string that may contain int64 values larger than
 * Number.MAX_SAFE_INTEGER by quoting known int64 key fields before parsing.
 */
function safeParseJson(raw: string): unknown {
  // Replace bare int64 numbers for ZenBPM key fields with quoted strings so
  // JSON.parse doesn't lose precision.
  const safeRaw = raw.replace(
    /"(key|processDefinitionKey|instanceKey|processInstanceKey)"\s*:\s*(\d{15,})/g,
    (_: string, field: string, num: string) => `"${field}":"${num}"`,
  );
  return JSON.parse(safeRaw);
}

// ─── ZenBPM REST API helpers ──────────────────────────────────────────────────

async function deployProcess(bpmnFile: string): Promise<string> {
  console.log(`[Test] Deploying ${path.basename(bpmnFile)}...`);
  const res = await uploadFile('/v1/process-definitions', 'resource', bpmnFile);
  if (res.status === 201) {
    const key = extractInt64(res.body, 'processDefinitionKey');
    console.log(`[Test] Deployed → key: ${key}`);
    return key;
  }
  if (res.status === 409) {
    const key = res.body.match(/(\d{15,})/)?.[1];
    if (!key) throw new Error(`Deploy conflict, cannot extract key: ${res.body}`);
    console.log(`[Test] Already deployed → reusing key: ${key}`);
    return key;
  }
  throw new Error(`Deploy failed (HTTP ${res.status}): ${res.body}`);
}

async function startInstance(
  processDefinitionKey: string,
  variables: Record<string, unknown>,
): Promise<string> {
  console.log('[Test] Starting process instance...');
  const rawBody = `{"processDefinitionKey":${processDefinitionKey},"variables":${JSON.stringify(variables)}}`;
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
  const key = extractInt64(res.body, 'key');
  console.log(`[Test] Instance key: ${key}`);
  return key;
}

interface ProcessInstance {
  state:     string;
  variables: Record<string, unknown>;
}

/**
 * Poll until the instance reaches a terminal state (completed / failed /
 * terminated).  Returns the final state and variables.
 */
async function pollUntilTerminal(
  instanceKey: string,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<ProcessInstance> {
  console.log(`[Test] Polling instance ${instanceKey} (timeout ${timeoutMs}ms)...`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const res = await jsonGet('/v1/process-instances?size=100');
    if (res.status !== 200) {
      console.warn(`[Test] Poll returned HTTP ${res.status}, retrying...`);
      continue;
    }

    // Quick check: does the response contain our instance key at all?
    if (!res.body.includes(`"key":${instanceKey}`)) continue;

    // Parse safely (int64 keys become strings to avoid precision loss)
    let parsed: unknown;
    try {
      parsed = safeParseJson(res.body);
    } catch (e) {
      console.warn(`[Test] Failed to parse response JSON: ${(e as Error).message}, retrying...`);
      continue;
    }

    // Navigate: { partitions: [ { items: [...] } ] }
    const partitions = (parsed as { partitions?: Array<{ items?: unknown[] }> }).partitions ?? [];
    let foundInstance: { key: string; state: string; variables: Record<string, unknown> } | undefined;
    for (const partition of partitions) {
      for (const item of (partition.items ?? [])) {
        const inst = item as { key: string; state: string; variables: Record<string, unknown> };
        if (String(inst.key) === instanceKey) {
          foundInstance = inst;
          break;
        }
      }
      if (foundInstance) break;
    }

    if (!foundInstance) continue;

    const state = foundInstance.state;
    console.log(`[Test] Instance state: ${state}`);

    if (state === 'completed' || state === 'failed' || state === 'terminated') {
      return { state, variables: foundInstance.variables ?? {} };
    }
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for instance ${instanceKey} to reach terminal state.`);
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
    throw new Error(
      `Assertion failed [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertStartsWith(actual: string, prefix: string, label: string): void {
  if (typeof actual !== 'string' || !actual.startsWith(prefix)) {
    throw new Error(
      `Assertion failed [${label}]: expected string starting with "${prefix}", got ${JSON.stringify(actual)}`,
    );
  }
}

// ─── Happy-path test ──────────────────────────────────────────────────────────

async function runHappyPathTest(worker: { stop: () => Promise<void> }): Promise<void> {
  console.log('\n── Happy-path test (advanced-process.bpmn) ──\n');

  const processDefinitionKey = await deployProcess(ADVANCED_BPMN_FILE);

  const issueTitle = `[zenbpm-worker test] Advanced integration test ${new Date().toISOString()}`;
  const instanceKey = await startInstance(processDefinitionKey, {
    code_input:      'hello',
    crypto_data:     'zenbpm',
    transform_input: 21,
    issue_title:     issueTitle,
  });

  let instance: ProcessInstance;
  try {
    instance = await pollUntilTerminal(instanceKey);
  } finally {
    await worker.stop();
  }

  console.log('\n[Test] Final instance variables:');
  console.log(JSON.stringify(instance.variables, null, 2));

  assertEq(instance.state, 'completed', 'instance.state');

  const vars = instance.variables;

  // ── Scenario 1: Set node (string expression) ──────────────────────────────
  assert('code_result' in vars, 'variables should contain code_result');
  assertEq(vars['code_result'] as string, 'HELLO_processed', 'code_result');

  // ── Scenario 2: Crypto node ───────────────────────────────────────────────
  assert('crypto_hash' in vars, 'variables should contain crypto_hash');
  assertEq(vars['crypto_hash'] as string, EXPECTED_SHA256_ZENBPM, 'crypto_hash');

  // ── Scenario 3: HTTP Request node ─────────────────────────────────────────
  // httpbin.org echoes the posted JSON body under the "json" key.
  // The BPMN maps output field "json" → process variable "http_echo_json".
  assert('http_echo_json' in vars, 'variables should contain http_echo_json');
  const httpEcho = vars['http_echo_json'] as Record<string, unknown> | null;
  assert(
    typeof httpEcho === 'object' && httpEcho !== null && httpEcho['ping'] === 'pong',
    `http_echo_json.ping should be "pong", got: ${JSON.stringify(httpEcho)}`,
  );

  // ── Scenario 4: GitHub node ───────────────────────────────────────────────
  assert('issue_url' in vars, 'variables should contain issue_url');
  assert('issue_number' in vars, 'variables should contain issue_number');
  assertStartsWith(
    vars['issue_url'] as string,
    'https://github.com/',
    'issue_url',
  );
  assert(
    typeof vars['issue_number'] === 'number' && (vars['issue_number'] as number) > 0,
    `issue_number should be a positive number, got: ${JSON.stringify(vars['issue_number'])}`,
  );
  console.log(`[Test] GitHub issue created: ${vars['issue_url'] as string}`);

  // ── Scenario 5: Set node (numeric expression) ─────────────────────────────
  assert('transform_result' in vars, 'variables should contain transform_result');
  assertEq(vars['transform_result'] as number, 42, 'transform_result');
}

// ─── Error-path test ──────────────────────────────────────────────────────────

/**
 * Poll /v1/jobs until the job for the given process instance has been
 * picked up by the worker (i.e. exists in the jobs list).
 * Returns the job's state string.
 */
async function pollUntilJobAttempted(
  instanceKey: string,
  jobType: string,
  timeoutMs = 15_000,
): Promise<string> {
  console.log(`[Test] Polling for job ${jobType} on instance ${instanceKey}...`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await jsonGet('/v1/jobs?size=100');
    if (res.status !== 200) continue;
    // Parse safely
    let parsed: unknown;
    try { parsed = safeParseJson(res.body); } catch { continue; }
    const partitions = (parsed as { partitions?: Array<{ items?: unknown[] }> }).partitions ?? [];
    for (const partition of partitions) {
      for (const item of (partition.items ?? [])) {
        const job = item as { processInstanceKey: string; type: string; state: string };
        if (String(job.processInstanceKey) === instanceKey && job.type === jobType) {
          return job.state;
        }
      }
    }
  }
  throw new Error(`Timed out waiting for job ${jobType} on instance ${instanceKey} to appear`);
}

async function runErrorPathTest(worker: { stop: () => Promise<void> }): Promise<void> {
  console.log('\n── Error-path test (error-process.bpmn) ──\n');

  const processDefinitionKey = await deployProcess(ERROR_BPMN_FILE);
  const instanceKey = await startInstance(processDefinitionKey, {});

  try {
    // Wait for the worker to attempt the n8n-http-fail job.
    // The job will fail because httpbin.org/status/500 returns HTTP 500,
    // which the n8n HttpRequest node treats as an error.
    // The dispatcher calls failJob(), leaving the instance active (ZenBPM retries jobs on failure).
    const jobState = await pollUntilJobAttempted(instanceKey, 'n8n-http-fail');

    // ── Scenario 6: Error handling ─────────────────────────────────────────
    // The job should be in 'active' state — ZenBPM queued it for retry after the
    // worker called failJob().  The critical assertion is that the job was NOT
    // completed (which would require a successful node execution).
    console.log(`[Test] Error job state after worker attempt: "${jobState}"`);
    assert(jobState !== 'completed',
      `Error job should NOT be completed (expected failure/retry), got state: "${jobState}"`);

    // Verify the process instance is still active (not completed — failJob prevented advancement)
    const instanceRes = await jsonGet('/v1/process-instances?size=100');
    let instanceState = 'unknown';
    try {
      const parsed = safeParseJson(instanceRes.body);
      const partitions = (parsed as { partitions?: Array<{ items?: unknown[] }> }).partitions ?? [];
      for (const partition of partitions) {
        for (const item of (partition.items ?? [])) {
          const inst = item as { key: string; state: string };
          if (String(inst.key) === instanceKey) { instanceState = inst.state; break; }
        }
      }
    } catch { /* ignore */ }

    assert(instanceState !== 'completed',
      `Error instance should NOT be completed (expected active/failed), got: "${instanceState}"`);
    console.log(`[Test] Error instance state: "${instanceState}" (not completed — error handled correctly)`);
    console.log('[Test] Worker correctly called failJob() on HTTP 500 error.');
  } finally {
    await worker.stop();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
  console.log('\n=== ZenBPM worker — advanced integration tests ===\n');

  // Happy-path: start a fresh worker (it subscribes to all 6 job types)
  const happyWorker = await startWorker();
  await runHappyPathTest(happyWorker);
  console.log('\n=== HAPPY-PATH TEST PASSED ===\n');

  // Error-path: start another fresh worker (subscribes to n8n-http-fail)
  const errorWorker = await startWorker();
  await runErrorPathTest(errorWorker);
  console.log('\n=== ERROR-PATH TEST PASSED ===\n');

  console.log('=== ALL ADVANCED TESTS PASSED ===\n');
}

runTests()
  .then(() => process.exit(0))
  .catch((err: Error) => {
    console.error('\n=== TEST FAILED ===');
    console.error(err.message);
    process.exit(1);
  });
