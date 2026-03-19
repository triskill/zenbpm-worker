import * as path from 'path';
import { loadConfig } from './config/loader';
import { ZenbpmGrpcClient } from './grpc/client';
import { JobDispatcher } from './worker/dispatcher';
import { buildRegistry } from './worker/registry';

async function main(): Promise<void> {
  const configPath = process.env.CONFIG_PATH ?? path.resolve(process.cwd(), 'config.yaml');

  console.log(`[Worker] Loading config from: ${configPath}`);
  const config = loadConfig(configPath);

  console.log(`[Worker] Connecting to ZenBPM at ${config.zenbpm.address}`);
  const client = new ZenbpmGrpcClient({
    address: config.zenbpm.address,
    clientId: config.zenbpm.clientId,
  });

  const registry = await buildRegistry(config);
  const dispatcher = new JobDispatcher(client, registry);

  await client.connect();
  dispatcher.start();

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[Worker] Received ${signal}, shutting down gracefully...`);
    await client.stop();
    console.log(`[Worker] Active jobs at shutdown: ${dispatcher.activeJobCount}`);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log('[Worker] Ready.');
}

main().catch((err) => {
  console.error('[Worker] Fatal error:', err);
  process.exit(1);
});
