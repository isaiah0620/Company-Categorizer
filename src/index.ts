import cron from 'node-cron';
import { config, validateConfig } from './config.js';
import { runPipeline } from './pipeline.js';
import { assertConnection, closePool } from './db.js';
import { closeScrapers } from './scraper.js';
import { closeLlm } from './llm.js';

const runOnce = process.argv.includes('--once');

let running = false;
let shuttingDown = false;

async function safeRun(): Promise<void> {
  if (running) {
    console.warn('[index] Previous run still in progress - skipping this tick.');
    return;
  }
  running = true;
  try {
    await runPipeline();
  } catch (err) {
    console.error('[index] Pipeline run failed:', err);
  } finally {
    running = false;
  }
}

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  closeScrapers();
  closeLlm();
  await closePool().catch(() => undefined);
  process.exit(code);
}

async function main(): Promise<void> {
  validateConfig();
  await assertConnection();

  const model = config.llm.provider === 'openai' ? config.openai.model : config.anthropic.model;
  // Cache TTL is meaningful for Anthropic only; OpenAI's caching is automatic
  // with no TTL knob, so it's just reported as "on" when that provider is active.
  const cacheStatus =
    config.llm.provider === 'openai'
      ? 'on(automatic)'
      : config.anthropic.cacheEnabled
        ? config.anthropic.cacheTtl
        : 'off';

  console.log(
    `[index] provider=${config.llm.provider} model=${model}` +
      ` scraper=${config.scraper.primary}` +
      `${config.scraper.fallback ? ` (fallback: ${config.scraper.fallback})` : ''}` +
      ` name-screen=${
        config.nameScreen.enabled ? `on(min ${config.nameScreen.minConfidence})` : 'off'
      }` +
      ` cache=${cacheStatus}` +
      ` batch=${config.pipeline.batchSize} concurrency=${config.pipeline.concurrency}`
  );

  if (runOnce) {
    await safeRun();
    await shutdown(0);
    return;
  }

  console.log(`[index] Scheduling pipeline with cron "${config.pipeline.scheduleCron}"`);
  cron.schedule(config.pipeline.scheduleCron, () => {
    void safeRun();
  });

  if (config.pipeline.runOnStartup) {
    void safeRun();
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[index] ${signal} received, shutting down...`);
    void shutdown(0);
  });
}

main().catch(async (err) => {
  console.error('[index] Fatal:', err instanceof Error ? err.message : err);
  await shutdown(1);
});
