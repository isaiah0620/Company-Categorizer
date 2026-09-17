import cron from 'node-cron';
import { config } from './config.js';
import { runPipeline } from './pipeline.js';
import { closePool } from './db.js';

const runOnce = process.argv.includes('--once');

async function safeRun(): Promise<void> {
  try {
    await runPipeline();
  } catch (err) {
    console.error('[index] Pipeline run failed:', err);
  }
}

if (runOnce) {
  safeRun().finally(() => {
    void closePool();
  });
} else {
  console.log(`[index] Scheduling pipeline with cron "${config.pipeline.scheduleCron}"`);
  cron.schedule(config.pipeline.scheduleCron, safeRun);

  if (config.pipeline.runOnStartup) {
    void safeRun();
  }

  process.on('SIGINT', async () => {
    console.log('\n[index] Shutting down...');
    await closePool();
    process.exit(0);
  });
}
