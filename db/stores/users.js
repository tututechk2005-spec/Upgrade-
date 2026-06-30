'use strict';
const { v4: uuidv4 } = require('uuid');
const { readJSON, writeJSON, withFileLock } = require('../jsonStore');
const { config } = require('../../config');
const { todayUTC } = require('../../lib/utils');

const FILE = config.paths.users;

function defaultUser(data) {
  return {
    telegram_id:          String(data.telegram_id),
    username:             data.username   || '',
    first_name:           data.first_name || '',
    join_date:            new Date().toISOString(),

    // Multi-account pointer — actual credentials live in the accounts store.
    active_account_type:  null,

    subscription:         'inactive',
    plan:                 null,
    subscription_expiry:  null,

    auto_trading:         false,

    total_trades:         0,
    spot_trades:          0,
    futures_trades:       0,
    wins:                 0,
    losses:               0,
    breakeven:            0,
    consecutive_wins:     0,
    consecutive_losses:   0,
    win_rate:             0,
    total_profit:         0,
    total_loss:           0,
    net_pnl:              0,
    avg_win:              0,
    avg_loss:             0,
    active_trades:        0,

    // Daily counters are informational only — there is no auto-pause.
    daily_wins:           0,
    daily_losses:         0,
    daily_reset_date:     todayUTC(),

    banned:               false,

    referral_code:        null,
    referred_by:          null,
    referred_by_code:     null,
    total_referrals:      0,
    referral_earnings:    0,

    today_pnl:            0,
    weekly_pnl:           0,
    monthly_pnl:          0,
  };
}

/** Normalizes a user record loaded from disk — fills in any missing fields
 *  introduced by later versions so old data never breaks the bot. */
function normalize(u) {
  if (!u) return u;
  const base = defaultUser({ telegram_id: u.telegram_id });
  return { ...base, ...u, telegram_id: String(u.telegram_id) };
}

const usersStore = {
  getAll() {
    const all = readJSON(FILE) || [];
    return all.map(normalize);
  },

  findById(id) {
    if (id === undefined || id === null) return null;
    return usersStore.getAll().find((u) => String(u.telegram_id) === String(id)) || null;
  },

  findByUsername(username) {
    if (!username) return null;
    const clean = String(username).replace(/^@/, '').toLowerCase();
    return usersStore.getAll().find((u) => (u.username || '').toLowerCase() === clean) || null;
  },

  async create(data) {
    return withFileLock(FILE, () => {
      const users  = readJSON(FILE) || [];
      const exists = users.find((u) => String(u.telegram_id) === String(data.telegram_id));
      if (exists) return normalize(exists);
      const user = defaultUser(data);
      users.push(user);
      writeJSON(FILE, users);
      return user;
    });
  },

  async update(id, patch) {
    return withFileLock(FILE, () => {
      const users = readJSON(FILE) || [];
      const idx   = users.findIndex((u) => String(u.telegram_id) === String(id));
      if (idx === -1) return null;
      users[idx] = { ...normalize(users[idx]), ...patch };
      writeJSON(FILE, users);
      return users[idx];
    });
  },

  async delete(id) {
    return withFileLock(FILE, () => {
      const users = readJSON(FILE) || [];
      writeJSON(FILE, users.filter((u) => String(u.telegram_id) !== String(id)));
      return true;
    });
  },

  count()        { return usersStore.getAll().length; },
  countPremium()  { return usersStore.getAll().filter((u) => u.subscription === 'active').length; },
  countFree()     { return usersStore.getAll().filter((u) => u.subscription !== 'active').length; },
  countActive()   { return usersStore.getAll().filter((u) => u.auto_trading).length; },
  countBanned()   { return usersStore.getAll().filter((u) => u.banned).length; },

  countActiveToday() {
    const today = todayUTC();
    return usersStore.getAll().filter((u) => u.daily_reset_date === today && (u.daily_wins > 0 || u.daily_losses > 0)).length;
  },

  async resetDailyIfNeeded(id) {
    const user  = usersStore.findById(id);
    if (!user) return;
    const today = todayUTC();
    if (user.daily_reset_date !== today) {
      await usersStore.update(id, { daily_wins: 0, daily_losses: 0, daily_reset_date: today });
    }
  },
};

module.exports = usersStore;
