'use strict';
const db = require('../db');
const logger = require('../lib/logger');
const accountManager = require('./accountManager');
const { fmtNum } = require('../lib/utils');
const {
  RISK_ELITE, RISK_SNIPER, DEFAULT_LEVERAGE,
} = require('../config');

// ─── EXCHANGE FILTER CACHE (stepSize / minNotional / minQty) ─────────────────
const filterCache = new Map(); // `${marketType}:${testnet}` -> { ts, bySymbol }
const FILTER_TTL_MS = 6 * 60 * 60 * 1000;

async function getSymbolFilters(client, symbol) {
  const cacheKey = `${client.marketType}:${client.testnet}`;
  let cached = filterCache.get(cacheKey);
  if (!cached || Date.now() - cached.ts > FILTER_TTL_MS) {
    const info = await client.getExchangeInfo();
    const bySymbol = {};
    for (const s of info.symbols || []) {
      const lot  = (s.filters || []).find((f) => f.filterType === 'LOT_SIZE');
      const notl = (s.filters || []).find((f) => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL');
      bySymbol[s.symbol] = {
        stepSize: parseFloat(lot?.stepSize || '0.00000001'),
        minQty:   parseFloat(lot?.minQty   || '0'),
        minNotional: parseFloat(notl?.minNotional || notl?.notional || '0'),
      };
    }
    cached = { ts: Date.now(), bySymbol };
    filterCache.set(cacheKey, cached);
  }
  return cached.bySymbol[symbol] || { stepSize: 0.00000001, minQty: 0, minNotional: 0 };
}

function roundToStep(qty, stepSize) {
  if (!stepSize) return qty;
  const precision = Math.max(0, Math.round(-Math.log10(stepSize)));
  const rounded = Math.floor(qty / stepSize) * stepSize;
  return parseFloat(rounded.toFixed(precision));
}

/**
 * Pure position-sizing function — fully unit-testable without any network.
 * Risk-based sizing: risk a fixed % of available balance on each trade,
 * sized by the distance to stop loss (spot) or by leverage (futures).
 */
function computeQuantity({ marketType, available, entry, sl, grade, leverage = DEFAULT_LEVERAGE, stepSize, minQty }) {
  const riskPct  = grade === 'ELITE_SNIPER' ? RISK_ELITE : RISK_SNIPER;
  const riskAmt  = available * (riskPct / 100);
  let qty;
  let marginUsed;

  if (marketType === 'futures') {
    marginUsed = riskAmt;
    qty = (marginUsed * leverage) / entry;
  } else {
    const slDistance = Math.abs(entry - sl);
    qty = slDistance > 0 ? riskAmt / slDistance : 0;
    // never let the notional exceed the available balance on spot
    const notional = qty * entry;
    if (notional > available) qty = available / entry;
    marginUsed = qty * entry;
  }

  qty = roundToStep(qty, stepSize);
  if (qty < minQty) qty = 0;
  return { quantity: qty, marginUsed, riskPct, riskAmt };
}

function calcPnl({ marketType, side, entry, exit, quantity, leverage = 1 }) {
  const diff = side === 'BUY' ? exit - entry : entry - exit;
  const profit = marketType === 'futures' ? diff * quantity : diff * quantity;
  const denom  = marketType === 'futures' ? (entry * quantity) / leverage : entry * quantity;
  const profitPct = denom > 0 ? (profit / denom) * 100 : 0;
  return { profit, profitPct };
}

function resultFor(profit) {
  if (Math.abs(profit) < 1e-9) return 'BREAKEVEN';
  return profit > 0 ? 'WIN' : 'LOSS';
}

// ─── TRADE LIFECYCLE ───────────────────────────────────────────────────────────
const tradingEngine = {
  computeQuantity,
  calcPnl,
  roundToStep,
  getSymbolFilters,

  /**
   * Opens a new trade on the user's CURRENTLY ACTIVE account. There is
   * intentionally no cap on concurrent open trades — every qualifying
   * sniper signal is actioned immediately, per project requirements.
   */
  async openTrade(user, signal) {
    const userId = user.telegram_id;
    const client = accountManager.getActiveClient(userId);
    if (!client) return { opened: false, reason: 'NO_ACTIVE_ACCOUNT' };

    const accountType = user.active_account_type;
    const { marketType } = accountManager.ACCOUNT_TYPE_META[accountType];

    // never duplicate an already-open position for this exact symbol+side+market
    const existing = db.trades.findOpenBySymbolSide(userId, signal.symbol, signal.signal, marketType);
    if (existing) return { opened: false, reason: 'ALREADY_OPEN' };

    let balance;
    try { balance = await client.getBalance(); }
    catch (err) { await tradingEngine._logApiError(user, accountType, marketType, err); return { opened: false, reason: 'BALANCE_FETCH_FAILED', error: err.message }; }

    if (!balance.available || balance.available <= 0) return { opened: false, reason: 'NO_BALANCE' };

    let filters;
    try { filters = await getSymbolFilters(client, signal.symbol); }
    catch (err) { return { opened: false, reason: 'FILTERS_FETCH_FAILED', error: err.message }; }

    const leverage = marketType === 'futures' ? DEFAULT_LEVERAGE : 1;
    const { quantity, marginUsed, riskPct } = computeQuantity({
      marketType, available: balance.available, entry: signal.entry, sl: signal.sl,
      grade: signal.grade, leverage, stepSize: filters.stepSize, minQty: filters.minQty,
    });

    if (!quantity || quantity <= 0) return { opened: false, reason: 'QTY_TOO_SMALL' };
    if (quantity * signal.entry < filters.minNotional) return { opened: false, reason: 'BELOW_MIN_NOTIONAL' };

    try {
      let orderId, slOrderId = '', tpOrderId = '';

      if (marketType === 'futures') {
        try { await client.setLeverage(signal.symbol, leverage); } catch { /* non-fatal */ }
        const order = await client.placeMarketOrder(signal.symbol, signal.signal, quantity);
        orderId = order.orderId;
        const closeSide = signal.signal === 'BUY' ? 'SELL' : 'BUY';
        try {
          const slOrder = await client.placeStopOrder(signal.symbol, closeSide, quantity, signal.sl);
          slOrderId = slOrder.orderId;
        } catch (err) { logger.warn('[SL-ORDER-FAILED]', { symbol: signal.symbol, err: err.message }); }
        try {
          const tpOrder = await client.placeTakeProfitOrder(signal.symbol, closeSide, quantity, signal.tp);
          tpOrderId = tpOrder.orderId;
        } catch (err) { logger.warn('[TP-ORDER-FAILED]', { symbol: signal.symbol, err: err.message }); }
      } else {
        const order = await client.placeMarketOrder(signal.symbol, signal.signal, quantity);
        orderId = order.orderId;
        // Spot has no native bracket order tied to a market buy — SL/TP are
        // tracked on the trade record and enforced by the monitor loop.
      }

      const trade = await db.trades.create({
        user_id: userId, account_type: accountType, market_type: marketType,
        symbol: signal.symbol, side: signal.signal, entry: signal.entry,
        sl: signal.sl, tp: signal.tp, quantity, leverage, margin_used: marginUsed,
        risk_pct: riskPct, score: signal.score, signal_id: signal.signal_id || '',
        order_id: orderId, sl_order_id: slOrderId, tp_order_id: tpOrderId,
      });

      await db.users.update(userId, {
        total_trades: (user.total_trades || 0) + 1,
        active_trades: (user.active_trades || 0) + 1,
        [marketType === 'futures' ? 'futures_trades' : 'spot_trades']:
          (user[marketType === 'futures' ? 'futures_trades' : 'spot_trades'] || 0) + 1,
      });

      logger.info(`[TRADE-OPENED] user:${userId} ${signal.symbol} ${signal.signal} qty:${quantity} entry:${signal.entry} (${accountType})`);
      return { opened: true, trade };
    } catch (err) {
      await tradingEngine._logApiError(user, accountType, marketType, err);
      logger.error('[TRADE-OPEN-FAILED]', { user: userId, symbol: signal.symbol, err: err.message });
      return { opened: false, reason: 'ORDER_FAILED', error: err.message };
    }
  },

  /** Closes an open trade with a market order on the opposite side, then records the realized result. */
  async closeTrade(trade, reason = 'MANUAL', explicitClosePrice = null) {
    const client = accountManager.getClientForType(trade.user_id, trade.account_type);
    if (!client) return { closed: false, reason: 'NO_CLIENT' };

    const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
    let closePrice = explicitClosePrice;

    try {
      if (trade.market_type === 'futures') {
        for (const id of [trade.sl_order_id, trade.tp_order_id]) {
          if (id) { try { await client.cancelOrder(trade.symbol, id); } catch { /* already filled/cancelled */ } }
        }
      }
      if (!closePrice) {
        try { await client.placeMarketOrder(trade.symbol, closeSide, trade.quantity, 'BOTH'); } catch (err) {
          if (!String(err.message).toLowerCase().includes('reduce')) throw err;
        }
        const priceData = await client.getPrice(trade.symbol);
        closePrice = parseFloat(priceData.price);
      }
    } catch (err) {
      logger.error('[TRADE-CLOSE-FAILED]', { trade: trade.trade_id, err: err.message });
      return { closed: false, reason: 'CLOSE_ORDER_FAILED', error: err.message };
    }

    const { profit, profitPct } = calcPnl({
      marketType: trade.market_type, side: trade.side, entry: trade.entry,
      exit: closePrice, quantity: trade.quantity, leverage: trade.leverage,
    });
    const result = resultFor(profit);

    const updated = await db.trades.update(trade.trade_id, {
      status: 'closed', close_time: new Date().toISOString(), close_reason: reason,
      close_price: closePrice, profit, profit_pct: profitPct, result,
    });

    await tradingEngine._applyResultToUser(trade.user_id, profit, result);
    logger.info(`[TRADE-CLOSED] ${trade.symbol} ${trade.side} ${result} ${fmtNum(profit, 4)} (${reason})`);
    return { closed: true, trade: updated, profit, result };
  },

  async _applyResultToUser(userId, profit, result) {
    const user = db.users.findById(userId);
    if (!user) return;
    await db.users.resetDailyIfNeeded(userId);
    const fresh = db.users.findById(userId);

    const wins   = fresh.wins   + (result === 'WIN' ? 1 : 0);
    const losses = fresh.losses + (result === 'LOSS' ? 1 : 0);
    const totalClosed = wins + losses + fresh.breakeven + (result === 'BREAKEVEN' ? 1 : 0);

    await db.users.update(userId, {
      wins, losses,
      breakeven: fresh.breakeven + (result === 'BREAKEVEN' ? 1 : 0),
      consecutive_wins:   result === 'WIN'  ? fresh.consecutive_wins + 1 : 0,
      consecutive_losses: result === 'LOSS' ? fresh.consecutive_losses + 1 : 0,
      net_pnl:      fresh.net_pnl + profit,
      total_profit: fresh.total_profit + (profit > 0 ? profit : 0),
      total_loss:   fresh.total_loss   + (profit < 0 ? Math.abs(profit) : 0),
      win_rate:     totalClosed > 0 ? parseFloat(((wins / totalClosed) * 100).toFixed(2)) : 0,
      avg_win:      wins   > 0 ? parseFloat(((fresh.total_profit + (profit > 0 ? profit : 0)) / wins).toFixed(4))   : 0,
      avg_loss:     losses > 0 ? parseFloat(((fresh.total_loss   + (profit < 0 ? Math.abs(profit) : 0)) / losses).toFixed(4)) : 0,
      active_trades: Math.max(0, (fresh.active_trades || 0) - 1),
      daily_wins:    fresh.daily_wins   + (result === 'WIN'  ? 1 : 0),
      daily_losses:  fresh.daily_losses + (result === 'LOSS' ? 1 : 0),
    });
  },

  async _logApiError(user, accountType, marketType, err) {
    try {
      await db.apiErrors.log({
        user_id: user.telegram_id, username: user.username, account_type: accountType,
        market_type: marketType, error_message: err.message,
        binance_code: err.binanceCode, binance_msg: err.binanceMsg,
      });
    } catch { /* never let error logging itself throw */ }
  },

  /**
   * Manual trade management — used by the dashboard "Manage Trade" menu.
   */
  async moveStopLoss(trade, newSl) {
    if (trade.market_type !== 'futures') return db.trades.update(trade.trade_id, { sl: newSl });
    const client = accountManager.getClientForType(trade.user_id, trade.account_type);
    if (!client) return null;
    const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
    if (trade.sl_order_id) { try { await client.cancelOrder(trade.symbol, trade.sl_order_id); } catch { /* ignore */ } }
    try {
      const order = await client.placeStopOrder(trade.symbol, closeSide, trade.quantity, newSl);
      return db.trades.update(trade.trade_id, { sl: newSl, sl_order_id: order.orderId });
    } catch (err) {
      logger.warn('[MOVE-SL-FAILED]', { trade: trade.trade_id, err: err.message });
      return db.trades.update(trade.trade_id, { sl: newSl });
    }
  },

  async moveTakeProfit(trade, newTp) {
    if (trade.market_type !== 'futures') return db.trades.update(trade.trade_id, { tp: newTp });
    const client = accountManager.getClientForType(trade.user_id, trade.account_type);
    if (!client) return null;
    const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
    if (trade.tp_order_id) { try { await client.cancelOrder(trade.symbol, trade.tp_order_id); } catch { /* ignore */ } }
    try {
      const order = await client.placeTakeProfitOrder(trade.symbol, closeSide, trade.quantity, newTp);
      return db.trades.update(trade.trade_id, { tp: newTp, tp_order_id: order.orderId });
    } catch (err) {
      logger.warn('[MOVE-TP-FAILED]', { trade: trade.trade_id, err: err.message });
      return db.trades.update(trade.trade_id, { tp: newTp });
    }
  },

  async closePartial(trade, fraction) {
    const client = accountManager.getClientForType(trade.user_id, trade.account_type);
    if (!client) return { closed: false, reason: 'NO_CLIENT' };
    const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
    const qty = trade.quantity * fraction;
    try {
      await client.placeMarketOrder(trade.symbol, closeSide, qty, 'BOTH');
      const priceData = await client.getPrice(trade.symbol);
      const closePrice = parseFloat(priceData.price);
      const { profit } = calcPnl({ marketType: trade.market_type, side: trade.side, entry: trade.entry, exit: closePrice, quantity: qty, leverage: trade.leverage });
      await tradingEngine._applyResultToUser(trade.user_id, profit, resultFor(profit));
      const remaining = trade.quantity - qty;
      if (remaining <= 0) {
        await db.trades.update(trade.trade_id, { status: 'closed', close_time: new Date().toISOString(), close_reason: 'PARTIAL_FULL', close_price: closePrice, profit, result: resultFor(profit) });
      } else {
        await db.trades.update(trade.trade_id, { quantity: remaining });
      }
      return { closed: true, profit, remaining };
    } catch (err) {
      logger.warn('[PARTIAL-CLOSE-FAILED]', { trade: trade.trade_id, err: err.message });
      return { closed: false, reason: 'ORDER_FAILED', error: err.message };
    }
  },

  /**
   * Monitor loop — checks every open trade across every account a user has,
   * updates live PnL, and closes anything that has hit its SL/TP (spot has
   * no native bracket order, so this loop enforces it manually). Runs
   * continuously; a failure on one trade never stops the others.
   */
  async monitorOpenTrades() {
    const openTrades = db.trades.getAll().filter((t) => t.status === 'open');
    for (const trade of openTrades) {
      try { await tradingEngine._monitorOne(trade); }
      catch (err) { logger.error('[MONITOR-ERROR]', { trade: trade.trade_id, err: err.message }); }
    }
  },

  async _monitorOne(trade) {
    const client = accountManager.getClientForType(trade.user_id, trade.account_type);
    if (!client) return; // account disconnected — left open, will resume once reconnected

    let price;
    try {
      const data = await client.getPrice(trade.symbol);
      price = parseFloat(data.price);
    } catch (err) { logger.debug('[MONITOR-PRICE-FAILED]', { symbol: trade.symbol, err: err.message }); return; }

    const { profit, profitPct } = calcPnl({ marketType: trade.market_type, side: trade.side, entry: trade.entry, exit: price, quantity: trade.quantity, leverage: trade.leverage });
    await db.trades.update(trade.trade_id, { current_price: price, profit, profit_pct: profitPct });

    if (trade.market_type === 'futures') {
      // Futures SL/TP are real exchange orders — detect if the position itself disappeared (order filled).
      const positions = await client.getOpenPositions().catch(() => null);
      if (positions !== null) {
        const stillOpen = positions.find((p) => p.symbol === trade.symbol);
        if (!stillOpen) {
          const exitPrice = await tradingEngine._estimateFuturesExit(client, trade) ?? price;
          await tradingEngine.closeTrade(trade, 'SL_TP_FILLED', exitPrice);
        }
      }
      return;
    }

    // Spot: enforce SL/TP manually since there is no bracket order on the buy.
    const hitTp = trade.side === 'BUY' ? price >= trade.tp : price <= trade.tp;
    const hitSl = trade.side === 'BUY' ? price <= trade.sl : price >= trade.sl;
    if (hitTp) await tradingEngine.closeTrade(trade, 'TP_HIT', price);
    else if (hitSl) await tradingEngine.closeTrade(trade, 'SL_HIT', price);
  },

  async _estimateFuturesExit(client, trade) {
    try {
      const closeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
      const exit = await client.getActualFillPrice(trade.symbol, trade.open_time, closeSide);
      return exit;
    } catch { return null; }
  },
};

module.exports = tradingEngine;
