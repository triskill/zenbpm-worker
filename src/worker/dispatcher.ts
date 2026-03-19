import { ZenbpmGrpcClient } from '../grpc/client';
import { WaitingJob } from '../grpc/types';
import { IJobExecutor, JobVariables } from '../executor';

/**
 * Maps a ZenBPM job type string to an IJobExecutor instance.
 * Built once at startup from the resolved adapter registry.
 */
export type ExecutorRegistry = Map<string, IJobExecutor>;

/**
 * JobDispatcher subscribes to all configured job types and dispatches
 * incoming jobs to the appropriate executor adapter.
 *
 * Jobs are executed in parallel — each received job spawns an independent
 * promise. There is no artificial concurrency limit; rely on the ZenBPM
 * engine's own max_active_jobs settings if throttling is needed.
 */
export class JobDispatcher {
  private activeJobs = 0;

  constructor(
    private readonly client: ZenbpmGrpcClient,
    private readonly registry: ExecutorRegistry,
  ) {}

  start(): void {
    // Subscribe to all job types in the registry
    for (const jobType of this.registry.keys()) {
      this.client.subscribe(jobType);
    }

    // Handle incoming jobs
    this.client.on('job', (job: WaitingJob) => {
      this._handleJob(job);
    });

    const jobTypes = [...this.registry.keys()].join(', ');
    console.log(`[Dispatcher] Listening for ${this.registry.size} job type(s): ${jobTypes}`);
  }

  private _handleJob(job: WaitingJob): void {
    const executor = this.registry.get(job.type);
    if (!executor) {
      console.warn(`[Dispatcher] Received unknown job type "${job.type}", failing.`);
      this.client.failJob(job.key, `No handler registered for job type "${job.type}"`, 'NO_HANDLER');
      return;
    }

    this.activeJobs++;
    this._executeJob(job, executor)
      .catch((err: Error) => {
        // Safety net — _executeJob already catches errors internally.
        console.error(`[Dispatcher] Unexpected error handling job ${job.key}:`, err);
      })
      .finally(() => {
        this.activeJobs--;
      });
  }

  private async _executeJob(job: WaitingJob, executor: IJobExecutor): Promise<void> {
    const variables = this._parseVariables(job);

    console.log(
      `[Dispatcher] Starting job key=${job.key} type=${job.type} instanceKey=${job.instance_key}`,
    );

    try {
      const result = await executor.execute({ jobType: job.type, variables });

      this.client.completeJob(job.key, result);
      console.log(`[Dispatcher] Completed job key=${job.key} type=${job.type}`);
    } catch (err) {
      const error = err as Error;
      const message = error.message ?? String(err);
      const errorCode = (error.constructor?.name ?? 'WORKER_ERROR')
        .toUpperCase()
        .replace(/\s+/g, '_');

      console.error(`[Dispatcher] Failed job key=${job.key} type=${job.type}: ${message}`);
      this.client.failJob(job.key, message, errorCode);
    }
  }

  private _parseVariables(job: WaitingJob): JobVariables {
    if (!job.variables || job.variables.length === 0) return {};
    try {
      return JSON.parse(job.variables.toString('utf-8')) as JobVariables;
    } catch {
      console.warn(`[Dispatcher] Could not parse variables for job ${job.key}, using empty object.`);
      return {};
    }
  }

  get activeJobCount(): number {
    return this.activeJobs;
  }
}
