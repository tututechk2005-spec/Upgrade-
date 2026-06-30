'use strict';
const { config, validateConfig } = require('./config');
const logger = require('./lib/logger');
const db = require('./db');

// ─── PROCESS-LEVEL SAFETY NETS — the bot must never crash ────────────────────
process.on('uncaughtException', (err) => {
  logger.error('[UNCAUGHT-EXCEPTION]', { err: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('[UNHANDLED-REJECTION]', { reason: reason?.message || String(reason), stack: reason?.stack });
});

async function main() {
  validateConfig();
  logger.info('[STARTUP] Validating configuration... OK');

  const cleanup = await db.cleanOrphansAndDuplicates();
  logger.info('[STARTUP] Database integrity check complete', cleanup);

  const { createBot, launchWithAutoReconnect } = require('./telegram/bot');
  const botInstance = require('./telegram/botInstance');
  const scheduler = require('./scheduler');

  const bot = createBot();
  botInstance.setBot(bot);

  await launchWithAutoReconnect(bot);

  scheduler.start();
  logger.info('[STARTUP] Trading scheduler started — continuous 24/7 sniper scanning active.');

  // ─── OPTIONAL HEALTH ENDPOINT (Render requires an open HTTP port for web services) ──
  try {
    const http = require('http');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    });
    server.listen(config.env.port, () => logger.info(`[STARTUP] Health endpoint listening on port ${config.env.port}`));
  } catch (err) {
    logger.warn('[STARTUP] Health endpoint failed to start (non-fatal)', { err: err.message });
  }

  const shutdown = (signal) => {
    logger.info(`[SHUTDOWN] Received ${signal}, shutting down gracefully...`);
    scheduler.stop();
    try { bot.stop(signal); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 1000);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('[STARTUP] Bot is fully online.');
}

main().catch((err) => {
  logger.error('[FATAL-STARTUP-ERROR]', { err: err.message, stack: err.stack });
  process.exit(1);
});
