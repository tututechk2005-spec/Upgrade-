'use strict';
const { v4: uuidv4 } = require('uuid');
const { readJSON, writeJSON, withFileLock } = require('../jsonStore');
const { config } = require('../../config');
const { todayUTC } = require('../../lib/utils');

const FILE = config.paths.trades;

const tradesStore = {
  getAll()         { return readJSON(FILE) || []; },
  findById(id)     { return tradesStore.getAll().find((t) => t.trade_id === id) || null; },
  forUser(uid)     { return tradesStore.getAll().filter((t) => String(t.user_id) === String(uid)); },
  openForUser(uid) { return tradesStore.forUser(uid).filter((t) => t.status === 'open'); },

  findOpenImported(userId, symbol, marketType, side) {
    return tradesStore.getAll().find((t) =>
      String(t.user_id) === String(userId) &&
      t.symbol === symbol && t.market_type === marketType &&
      t.side === side && t.status === 'open' && t.imported === true
    ) || null;
  },

  findOpenBySymbolSide(userId, symbol, side, marketType) {
    return tradesStore.getAll().find((t) =>
      String(t.user_id) === String(userId) &&
      t.symbol === symbol && t.side === side && t.status === 'open' &&
      (!marketType || t.market_type === marketType)
    ) || null;
  },

  findOpenBySymbol(userId, symbol, marketType) {
    return tradesStore.getAll().find((t) =>
      String(t.user_id) === String(userId) &&
      t.symbol === symbol && t.market_type === marketType && t.status === 'open'
    ) || null;
  },

  findDuplicates() {
    const all  = tradesStore.getAll().filter((t) => t.status === 'open');
    const seen = new Map();
    const dups = [];
    for (const t of all) {
      const key = `${t.user_id}:${t.symbol}:${t.side}:${t.market_type}`;
      if (seen.has(key)) dups.push(t);
      else seen.set(key, t);
    }
    return dups;
  },

  countBreakeven(uid) {
    const trades = uid ? tradesStore.forUser(uid) : tradesStore.getAll();
    return trades.filter((t) => t.status === 'closed' && t.result === 'BREAKEVEN').length;
  },

  async create(data) {
    return withFileLock(FILE, () => {
      const trades = readJSON(FILE) || [];

      const dupIdx = trades.findIndex((t) =>
        String(t.user_id) === String(data.user_id) &&
        t.symbol === data.symbol &&
        t.side   === data.side &&
        t.market_type === (data.market_type || 'spot') &&
        t.status === 'open'
      );
      if (dupIdx !== -1) return trades[dupIdx];

      const trade = {
        trade_id:          uuidv4(),
        user_id:           String(data.user_id),
        account_type:      data.account_type || null,
        market_type:       data.market_type || 'spot',
        symbol:            data.symbol,
        side:              data.side,
        entry:             data.entry,
        sl:                data.sl    || null,
        tp:                data.tp    || null,
        quantity:          data.quantity || 0,
        leverage:          data.leverage || 1,
        margin_used:       data.margin_used || 0,
        risk_pct:          data.risk_pct || 1,
        score:             data.score || 0,
        signal_id:         data.signal_id || '',
        order_id:          String(data.order_id || ''),
        sl_order_id:       String(data.sl_order_id || ''),
        tp_order_id:       String(data.tp_order_id || ''),
        status:            'open',
        imported:          data.imported || false,
        profit:            0,
        profit_pct:        0,
        result:            null,
        current_price:     data.current_price || data.entry,
        liquidation_price: data.liquidation_price || null,
        open_time:         data.open_time || new Date().toISOString(),
        close_time:        null,
        close_reason:      null,
        close_price:       null,
        notified:          false,
        user_message_ids:  data.user_message_ids || {},
      };
      trades.push(trade);
      writeJSON(FILE, trades);
      return trade;
    });
  },

  async update(id, patch) {
    return withFileLock(FILE, () => {
      const trades = readJSON(FILE) || [];
      const idx    = trades.findIndex((t) => t.trade_id === id);
      if (idx === -1) return null;
      trades[idx] = { ...trades[idx], ...patch };
      writeJSON(FILE, trades);
      return trades[idx];
    });
  },

  async upsertImported(data) {
    return withFileLock(FILE, () => {
      const trades = readJSON(FILE) || [];
      const idx = trades.findIndex((t) =>
        String(t.user_id) === String(data.user_id) &&
        t.symbol === data.symbol && t.market_type === data.market_type &&
        t.side === data.side && t.status === 'open'
      );
      if (idx !== -1) {
        trades[idx] = {
          ...trades[idx],
          current_price:     data.current_price     ?? trades[idx].current_price,
          profit:            data.profit            ?? trades[idx].profit,
          profit_pct:        data.profit_pct        ?? trades[idx].profit_pct,
          quantity:          data.quantity          ?? trades[idx].quantity,
          leverage:          data.leverage          ?? trades[idx].leverage,
          sl:                data.sl                ?? trades[idx].sl,
          tp:                data.tp                ?? trades[idx].tp,
          liquidation_price: data.liquidation_price ?? trades[idx].liquidation_price,
          margin_used:       data.margin_used       ?? trades[idx].margin_used,
          imported:          trades[idx].imported,
        };
        writeJSON(FILE, trades);
        return { trade: trades[idx], created: false };
      }
      const trade = {
        trade_id:          uuidv4(),
        user_id:           String(data.user_id),
        account_type:      data.account_type || null,
        market_type:       data.market_type || 'futures',
        symbol:            data.symbol,
        side:              data.side,
        entry:             data.entry,
        sl:                data.sl || null,
        tp:                data.tp || null,
        quantity:          data.quantity || 0,
        leverage:          data.leverage || 1,
        margin_used:       data.margin_used || 0,
        risk_pct:          data.risk_pct || 0,
        score:             0,
        signal_id:         '',
        order_id:          String(data.order_id || ''),
        sl_order_id:       String(data.sl_order_id || ''),
        tp_order_id:       String(data.tp_order_id || ''),
        status:            'open',
        imported:          true,
        profit:            data.profit || 0,
        profit_pct:        data.profit_pct || 0,
        result:            null,
        current_price:     data.current_price || data.entry,
        liquidation_price: data.liquidation_price || null,
        open_time:         data.open_time || new Date().toISOString(),
        close_time:        null,
        close_reason:      null,
        close_price:       null,
        notified:          false,
        user_message_ids:  {},
      };
      trades.push(trade);
      writeJSON(FILE, trades);
      return { trade, created: true };
    });
  },

  count()       { return tradesStore.getAll().length; },
  countOpen()   { return tradesStore.getAll().filter((t) => t.status === 'open').length; },

  _statsSince(predicate) {
    const closed = tradesStore.getAll().filter((t) => t.status === 'closed' && predicate(t));
    return {
      total:     closed.length,
      wins:      closed.filter((t) => t.result === 'WIN').length,
      losses:    closed.filter((t) => t.result === 'LOSS').length,
      breakeven: closed.filter((t) => t.result === 'BREAKEVEN').length,
      pnl:       closed.reduce((s, t) => s + (t.profit || 0), 0),
    };
  },

  todayStats() {
    const today = todayUTC();
    return tradesStore._statsSince((t) => t.close_time?.startsWith(today));
  },
  weekStats() {
    const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return tradesStore._statsSince((t) => t.close_time >= week);
  },
  monthStats() {
    const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    return tradesStore._statsSince((t) => t.close_time >= month);
  },

  todayStatsForUser(uid) {
    const today = todayUTC();
    return tradesStore._statsSince((t) => String(t.user_id) === String(uid) && t.close_time?.startsWith(today));
  },
  monthStatsForUser(uid) {
    const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    return tradesStore._statsSince((t) => String(t.user_id) === String(uid) && t.close_time >= month);
  },

  totalProfit() {
    return tradesStore.getAll().reduce((s, t) => s + (t.profit || 0), 0).toFixed(4);
  },
};

module.exports = tradesStore;
