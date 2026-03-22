/**
 * Test runner: executes all integration test files sequentially, streams their
 * output in real-time, and prints a statistics summary at the end.
 *
 * Usage:
 *   node --require ts-node/register test/run-all.ts
 *   # or via npm:
 *   npm run test:all
 */

import { spawn } from 'child_process';
import * as path from 'path';

// ─── Test suite definitions ───────────────────────────────────────────────────

interface Suite {
  name: string;
  file: string;
}

const SUITES: Suite[] = [
  { name: 'Integration (echo)',   file: 'test/integration.test.ts' },
  { name: 'Advanced (n8n nodes)', file: 'test/advanced.test.ts'    },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

interface Result {
  name:      string;
  passed:    boolean;
  durationMs: number;
}

function runSuite(suite: Suite): Promise<Result> {
  return new Promise((resolve) => {
    const start = Date.now();

    // Print a clear header before streaming the suite's output
    const divider = '─'.repeat(60);
    process.stdout.write(`\n${divider}\n▶  ${suite.name}\n${divider}\n`);

    const child = spawn(
      process.execPath,                       // same node binary
      ['--require', 'ts-node/register', suite.file],
      {
        cwd:   path.resolve(__dirname, '..'),
        env:   process.env,
        stdio: ['ignore', 'pipe', 'pipe'],    // capture but stream immediately
      },
    );

    // Stream stdout/stderr to the terminal in real-time
    child.stdout.on('data', (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      // Suppress noisy ts-node/grpc diagnostics that are not test output
      const line = chunk.toString();
      if (
        line.includes('Received unknown job type') ||
        line.includes('ExperimentalWarning') ||
        line.includes('DeprecationWarning')
      ) return;
      process.stderr.write(chunk);
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - start;
      resolve({ name: suite.name, passed: code === 0, durationMs });
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const results: Result[] = [];

  for (const suite of SUITES) {
    const result = await runSuite(suite);
    results.push(result);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const passed  = results.filter((r) => r.passed).length;
  const failed  = results.filter((r) => !r.passed).length;
  const totalMs = results.reduce((acc, r) => acc + r.durationMs, 0);

  const divider = '═'.repeat(60);
  process.stdout.write(`\n${divider}\n`);
  process.stdout.write(`  TEST RESULTS\n`);
  process.stdout.write(`${divider}\n`);

  const nameWidth = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const badge    = r.passed ? ' PASS ' : ' FAIL ';
    const duration = `${(r.durationMs / 1000).toFixed(1)}s`;
    process.stdout.write(
      `  [${badge}]  ${r.name.padEnd(nameWidth)}  ${duration}\n`,
    );
  }

  process.stdout.write(`${divider}\n`);
  process.stdout.write(
    `  Suites: ${passed} passed, ${failed} failed, ${results.length} total\n`,
  );
  process.stdout.write(`  Time:   ${(totalMs / 1000).toFixed(1)}s\n`);
  process.stdout.write(`${divider}\n\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: Error) => {
  console.error('Runner error:', err.message);
  process.exit(1);
});
