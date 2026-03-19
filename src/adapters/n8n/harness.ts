/**
 * Builds the minimal n8n Workflow + ExecuteContext needed to call
 * node.execute() outside of the full n8n runtime.
 *
 * Only the fields actually used by programmatic nodes are populated;
 * everything else is stubbed with safe no-ops.
 *
 * NOTE: This file imports from n8n-workflow and n8n-core which are
 * distributed under the n8n Sustainable Use License. See NOTICE.md.
 */
import {
  createRunExecutionData,
  IDataObject,
  IExecuteData,
  INode,
  INodeCredentials,
  INodeExecutionData,
  INodeParameters,
  INodeType,
  INodeTypeDescription,
  IRunExecutionData,
  ITaskDataConnections,
  IVersionedNodeType,
  IWorkflowExecuteAdditionalData,
  NodeConnectionTypes,
  Workflow,
  WorkflowExecuteMode,
} from 'n8n-workflow';
import { ExecuteContext } from 'n8n-core';
import { N8nWorkerMapping } from '../../config/types';
import { EnvCredentialsHelper, buildCredentialMap } from './credentials';
import { WorkerConfig } from '../../config/types';

const EXECUTION_MODE: WorkflowExecuteMode = 'integrated';

function buildAdditionalData(
  credentialsHelper: EnvCredentialsHelper,
): IWorkflowExecuteAdditionalData {
  return {
    credentialsHelper,
    executeWorkflow: async () => {
      throw new Error('[n8n/harness] Sub-workflow execution is not supported.');
    },
    getRunExecutionData: async () => undefined,
    executionId: 'zenbpm-job',
    currentNodeExecutionIndex: 0,
    restApiUrl: '',
    instanceBaseUrl: '',
    formWaitingBaseUrl: '',
    webhookBaseUrl: '',
    webhookWaitingBaseUrl: '',
    webhookTestBaseUrl: '',
    variables: {},
    logAiEvent: () => {},
    startRunnerTask: async () => {
      throw new Error('[n8n/harness] Task runner is not supported.');
    },
  } as unknown as IWorkflowExecuteAdditionalData;
}

function buildWorkflow(
  nodeType: INodeType | IVersionedNodeType,
  node: INode,
  mapping: N8nWorkerMapping,
): Workflow {
  return new Workflow({
    id: `zenbpm-${mapping.jobType}`,
    name: mapping.jobType,
    nodes: [node],
    connections: {},
    active: false,
    nodeTypes: {
      getByName(_type: string): INodeType | IVersionedNodeType {
        return nodeType;
      },
      getByNameAndVersion(_type: string, _version?: number): INodeType {
        return nodeType as INodeType;
      },
      getKnownTypes() {
        return {};
      },
    },
    settings: {},
  });
}

function buildNode(mapping: N8nWorkerMapping): INode {
  const credentialsConfig: INodeCredentials = {};
  for (const [nodeCredKey, credName] of Object.entries(mapping.credentials)) {
    credentialsConfig[nodeCredKey] = { id: credName, name: credName };
  }
  return {
    id: `node-${mapping.jobType}`,
    name: mapping.jobType,
    type: mapping.node,
    typeVersion: mapping.nodeVersion,
    position: [0, 0] as [number, number],
    parameters: mapping.parameters as INodeParameters,
    credentials: credentialsConfig,
  };
}

/**
 * Dynamically loads an n8n node class from the installed package.
 * Uses the package's `n8n.nodes` manifest to find the file path.
 */
async function loadNodeType(nodeTypeName: string): Promise<INodeType | IVersionedNodeType> {
  const dotIdx = nodeTypeName.indexOf('.');
  if (dotIdx === -1) {
    throw new Error(
      `[n8n/harness] Invalid node type "${nodeTypeName}". Expected format: "package.NodeName"`,
    );
  }
  const packageName = nodeTypeName.slice(0, dotIdx);
  const nodeName    = nodeTypeName.slice(dotIdx + 1).toLowerCase();

  const pkgJsonPath = require.resolve(`${packageName}/package.json`);
  const pkgJson     = require(pkgJsonPath) as { n8n?: { nodes?: string[] } };
  const nodePaths   = pkgJson.n8n?.nodes ?? [];

  const stemIndex: Record<string, string> = {};
  for (const relPath of nodePaths) {
    const fileName = relPath.split('/').pop() ?? '';
    const stem     = fileName.replace(/\.node\.(js|ts)$/, '').toLowerCase();
    stemIndex[stem] = relPath;
  }

  const relFilePath = stemIndex[nodeName];
  if (!relFilePath) {
    throw new Error(
      `[n8n/harness] Node "${nodeName}" not found in "${packageName}" n8n.nodes manifest. ` +
        `Make sure "${nodeTypeName}" is a valid programmatic node.`,
    );
  }

  const pkgRoot  = pkgJsonPath.slice(0, pkgJsonPath.lastIndexOf('package.json'));
  const fullPath = pkgRoot + relFilePath;
  const module_  = require(fullPath) as Record<string, unknown>;

  const NodeClass = Object.values(module_).find(
    (v) => typeof v === 'function',
  ) as (new () => INodeType | IVersionedNodeType) | undefined;

  if (!NodeClass) {
    throw new Error(
      `[n8n/harness] No exported class found in "${fullPath}". ` +
        `Make sure "${nodeTypeName}" is a valid programmatic node.`,
    );
  }

  return new NodeClass();
}

