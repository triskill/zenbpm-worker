import { IJobExecutor } from '../executor';
import { WorkerMapping, WorkerConfig } from '../config/types';
import { HttpJobExecutor } from '../adapters/http/executor';
import { ExecutorRegistry } from './dispatcher';

/**
 * Builds an ExecutorRegistry from the loaded config.
 * Each worker mapping is resolved to the appropriate IJobExecutor implementation.
 *
 * n8n packages are loaded dynamically so that their absence only causes an
 * error when an n8n worker mapping is actually configured, not at startup.
 */
export async function buildRegistry(config: WorkerConfig): Promise<ExecutorRegistry> {
  const registry: ExecutorRegistry = new Map();

  // Check if n8n packages are available (they are optional dependencies)
  let N8nJobExecutor: (new (mapping: WorkerMapping & { adapter: 'n8n' }, config: WorkerConfig) => IJobExecutor) | null = null;
  try {
    const mod = await import('../adapters/n8n/executor');
    N8nJobExecutor = mod.N8nJobExecutor;
  } catch {
    // n8n packages not installed — n8n adapter will be unavailable
  }

  for (const mapping of config.workers) {
    let executor: IJobExecutor;

    switch (mapping.adapter) {
      case 'n8n': {
        if (!N8nJobExecutor) {
          throw new Error(
            `[Worker] Worker "${mapping.jobType}" uses adapter "n8n" but the n8n packages ` +
              `(n8n-workflow, n8n-core, n8n-nodes-base) are not installed.\n` +
              `Install them with: npm install n8n-workflow n8n-core n8n-nodes-base\n` +
              `Note: these packages are distributed under the n8n Sustainable Use License.`,
          );
        }
        executor = new N8nJobExecutor(mapping, config);
        console.log(`[Worker] Registered "${mapping.jobType}" → n8n adapter (${mapping.node} v${mapping.nodeVersion})`);
        break;
      }

      case 'http': {
        const credential = mapping.credential
          ? config.credentials[mapping.credential]
          : undefined;

        if (mapping.credential && !credential) {
          throw new Error(
            `[Worker] Worker "${mapping.jobType}" references credential "${mapping.credential}" ` +
              `which is not defined in the credentials section.`,
          );
        }

        executor = new HttpJobExecutor(mapping, credential);
        console.log(`[Worker] Registered "${mapping.jobType}" → http adapter (${mapping.method} ${mapping.url})`);
        break;
      }

      default: {
        // TypeScript exhaustiveness guard
        const _exhaustive: never = mapping;
        throw new Error(
          `[Worker] Unknown adapter "${(mapping as WorkerMapping & { adapter: string }).adapter}" ` +
            `for job type "${(mapping as WorkerMapping & { jobType: string }).jobType}".`,
        );
      }
    }

    registry.set(mapping.jobType, executor);
  }

  return registry;
}
