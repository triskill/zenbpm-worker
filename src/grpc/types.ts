/**
 * TypeScript types for the ZenBPM gRPC protocol.
 * Mirrors zenbpm.proto message definitions.
 */

export interface WaitingJob {
  key: string; // int64 comes as string in JS to avoid precision loss
  instance_key: string;
  variables: Buffer;
  type: string;
  element_id: string;
  created_at: string;
}

export interface ErrorResult {
  code: number;
  message: string;
}

export interface JobStreamResponse {
  error?: ErrorResult;
  job?: WaitingJob;
}

export enum SubscriptionType {
  TYPE_UNDEFINED = 0,
  TYPE_SUBSCRIBE = 1,
  TYPE_UNSUBSCRIBE = 2,
}

export interface StreamSubscriptionRequest {
  job_type: string;
  type: SubscriptionType;
}

export interface JobCompleteRequest {
  key: string;
  variables: Buffer;
}

export interface JobFailRequest {
  key: string;
  message: string;
  error_code: string;
  variables?: Buffer;
}

export interface JobStreamRequest {
  subscription?: StreamSubscriptionRequest;
  complete?: JobCompleteRequest;
  fail?: JobFailRequest;
}
