import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * A named credential set.
 *
 * The `type` field is adapter-specific:
 *   - For the n8n adapter it is the n8n credential type name (e.g. "slackApi").
 *   - For the HTTP adapter it can be "bearer", "basic", or "header".
 *
 * Fields are key/value pairs whose values are resolved from environment
 * variables at startup using the `env:VAR_NAME` syntax.
 *
 * Example:
 *   credentials:
 *     my-slack-prod:
 *       type: slackApi
 *       fields:
 *         accessToken: env:SLACK_PROD_TOKEN
 */
export const CredentialSchema = z.object({
  type: z.string(),
  fields: z.record(z.string()),
});

export type CredentialConfig = z.infer<typeof CredentialSchema>;

// ---------------------------------------------------------------------------
// Worker mapping — adapter-agnostic core
// ---------------------------------------------------------------------------

/**
 * Base fields shared by all worker mappings regardless of adapter.
 */
const BaseWorkerMappingSchema = z.object({
  /** ZenBPM service task job type (must match the BPMN definition). */
  jobType: z.string(),
  /** Which adapter handles this job: "http" | "n8n" | custom string. */
  adapter: z.string().default('n8n'),
});

// ---------------------------------------------------------------------------
// n8n adapter mapping
// ---------------------------------------------------------------------------

/**
 * Worker mapping for the n8n adapter.
 *
 * `credentials` maps the integration's credential key (e.g. "slackApi")
 * to a named credential defined in the top-level `credentials` section.
 *
 * `parameters` are passed to the integration node and support expressions
 * such as `={{$json.channel}}` where `$json` is the ZenBPM job variables.
 *
 * Example:
 *   workers:
 *     - jobType: send-slack-message
 *       adapter: n8n
 *       integration: slack
 *       action: message.post
 *       credentials:
 *         slackApi: my-slack-prod
 *       parameters:
 *         channel: "={{$json.channel}}"
 *         text: "={{$json.text}}"
 */
export const N8nWorkerMappingSchema = BaseWorkerMappingSchema.extend({
  adapter: z.literal('n8n').default('n8n'),
  /**
   * Integration name — the service to integrate with (e.g. "slack", "github", "postgres").
   * Resolved internally to the appropriate node implementation.
   */
  integration: z.string(),
  /**
   * Action to perform, in "resource.operation" form (e.g. "message.post", "issue.create").
   * Resolved internally to the node's resource + operation parameters.
   */
  action: z.string(),
  /**
   * Optional node package override. Defaults to "n8n-nodes-base".
   * Use this only when the integration lives in a community package.
   * Example: "n8n-nodes-community-slack-advanced"
   */
  package: z.string().default('n8n-nodes-base'),
  /** Maps integration credential key → named credential from top-level credentials map */
  credentials: z.record(z.string()).default({}),
  /** Static or expression-based node parameters (merged with the action's resource/operation) */
  parameters: z.record(z.unknown()).default({}),
});

export type N8nWorkerMapping = z.infer<typeof N8nWorkerMappingSchema>;

// ---------------------------------------------------------------------------
// HTTP adapter mapping
// ---------------------------------------------------------------------------

/**
 * Worker mapping for the built-in HTTP adapter.
 *
 * Makes an HTTP request when a job is received.  Job variables are
 * forwarded as the JSON request body by default; the full response body
 * is returned as the job result.
 *
 * Example:
 *   workers:
 *     - jobType: notify-webhook
 *       adapter: http
 *       url: "https://hooks.example.com/notify"
 *       method: POST
 *       credential: my-webhook-secret   # optional
 *       headers:
 *         X-Source: zenbpm
 */
export const HttpWorkerMappingSchema = BaseWorkerMappingSchema.extend({
  adapter: z.literal('http'),
  /** Target URL. Supports simple `{{varName}}` placeholder substitution from job variables. */
  url: z.string(),
  /** HTTP method (default: POST) */
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
  /**
   * Optional credential name (from top-level credentials) to attach.
   * Supported types: "bearer" (Authorization: Bearer <token>),
   * "basic" (Authorization: Basic <base64>), "header" (custom header).
   */
  credential: z.string().optional(),
  /** Additional static headers merged into the request */
  headers: z.record(z.string()).default({}),
  /**
   * What to send as the request body.
   *   "variables" (default) — sends the job variables as JSON body
   *   "none"                — no body (e.g. for GET requests)
   */
  body: z.enum(['variables', 'none']).default('variables'),
});

export type HttpWorkerMapping = z.infer<typeof HttpWorkerMappingSchema>;

// ---------------------------------------------------------------------------
// Discriminated union of all known worker mappings
// ---------------------------------------------------------------------------

export const WorkerMappingSchema = z.discriminatedUnion('adapter', [
  N8nWorkerMappingSchema,
  HttpWorkerMappingSchema,
]);

export type WorkerMapping = z.infer<typeof WorkerMappingSchema>;

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

export const ConfigSchema = z.object({
  zenbpm: z.object({
    address: z.string().default('localhost:9090'),
    clientId: z.string().default('zenbpm-worker'),
  }),
  /**
   * Named credential sets. Key is a user-defined name referenced by workers.
   * Multiple entries of the same credential type are fully supported.
   */
  credentials: z.record(CredentialSchema).default({}),
  workers: z.array(WorkerMappingSchema),
});

export type WorkerConfig = z.infer<typeof ConfigSchema>;
