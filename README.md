# ZenBPM Worker

> **Work in progress — not production ready.**

A standalone job worker that connects to a [ZenBPM](https://github.com/pbinitiative/zenbpm) BPMN engine via gRPC and executes service tasks using pluggable adapter backends.

The worker subscribes to ZenBPM job types over a bidirectional gRPC stream, runs the configured adapter for each received job, and reports completion or failure back to the engine — all in parallel.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  ZenBPM Engine  (gRPC :9090)                                    │
│                                                                 │
│  BPMN Process:  [Start] → [notify-webhook] → [End]              │
│                                ↕ bidirectional JobStream        │
└────────────────────────────────┼────────────────────────────────┘
                                 │
                    WaitingJob { key, type, variables }
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────┐
│  zenbpm-worker                                                 │
│                                                                │
│  ┌──────────────┐   ┌─────────────────┐   ┌─────────────────┐  │
│  │ ZenbpmGrpc   │   │  JobDispatcher  │   │  Config Loader  │  │
│  │ Client       │──▶│  (parallel)     │◀──│  (YAML + Zod)   │  │
│  │              │   │                 │   └─────────────────┘  │
│  │ • subscribe  │   │  per job:       │                        │
│  │ • complete   │   │  executor       │   ┌─────────────────┐  │
│  │ • fail       │   │  .execute()     │──▶│  IJobExecutor   │  │
│  │ • reconnect  │   │                 │   │  (adapter)      │  │
│  └──────────────┘   └─────────────────┘   └─────────┬───────┘  │
│                                                     │          │
│                         ┌───────────────────────────┤          │
│                         │                           │          │
│                    ┌────▼─────┐            ┌────────▼───────┐  │
│                    │  http    │            │  n8n (opt.)    │  │
│                    │ adapter  │            │  adapter       │  │
│                    │          │            │                │  │
│                    │ POST/GET │            │ Slack, GitHub, │  │
│                    │ webhooks │            │ Postgres, ...  │  │
│                    └──────────┘            └────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

### How it works

1. On startup the worker reads `config.yaml`, resolves all `env:VAR` credential references, and builds an executor registry.
2. It opens a gRPC `JobStream` to ZenBPM and sends a `SUBSCRIBE` request for every configured `jobType`.
3. When ZenBPM delivers a `WaitingJob`, the dispatcher looks up the matching executor adapter and spawns an async execution (jobs run in parallel).
4. The adapter performs the action (HTTP call, database query, etc.) using job variables as input.
5. Output variables are sent back via `JobCompleteRequest`; any exception triggers `JobFailRequest`.
6. The gRPC stream reconnects automatically with exponential back-off on network errors.

---

## Installation

```bash
npm install
npm run build
```

The core worker has no third-party runtime dependencies beyond `@grpc/grpc-js`, `js-yaml`, and `zod`.

---

## Adapters

Each worker mapping declares an `adapter` field that selects the execution backend.

### Built-in: `http`

Makes an HTTP request when a job is received. No additional packages required.

```yaml
workers:
  - jobType: notify-webhook
    adapter: http
    url: "https://hooks.example.com/events"
    method: POST          # GET | POST | PUT | PATCH | DELETE  (default: POST)
    credential: my-token  # optional — references a named credential below
    headers:
      X-Source: zenbpm
    body: variables       # "variables" (default) | "none"
```

Job variables are forwarded as the JSON request body. The response body (parsed as JSON if possible) becomes the job result variables.

**URL placeholders:** Use `{{varName}}` to interpolate job variables into the URL:

```yaml
url: "https://api.example.com/users/{{userId}}/notify"
```

**Credential types for the http adapter:**

| type     | Fields                | Header produced                         |
|----------|-----------------------|-----------------------------------------|
| `bearer` | `token`               | `Authorization: Bearer <token>`         |
| `basic`  | `username`,`password` | `Authorization: Basic <base64>`         |
| `header` | `name`, `value`       | `<name>: <value>` (arbitrary header)    |

---

### Optional: `n8n`

Executes an [n8n](https://n8n.io) integration node (Slack, GitHub, Postgres, HTTP Request, and 150+ others) as a job handler.

> **License notice:** The n8n adapter depends on `n8n-workflow`, `n8n-core`, and `n8n-nodes-base`
> which are distributed under the [n8n Sustainable Use License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md).
> This license permits internal business use and non-commercial distribution.
> See [NOTICE](./NOTICE) for details.

**Install the optional packages to enable this adapter:**

```bash
npm install n8n-workflow@2.13.0 n8n-core@2.13.0 n8n-nodes-base@2.13.0
```

**Configuration:**

```yaml
credentials:
  slack-prod:
    type: slackApi          # credential type required by the integration
    fields:
      accessToken: env:SLACK_PROD_TOKEN

workers:
  - jobType: send-slack-message
    adapter: n8n
    integration: slack      # service name (slack, github, postgres, …)
    action: message.post    # "resource.operation" or just "operation"
    credentials:
      slackApi: slack-prod
    parameters:
      channel: "={{$json.channel}}"   # expression — $json is the job variables
      text: "={{$json.text}}"
```

The `action` field uses a `resource.operation` format that maps to the integration's capabilities:

```yaml
action: message.post      # resource=message, operation=post
action: issue.create      # resource=issue,   operation=create
action: executeQuery      # no resource — maps to operation=executeQuery
```

`resource` and `operation` are derived from `action` automatically. Any value in `parameters` overrides them if needed. Additional parameters are passed directly to the integration.

**Expressions:** Job variables from ZenBPM are exposed as `$json`:

```yaml
parameters:
  channel: "={{$json.channel}}"
  text: "={{$json.message}}"
```

**Community packages:** Use the optional `package` field when the integration lives outside `n8n-nodes-base`:

```yaml
- jobType: my-custom-job
  adapter: n8n
  integration: myIntegration
  package: n8n-nodes-my-community-package
  action: data.process
```

**Supported integrations:** Any programmatic node in `n8n-nodes-base` with an `execute()` method — 150+ integrations including Slack, Gmail, Teams, GitHub, GitLab, Jira, Postgres, MySQL, MongoDB, Redis, HTTP Request, S3, Google Drive, Crypto, Code, and more. Declarative-only nodes and trigger/poll nodes are not supported.

---

## Writing a custom adapter

Implement the `IJobExecutor` interface from `src/executor.ts`:

```typescript
import { IJobExecutor, JobContext, JobResult } from './src/executor';

export class MyAdapter implements IJobExecutor {
  async execute(context: JobContext): Promise<JobResult> {
    const { jobType, variables } = context;
    // ... do work ...
    return { status: 'ok' };
  }
}
```

Then register it in `src/index.ts` by adding a new `case` to the adapter switch in `buildRegistry()`.

---

## Configuration reference

```yaml
zenbpm:
  address: "localhost:9090"   # ZenBPM gRPC address
  clientId: "zenbpm-worker"   # identifier for this worker instance

credentials:
  <name>:
    type: <credential-type>           # adapter-specific type string
    fields:
      <field>: env:<ENV_VAR>          # or a plain string literal

workers:
  # HTTP adapter
  - jobType: <zenbpm-job-type>
    adapter: http
    url: <url>                        # supports {{varName}} placeholders
    method: POST                      # optional, default POST
    credential: <credential-name>     # optional
    headers:                          # optional static headers
      <name>: <value>
    body: variables                   # optional, default "variables"

  # n8n adapter (requires optional n8n packages)
  - jobType: <zenbpm-job-type>
    adapter: n8n
    integration: <service>            # e.g. slack, github, postgres
    action: <resource.operation>      # e.g. message.post, issue.create, executeQuery
    package: <package-name>           # optional
    credentials:
      <credential-key>: <credential-name>
    parameters:
      <param>: <value or expression>  # expressions: ={{$json.varName}}
```

---

## Running

```bash
# Set required env vars for credentials
export SLACK_TOKEN=xoxb-...
export WEBHOOK_SECRET=secret

CONFIG_PATH=./config.yaml npm start
```

## Environment variables

| Variable       | Description                          | Default         |
|----------------|--------------------------------------|-----------------|
| `CONFIG_PATH`  | Path to config YAML file             | `./config.yaml` |
| Any `env:*` refs | Credential field values            | —               |

---

## License

The core worker (`src/` except `src/adapters/n8n/`) is licensed under the **Apache License 2.0**. See [LICENSE](./LICENSE).

The optional n8n adapter (`src/adapters/n8n/`) depends on n8n packages that are governed by the **n8n Sustainable Use License**. See [NOTICE](./NOTICE) for the full disclosure.
