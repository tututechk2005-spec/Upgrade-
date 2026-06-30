'use strict';
const db = require('../db');
const logger = require('../lib/logger');
const signalEngine = require('../services/signalEngine');
const tradingEngine = require('../services/tradingEngine');
const accountManager = require('../services/accountManager');
const { publicSpot, publicFutures } = require('../services/binanceService');
const {
  SCAN_INTERVAL_SEC, MONITOR_INTERVAL_MS, MIN_SPOT_VOLUME, MIN_FUTURES_VOLUME,
  ACCOUNT_TYPE_META,
} = require('../config');

let scanTimer = null;
let monitorTimer = null;
let running = false;

/** Fetches 4h/1h/15m candles for one symbol on one market, tolerating partial failures. */
async function fetchCandleSet(client, symbol) {
  const [c4h, c1h, c15m] = await Promise.all([
    client.getKlines(symbol, '4h', 100),
    client.getKlines(symbol, '1h', 230),
    client.getKlines(symbol, '15m', 100),
  ]);
  return {
    candles4h: signalEngine.parseKlines(c4h),
    candles1h: signalEngine.parseKlines(c1h),
    candles15m: signalEngine.parseKlines(c15m),
  };
}

/** Scans one market (spot or futures) across its top active pairs for sniper signals. */
async function scanMarket(client, marketType) {
  const minVolume = marketType === 'futures' ? MIN_FUTURES_VOLUME : MIN_SPOT_VOLUME;
  let pairs;
  try { pairs = await client.getActivePairs(minVolume); }
  catch (err) { logger.error(`[SCAN-ERROR] ${marketType} getActivePairs failed`, { err: err.message }); return []; }

  const found = [];
  for (const pair of pairs) {
    try {
      const candles = await fetchCandleSet(client, pair.symbol);
      const result = signalEngine.analyze(pair.symbol, marketType, candles);
      if (result?.tradable) {
        const dup = db.signals.findActiveDuplicate(pair.symbol, result.signal, marketType, result.entry);
        if (dup.duplicate) continue;
        await db.signals.create({ ...result, market_type: marketType });
        found.push({ ...result, market_type: marketType });
        logger.info(`[SNIPER-SIGNAL] ${result.grade} ${pair.symbol} ${result.signal} score:${result.score} (${marketType})`);
      }
    } catch (err) {
      // one symbol failing must never stop the scan of the rest
      logger.debug(`[SCAN-SYMBOL-ERROR] ${pair.symbol}`, { err: err.message });
    }
  }
  return found;
}

/** Opens trades for all eligible users with auto-trading enabled, for every fresh signal found. */
async function actionSignalsForUsers(signals) {
  if (!signals.length) return;
  const users = db.users.getAll().filter((u) => u.auto_trading && u.active_account_type && !u.banned);

  for (const signal of signals) {
    for (const user of users) {
      const userMeta = ACCOUNT_TYPE_META[user.active_account_type];
      if (!userMeta || userMeta.marketType !== signal.market_type) continue; // only trade the market type the user is actively connected to
      try {
        const result = await tradingEngine.openTrade(user, signal);
        if (result.opened) {
          try {
            await require('../telegram/botInstance').notifyUser(user.telegram_id,
              `🎯 *${signal.grade.replace('_', ' ')}* signal executed!\n\n${signal.symbol} ${signal.signal}\nEntry: ${signal.entry}\nSL: ${signal.sl}\nTP: ${signal.tp}\nScore: ${signal.score}/100`);
          } catch { /* notification best-effort only */ }
        }
      } catch (err) {
        logger.error('[AUTO-TRADE-ERROR]', { user: user.telegram_id, symbol: signal.symbol, err: err.message });
      }
    }
  }
}

async function runScanCycle() {
  if (running) return; // never overlap scans
  running = true;
  try {
    const [spotSignals, futuresSignals] = await Promise.all([
      scanMarket(publicSpot, 'spot'),
      scanMarket(publicFutures, 'futures'),
    ]);
    await actionSignalsForUsers([...spotSignals, ...futuresSignals]);
  } catch (err) {
    logger.error('[SCAN-CYCLE-ERROR]', { err: err.message });
  } finally {
    running = false;
  }
}

async function runMonitorCycle() {
  try { await tradingEngine.monitorOpenTrades(); }
  catch (err) { logger.error('[MONITOR-CYCLE-ERROR]', { err: err.message }); }
}

const scheduler = {
  /** Starts the 24/7 scanning + monitoring loops. Never stops scanning by design. */
  start() {
    if (scanTimer) return; // already running
    logger.info(`[SCHEDULER] Starting continuous scan loop (every ${SCAN_INTERVAL_SEC}s) — sniper-only, no trade limit.`);
    scanTimer = setInterval(runScanCycle, SCAN_INTERVAL_SEC * 1000);
    monitorTimer = setInterval(runMonitorCycle, MONITOR_INTERVAL_MS);
    // run once immediately so the bot doesn't sit idle for the first interval
    runScanCycle();
    runMonitorCycle();
  },

  stop() {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  },
};

module.exports = scheduler;
