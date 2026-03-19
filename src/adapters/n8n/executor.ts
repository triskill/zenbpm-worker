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
import { N8nWorkerMapping } from '../../config/types';
import { WorkerConfig } from '../../config/types';
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
}
