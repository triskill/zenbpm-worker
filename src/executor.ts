/**
 * Neutral job executor interface for ZenBPM workers.
 *
 * Any adapter (n8n, HTTP, custom) must implement IJobExecutor.
 * The dispatcher does not know or care which adapter is in use.
 */

/**
 * A plain key/value variables object from a ZenBPM WaitingJob.
 */
export type JobVariables = Record<string, unknown>;

/**
 * Output returned by a job executor on success.
 * If the job produces output variables, they are sent back to the engine.
 */
export type JobResult = Record<string, unknown>;

/**
 * Minimal description of a worker mapping passed to the executor.
 * Adapters may extend this with their own typed config.
 */
export interface JobContext {
  /** ZenBPM job type string (e.g. "send-slack-message") */
  jobType: string;
  /** Raw job variables sent by the BPMN engine */
  variables: JobVariables;
}

/**
 * Plugin interface that all job execution adapters must implement.
 *
 * An adapter receives a job context and is responsible for performing
 * the side-effect (HTTP call, database query, etc.) and returning
 * the output variables to be sent back to ZenBPM.
 */
export interface IJobExecutor {
  /**
   * Execute a job and return output variables.
   * Throw an Error to signal job failure — the dispatcher will call failJob().
   */
  execute(context: JobContext): Promise<JobResult>;
}