function resolveVersionedNode(
  node: INodeType | IVersionedNodeType,
  version: number,
): INodeType {
  if ('nodeVersions' in node) {
    const versioned = node as IVersionedNodeType;
    const resolved = versioned.nodeVersions[version] as INodeType | undefined;
    if (!resolved) {
      const available = Object.keys(versioned.nodeVersions).join(', ');
      throw new Error(
        `[n8n/harness] Version ${version} not found for node. Available versions: ${available}`,
      );
    }
    if (!resolved.description) {
      resolved.description = versioned.description as INodeTypeDescription;
    }
    return resolved;
  }
  return node as INodeType;
}

function buildInputData(inputItems: INodeExecutionData[]): ITaskDataConnections {
  return {
    [NodeConnectionTypes.Main]: [inputItems],
  };
}

function buildExecuteData(
  node: INode,
  inputItems: INodeExecutionData[],
): IExecuteData {
  return {
    data: {
      [NodeConnectionTypes.Main]: [inputItems],
    },
    node,
    source: null,
  };
}

// Cache loaded node types to avoid repeated require() calls per job
const nodeTypeCache = new Map<string, INodeType | IVersionedNodeType>();

/**
 * Executes a single n8n node for a given ZenBPM job.
 *
 * @param mapping   - Worker config entry describing which node + params to run
 * @param config    - Full worker config (needed for credential resolution)
 * @param jobVars   - Variables from the ZenBPM WaitingJob (become $json in expressions)
 * @returns         - The first output connector's items as plain JSON objects
 */
export async function executeNode(
  mapping: N8nWorkerMapping,
  config: WorkerConfig,
  jobVars: IDataObject,
): Promise<IDataObject[]> {
  // 1. Load (or retrieve cached) node type
  let rawNodeType = nodeTypeCache.get(mapping.node);
  if (!rawNodeType) {
    rawNodeType = await loadNodeType(mapping.node);
    nodeTypeCache.set(mapping.node, rawNodeType);
  }

  // 2. Resolve versioned node to concrete INodeType
  const resolvedNode = resolveVersionedNode(rawNodeType, mapping.nodeVersion);

  if (!resolvedNode.execute) {
    throw new Error(
      `[n8n/harness] Node "${mapping.node}" v${mapping.nodeVersion} does not have an execute() method. ` +
        `Only programmatic nodes are supported.`,
    );
  }

  // 3. Build node config
  const node = buildNode(mapping);

  // 4. Build credential helper scoped to this worker mapping
  const credentialMap = buildCredentialMap(mapping.credentials, config.credentials);
  const credentialsHelper = new EnvCredentialsHelper(credentialMap);

  // 5. Build workflow and additionalData
  const workflow = buildWorkflow(resolvedNode, node, mapping);
  const additionalData = buildAdditionalData(credentialsHelper);

  // 6. Input: job variables become the single input item's $json
  const inputItems: INodeExecutionData[] = [{ json: jobVars }];
  const runExecutionData: IRunExecutionData = createRunExecutionData();
  const inputData = buildInputData(inputItems);
  const executeData = buildExecuteData(node, inputItems);

  // 7. Construct ExecuteContext and call execute()
  const closeFunctions: Array<() => Promise<void>> = [];
  const context = new ExecuteContext(
    workflow,
    node,
    additionalData,
    EXECUTION_MODE,
    runExecutionData,
    0, // runIndex
    inputItems,
    inputData,
    executeData,
    closeFunctions,
  );

  const result = await resolvedNode.execute.call(context);

  // 8. Run any cleanup handlers registered by the node
  await Promise.all(closeFunctions.map((fn) => fn()));

  // 9. Handle EngineRequest (streaming/sub-runner responses — not applicable here)
  if (!Array.isArray(result)) {
    throw new Error('[n8n/harness] Node returned an EngineRequest; streaming nodes are not supported.');
  }

  if (result.length === 0) return [];
  const firstConnector = result[0];
  if (!firstConnector || firstConnector.length === 0) return [];

  // Normalise: items can be INodeExecutionData or NodeExecutionWithMetadata
  return firstConnector.map((item) => {
    const asData = item as INodeExecutionData;
    if (asData.json !== undefined) return asData.json;
    const asMeta = item as unknown as { data: INodeExecutionData };
    return asMeta.data?.json ?? {};
  });
}
