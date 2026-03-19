import type {
  ICredentialDataDecryptedObject,
  ICredentials,
  ICredentialsHelper,
  IExecuteData,
  IHttpRequestOptions,
  INode,
  INodeCredentialsDetails,
  INodeProperties,
  IWorkflowExecuteAdditionalData,
  WorkflowExecuteMode,
} from 'n8n-workflow';
import { Workflow } from 'n8n-workflow';
import { CredentialConfig } from '../../config/types';

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
    _credentials: ICredentialDataDecryptedObject,
    _typeName: string,
    requestOptions: IHttpRequestOptions,
    _workflow: Workflow,
    _node: INode,
  ): Promise<IHttpRequestOptions> {
    // Most programmatic nodes call httpRequestWithAuthentication() which injects
    // auth headers itself based on the credential type. We return options unchanged.
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
