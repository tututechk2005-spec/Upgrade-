'use strict';
const { v4: uuidv4 } = require('uuid');
const { readJSON, writeJSON, withFileLock } = require('../jsonStore');
const { config, SIGNAL_COOLDOWN_MS } = require('../../config');
const { todayUTC } = require('../../lib/utils');
const cooldownStore = require('./cooldown');

const FILE = config.paths.signals;

const signalsStore = {
  getAll()     { return readJSON(FILE) || []; },
  findById(id) { return signalsStore.getAll().find((s) => s.signal_id === id) || null; },

  recent(n = 20) {
    return signalsStore.getAll()
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, n);
  },

  todayCount() {
    return signalsStore.getAll().filter((s) => s.timestamp?.startsWith(todayUTC())).length;
  },

  /** Cooldown is per symbol+market+side only — never blocks unrelated pairs. */
  findActiveDuplicate(symbol, side, marketType, entryPrice) {
    if (cooldownStore.isActive(symbol, marketType, side)) {
      return { duplicate: true, reason: 'COOLDOWN_ACTIVE' };
    }
    const sigs     = signalsStore.getAll();
    const now      = Date.now();
    const cooldown = SIGNAL_COOLDOWN_MS;

    const recentSame = sigs.find((s) => {
      if (s.symbol !== symbol || s.signal !== side || s.market_type !== marketType) return false;
      const age = now - new Date(s.timestamp).getTime();
      if (age >= cooldown) return false;
      if (entryPrice && s.entry) {
        const diff = Math.abs(entryPrice - s.entry) / s.entry;
        if (diff > 0.005) return false;
      }
      return true;
    });
    if (recentSame) return { duplicate: true, reason: 'COOLDOWN_ACTIVE', signal: recentSame };
    return { duplicate: false };
  },

  async create(data) {
    return withFileLock(FILE, async () => {
      const sigs = readJSON(FILE) || [];
      const sig  = {
        signal_id:     uuidv4(),
        market_type:   data.market_type || 'spot',
        symbol:        data.symbol,
        signal:        data.signal,
        entry:         data.entry,
        sl:            data.sl,
        tp:            data.tp,
        rr:            data.rr || '',
        score:         data.score || 0,
        grade:         data.grade || 'SNIPER',
        confirmations: data.confirmations || {},
        atr:           data.atr || 0,
        timestamp:     new Date().toISOString(),
      };
      sigs.push(sig);
      if (sigs.length > 2000) sigs.splice(0, sigs.length - 2000);
      writeJSON(FILE, sigs);
      await cooldownStore.set(data.symbol, data.market_type || 'spot', data.signal);
      return sig;
    });
  },

  count() { return signalsStore.getAll().length; },
};

module.exports = signalsStore;
