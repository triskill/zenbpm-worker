/**
 * n8n adapter — implements IJobExecutor using n8n integration nodes.
 *
 * This adapter requires the optional n8n packages:
 *   n8n-workflow, n8n-core, n8n-nodes-base
 *
 * These packages are distributed under the n8n Sustainable Use License,
 * which permits internal business use and non-commercial distribution.
 * Commercial redistribution requires an n8n Enterprise License.
 * See: https://github.com/n8n-io/n8n/blob/master/LICENSE.md
 */
import { IDataObject } from 'n8n-workflow';
import { IJobExecutor, JobContext, JobResult } from '../../executor';
import { N8nWorkerMapping, WorkerConfig } from '../../config/types';
import { executeNode } from './harness';

export class N8nJobExecutor implements IJobExecutor {
  constructor(
    private readonly mapping: N8nWorkerMapping,
    private readonly config: WorkerConfig,
  ) {}

  async execute(context: JobContext): Promise<JobResult> {
    const outputItems = await executeNode(
      this.mapping,
      this.config,
      context.variables as IDataObject,
    );

    // Merge output items into a single result object.
    // If the node returns multiple items, they are returned as an array under "items".
    if (outputItems.length === 0) return {};
    if (outputItems.length === 1) return outputItems[0] as JobResult;
    return { items: outputItems } as JobResult;
  }

  /**
   * Adapter factory used by the registry.
   *
   * Verifies that the optional n8n packages are installed, constructs the
   * executor, logs the registration message, and returns it.  All n8n-specific
   * concerns are encapsulated here so that registry.ts stays adapter-agnostic.
   */
  static async createExecutor(
    mapping: N8nWorkerMapping,
    config: WorkerConfig,
  ): Promise<IJobExecutor> {
    // Verify that the required n8n packages are installed at this point.
    // The dynamic import is intentional: n8n packages are optional dependencies
    // and their absence should only cause an error when an n8n worker is
    // actually configured, not at startup.
    try {
      await import('n8n-workflow');
    } catch {
      throw new Error(
        `[Worker] Worker "${mapping.jobType}" uses adapter "n8n" but the n8n packages ` +
          `(n8n-workflow, n8n-core, n8n-nodes-base) are not installed.\n` +
          `Install them with: npm install n8n-workflow n8n-core n8n-nodes-base\n` +
          `Note: these packages are distributed under the n8n Sustainable Use License.`,
      );
    }

    const executor = new N8nJobExecutor(mapping, config);
    console.log(
      `[Worker] Registered "${mapping.jobType}" → n8n adapter (${mapping.integration}, action: ${mapping.action})`,
    );
    return executor;
  }
}