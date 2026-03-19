import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  JobStreamRequest,
  JobStreamResponse,
  SubscriptionType,
  WaitingJob,
} from './types';

const PROTO_PATH = path.resolve(__dirname, '../../proto/zenbpm.proto');

const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_MULTIPLIER = 2;

export interface ZenbpmClientOptions {
  address: string; // e.g. "localhost:9090"
  clientId: string;
}

export type JobHandler = (job: WaitingJob) => void;

/**
 * Manages a single bidirectional gRPC JobStream connection to ZenBPM.
 * Automatically reconnects on stream error/end.
 * Emits 'job' events for received jobs.
 */
export class ZenbpmGrpcClient extends EventEmitter {
  private readonly address: string;
  private readonly clientId: string;
  private stub: grpc.Client | null = null;
  private stream: grpc.ClientDuplexStream<JobStreamRequest, JobStreamResponse> | null = null;
  private subscriptions = new Set<string>();
  private reconnectDelay = RECONNECT_INITIAL_DELAY_MS;
  private stopping = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private serviceDefinition: any = null;

  constructor(options: ZenbpmClientOptions) {
    super();
    this.address = options.address;
    this.clientId = options.clientId;
  }

  async connect(): Promise<void> {
    const packageDef = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(packageDef) as Record<string, unknown>;
    // The service is in package "grpc"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const grpcPkg = proto['grpc'] as any;
    this.serviceDefinition = grpcPkg['ZenBpm'];
    this._openStream();
  }

  private _openStream(): void {
    if (this.stopping) return;

    this.stub = new this.serviceDefinition(
      this.address,
      grpc.credentials.createInsecure(),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.stream = (this.stub as any).JobStream() as grpc.ClientDuplexStream<
      JobStreamRequest,
      JobStreamResponse
    >;

    this.stream.on('data', (response: JobStreamResponse) => {
      if (response.error && response.error.code !== 0) {
        console.error(
          `[ZenbpmGrpcClient] Server error: code=${response.error.code} message=${response.error.message}`,
        );
        return;
      }
      if (response.job) {
        this.emit('job', response.job);
      }
    });

    this.stream.on('error', (err: Error) => {
      if (!this.stopping) {
        console.error(`[ZenbpmGrpcClient] Stream error: ${err.message}`);
        this._scheduleReconnect();
      }
    });

    this.stream.on('end', () => {
      if (!this.stopping) {
        console.warn('[ZenbpmGrpcClient] Stream ended, reconnecting...');
        this._scheduleReconnect();
      }
    });

    // Re-subscribe to all job types after opening a fresh stream
    for (const jobType of this.subscriptions) {
      this._sendSubscribe(jobType);
    }

    this.reconnectDelay = RECONNECT_INITIAL_DELAY_MS;
    console.log(`[ZenbpmGrpcClient] Connected to ${this.address} (clientId=${this.clientId})`);
  }

  private _scheduleReconnect(): void {
    this.stream = null;
    if (this.stub) {
      this.stub.close();
      this.stub = null;
    }
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * RECONNECT_MULTIPLIER, RECONNECT_MAX_DELAY_MS);
    console.log(`[ZenbpmGrpcClient] Reconnecting in ${delay}ms...`);
    setTimeout(() => this._openStream(), delay);
  }

  subscribe(jobType: string): void {
    this.subscriptions.add(jobType);
    this._sendSubscribe(jobType);
    console.log(`[ZenbpmGrpcClient] Subscribed to job type: ${jobType}`);
  }

  unsubscribe(jobType: string): void {
    this.subscriptions.delete(jobType);
    if (!this.stream) return;
    this.stream.write({
      subscription: { job_type: jobType, type: SubscriptionType.TYPE_UNSUBSCRIBE },
    });
  }

  completeJob(key: string, variables: Record<string, unknown>): void {
    if (!this.stream) {
      console.error(`[ZenbpmGrpcClient] Cannot complete job ${key}: no active stream`);
      return;
    }
    this.stream.write({
      complete: {
        key,
        variables: Buffer.from(JSON.stringify(variables)),
      },
    });
  }

  failJob(key: string, message: string, errorCode = 'WORKER_ERROR'): void {
    if (!this.stream) {
      console.error(`[ZenbpmGrpcClient] Cannot fail job ${key}: no active stream`);
      return;
    }
    this.stream.write({
      fail: {
        key,
        message,
        error_code: errorCode,
      },
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // Gracefully unsubscribe all before closing
    for (const jobType of this.subscriptions) {
      try {
        this.unsubscribe(jobType);
      } catch {
        // best-effort
      }
    }
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    if (this.stub) {
      this.stub.close();
      this.stub = null;
    }
    console.log('[ZenbpmGrpcClient] Stopped.');
  }

  private _sendSubscribe(jobType: string): void {
    if (!this.stream) return;
    this.stream.write({
      subscription: { job_type: jobType, type: SubscriptionType.TYPE_SUBSCRIBE },
    });
  }
}
