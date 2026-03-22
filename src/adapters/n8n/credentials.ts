import type {
  ICredentialDataDecryptedObject,
  ICredentialType,
  ICredentials,
  ICredentialsHelper,
  IHttpRequestOptions,
  INode,
  INodeCredentialsDetails,
  INodeProperties,
  IWorkflowExecuteAdditionalData,
  WorkflowExecuteMode,
} from 'n8n-workflow';
import { Workflow } from 'n8n-workflow';
import { CredentialConfig } from '../../config/types';

// ---------------------------------------------------------------------------
// Credential type loader & generic-auth applicator
// ---------------------------------------------------------------------------

/**
 * Loads an n8n credential type class from n8n-nodes-base by credential type name.
 * Returns null if not found.
 */
function loadCredentialType(typeName: string): ICredentialType | null {
  try {
    // n8n-nodes-base credential classes follow the naming convention
    // <TypeName>.credentials.js where TypeName is PascalCase from the type name.
    // e.g. "githubApi" → "GithubApi.credentials.js"
    const pascal = typeName.charAt(0).toUpperCase() + typeName.slice(1);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(`n8n-nodes-base/dist/credentials/${pascal}.credentials.js`) as Record<string, unknown>;
    const CredClass = Object.values(mod).find((v) => typeof v === 'function') as (new () => ICredentialType) | undefined;
    if (!CredClass) return null;
    return new CredClass();
  } catch {
    return null;
  }
}

/**
 * Resolves a credential template string.
 *
 * Templates may be:
 *   - A plain string:  returned as-is
 *   - An expression starting with `=`:  the `=` is stripped and
 *     `{{$credentials?.field}}` / `{{$credentials.field}}` placeholders
 *     are substituted with the corresponding field from `credData`.
 */
function resolveTemplate(tpl: string, credData: ICredentialDataDecryptedObject): string {
  let s = tpl.startsWith('=') ? tpl.slice(1) : tpl;
  s = s.replace(/\{\{\s*\$credentials\??\.(\w+)\s*\}\}/g, (_, key: string) => {
    const val = credData[key];
    return val !== undefined && val !== null ? String(val) : '';
  });
  return s;
}

/**
 * Applies a `type: 'generic'` credential authenticate definition to the
 * request options by merging resolved headers / qs / body / auth fields.
 */
function applyGenericAuth(
  credType: ICredentialType,
  credData: ICredentialDataDecryptedObject,
  requestOptions: IHttpRequestOptions,
): IHttpRequestOptions {
  const auth = credType.authenticate;
  if (!auth || typeof auth !== 'object' || (auth as { type?: string }).type !== 'generic') {
    return requestOptions;
  }

  const props = (auth as { type: string; properties?: Record<string, Record<string, string>> }).properties ?? {};
  const result: IHttpRequestOptions = { ...requestOptions };

  // headers
  if (props['headers']) {
    const merged: Record<string, string> = { ...(result.headers as Record<string, string> | undefined) };
    for (const [k, v] of Object.entries(props['headers'])) {
      merged[k] = resolveTemplate(v, credData);
    }
    result.headers = merged;
  }

  // query string
  if (props['qs']) {
    const merged: Record<string, string> = { ...(result.qs as Record<string, string> | undefined) };
    for (const [k, v] of Object.entries(props['qs'])) {
      merged[k] = resolveTemplate(v, credData);
    }
    result.qs = merged;
  }

  // body
  if (props['body']) {
    const existing = (result.body ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existing };
    for (const [k, v] of Object.entries(props['body'])) {
      merged[k] = resolveTemplate(v, credData);
    }
    result.body = merged;
  }

  return result;
}

/**
 * Maps a worker's node credential key (e.g. "slackApi") to
 * the resolved credential config from the config file.
 */
export type ResolvedCredentialMap = Record<string, CredentialConfig>;

/**
 * Minimal ICredentialsHelper implementation.
 *
 * Instead of decrypting from a database, credentials are resolved
 * from the config file (with env var substitution applied at load time).
 *
 * Each instance is scoped to a single job execution and holds the
 * resolved credential data for the node being run.
 */
export class EnvCredentialsHelper implements ICredentialsHelper {
  constructor(private readonly credentialMap: ResolvedCredentialMap) {}

  async getDecrypted(
    _additionalData: IWorkflowExecuteAdditionalData,
    nodeCredentials: INodeCredentialsDetails,
    type: string,
    _mode: WorkflowExecuteMode,
  ): Promise<ICredentialDataDecryptedObject> {
    return this._getFields(type, nodeCredentials);
  }

  async authenticate(
    credentials: ICredentialDataDecryptedObject,
    typeName: string,
    requestOptions: IHttpRequestOptions,
    _workflow: Workflow,
    _node: INode,
  ): Promise<IHttpRequestOptions> {
    // Load the credential type definition and apply its `authenticate` property.
    // For `type: 'generic'` credentials (e.g. githubApi) this injects the
    // Authorization header (or other headers/qs fields) into the request options.
    const credType = loadCredentialType(typeName);
    if (credType) {
      return applyGenericAuth(credType, credentials, requestOptions);
    }
    return requestOptions;
  }

  async preAuthentication(
    _helpers: unknown,
    _credentials: ICredentialDataDecryptedObject,
    _typeName: string,
    _node: INode,
    _credentialsExpired: boolean,
  ): Promise<ICredentialDataDecryptedObject | undefined> {
    return undefined;
  }

  async getCredentials(
    nodeCredentials: INodeCredentialsDetails,
    type: string,
  ): Promise<ICredentials> {
    const fields = this._getFields(type, nodeCredentials);
    return {
      id: nodeCredentials.id ?? type,
      name: nodeCredentials.name ?? type,
      type,
      data: JSON.stringify(fields),
      nodesAccess: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ICredentials;
  }

  getParentTypes(_name: string): string[] {
    return [];
  }

  getCredentialsProperties(_type: string): INodeProperties[] {
    return [];
  }

  async updateCredentials(): Promise<void> {
    // no-op: we don't persist OAuth token refreshes
  }

  async updateCredentialsOauthTokenData(): Promise<void> {
    // no-op
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private _getFields(
    type: string,
    _nodeCredentials: INodeCredentialsDetails,
  ): ICredentialDataDecryptedObject {
    // Find a credential whose type matches
    const entry = Object.values(this.credentialMap).find((c) => c.type === type);
    if (!entry) {
      throw new Error(
        `[n8n/credentials] No credential of type "${type}" found for this worker. ` +
          `Make sure the worker config has a credentials entry with type: "${type}".`,
      );
    }
    return entry.fields as ICredentialDataDecryptedObject;
  }
}

/**
 * Builds a ResolvedCredentialMap for a single worker execution.
 * `workerCredentials` maps node credential keys → named credential from config.
 * `allCredentials` is the full credentials section from config.
 */
export function buildCredentialMap(
  workerCredentials: Record<string, string>,
  allCredentials: Record<string, CredentialConfig>,
): ResolvedCredentialMap {
  const map: ResolvedCredentialMap = {};
  for (const [nodeCredKey, credName] of Object.entries(workerCredentials)) {
    const cred = allCredentials[credName];
    if (!cred) {
      throw new Error(
        `[n8n/credentials] Credential "${credName}" not found in credentials config.`,
      );
    }
    map[nodeCredKey] = cred;
  }
  return map;
}
