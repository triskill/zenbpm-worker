/**
 * HTTP adapter — implements IJobExecutor by making an HTTP request.
 *
 * This adapter has no third-party dependencies beyond Node.js built-ins.
 * It is licensed under Apache 2.0 as part of zenbpm-worker.
 *
 * Features:
 *   - Supports GET, POST, PUT, PATCH, DELETE
 *   - Forwards job variables as a JSON request body (configurable)
 *   - Supports bearer token, basic auth, and custom header credentials
 *   - URL supports simple {{varName}} placeholder substitution
 *   - Returns the response body (parsed JSON or raw text) as the job result
 */
import * as https from 'https';
import * as http from 'http';
import { IJobExecutor, JobContext, JobResult } from '../../executor';
import { HttpWorkerMapping } from '../../config/types';
import { CredentialConfig } from '../../config/types';

export class HttpJobExecutor implements IJobExecutor {
  constructor(
    private readonly mapping: HttpWorkerMapping,
    private readonly credential: CredentialConfig | undefined,
  ) {}

  async execute(context: JobContext): Promise<JobResult> {
    const url = interpolateUrl(this.mapping.url, context.variables);
    const method = this.mapping.method;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...this.mapping.headers,
    };

    // Attach credentials if configured
    if (this.credential) {
      applyCredential(headers, this.credential);
    }

    const body =
      this.mapping.body === 'variables' && method !== 'GET'
        ? JSON.stringify(context.variables)
        : undefined;

    const responseBody = await makeRequest(url, method, headers, body);

    // Try to parse as JSON; fall back to returning raw text
    try {
      return JSON.parse(responseBody) as JobResult;
    } catch {
      return { response: responseBody };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Replaces {{varName}} placeholders in the URL with values from job variables.
 * E.g. "https://api.example.com/users/{{userId}}" + { userId: "42" }
 *      → "https://api.example.com/users/42"
 */
function interpolateUrl(url: string, variables: Record<string, unknown>): string {
  return url.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined || value === null) return '';
    return encodeURIComponent(String(value));
  });
}

/**
 * Attaches authentication headers based on the credential type.
 *
 * Supported types:
 *   bearer — Authorization: Bearer <token>    (field: token)
 *   basic  — Authorization: Basic <b64>       (fields: username, password)
 *   header — <name>: <value>                  (fields: name, value)
 */
function applyCredential(
  headers: Record<string, string>,
  cred: CredentialConfig,
): void {
  switch (cred.type) {
    case 'bearer':
      if (cred.fields['token']) {
        headers['Authorization'] = `Bearer ${cred.fields['token']}`;
      }
      break;

    case 'basic': {
      const user = cred.fields['username'] ?? '';
      const pass = cred.fields['password'] ?? '';
      const encoded = Buffer.from(`${user}:${pass}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
      break;
    }

    case 'header':
      if (cred.fields['name'] && cred.fields['value']) {
        headers[cred.fields['name']] = cred.fields['value'];
      }
      break;

    default:
      console.warn(
        `[http/executor] Unknown credential type "${cred.type}" — skipping auth.`,
      );
  }
}

/**
 * Minimal promise-based HTTP(S) request using Node.js built-ins.
 */
function makeRequest(
  rawUrl: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(rawUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        ...headers,
        ...(body ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        const statusCode = res.statusCode ?? 0;
        if (statusCode >= 400) {
          reject(
            new Error(
              `[http/executor] Request to ${rawUrl} failed with HTTP ${statusCode}: ${raw.slice(0, 200)}`,
            ),
          );
        } else {
          resolve(raw);
        }
      });
    });

    req.on('error', (err: Error) => {
      reject(new Error(`[http/executor] Network error for ${rawUrl}: ${err.message}`));
    });

    if (body) req.write(body);
    req.end();
  });
}
