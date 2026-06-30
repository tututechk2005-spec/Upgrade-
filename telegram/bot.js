'use strict';
const { Telegraf } = require('telegraf');
const logger = require('../lib/logger');
const db = require('../db');
const { config } = require('../config');

const keyboards = require('./keyboards');
const startHandler = require('./handlers/startHandler');
const dashboardHandler = require('./handlers/dashboardHandler');
const accountHandlers = require('./handlers/accountHandler');
const tradesHandler = require('./handlers/tradesHandler');
const referralHandler = require('./handlers/referralHandler');
const { subscriptionHandler, helpHandler } = require('./handlers/subscriptionHandler');
const adminHandler = require('./handlers/admin/adminHandler');

function createBot() {
  const bot = new Telegraf(config.bot.token);

  // ─── /start (with referral payload support) ──────────────────────────────
  bot.start((ctx) => startHandler.handleStart(ctx));

  bot.command('cancel', async (ctx) => {
    const sessionManager = require('./sessionManager');
    sessionManager.clear(ctx.from.id);
    return ctx.reply('❌ Cancelled.');
  });

  bot.command('setprice', (ctx) => adminHandler.handleSetPriceCommand(ctx));

  // ─── Main navigation ───────────────────────────────────────────────────────
  bot.action('main_menu', (ctx) => startHandler.showMainMenu(ctx));
  bot.action('dashboard', (ctx) => dashboardHandler.show(ctx));
  bot.action('toggle_auto_trading', (ctx) => startHandler.toggleAutoTrading(ctx));
  bot.action('active_trades', (ctx) => tradesHandler.list(ctx));
  bot.action('referral_page', (ctx) => referralHandler.show(ctx));
  bot.action('subscription_page', (ctx) => subscriptionHandler.show(ctx));
  bot.action('help_page', (ctx) => helpHandler.show(ctx));

  // ─── Switch Account flow ───────────────────────────────────────────────────
  bot.action('switch_account', (ctx) => accountHandlers.showSwitchMenu(ctx));
  bot.action('switch_cat_testnet', (ctx) => accountHandlers.showCategory(ctx, 'testnet'));
  bot.action('switch_cat_real', (ctx) => accountHandlers.showCategory(ctx, 'real'));
  bot.action(/^switch_to_(.+)$/, (ctx) => accountHandlers.selectAccountType(ctx, ctx.match[1]));
  bot.action(/^disconnect_prompt_(.+)$/, (ctx) => accountHandlers.confirmDisconnectPrompt(ctx, ctx.match[1]));
  bot.action(/^disconnect_confirm_(.+)$/, (ctx) => accountHandlers.disconnect(ctx, ctx.match[1]));

  // ─── Trades management ─────────────────────────────────────────────────────
  bot.action(/^trade_view_(.+)$/, (ctx) => tradesHandler.view(ctx, ctx.match[1]));
  bot.action(/^trade_be_(.+)$/, (ctx) => tradesHandler.moveToBreakeven(ctx, ctx.match[1]));
  bot.action(/^trade_partial_(.+)$/, (ctx) => tradesHandler.closePartial(ctx, ctx.match[1]));
  bot.action(/^trade_close_(.+)$/, (ctx) => tradesHandler.close(ctx, ctx.match[1]));

  // ─── Subscription plans ────────────────────────────────────────────────────
  bot.action('sub_daily',   (ctx) => subscriptionHandler.selectPlan(ctx, 'daily'));
  bot.action('sub_weekly',  (ctx) => subscriptionHandler.selectPlan(ctx, 'weekly'));
  bot.action('sub_monthly', (ctx) => subscriptionHandler.selectPlan(ctx, 'monthly'));
  bot.action('sub_lifetime',(ctx) => subscriptionHandler.selectPlan(ctx, 'lifetime'));

  // ─── Admin panel ────────────────────────────────────────────────────────────
  bot.action('admin_panel',     (ctx) => adminHandler.panel(ctx));
  bot.action('admin_users',     (ctx) => adminHandler.users(ctx));
  bot.action('admin_revenue',   (ctx) => adminHandler.revenue(ctx));
  bot.action('admin_broadcast', (ctx) => adminHandler.startBroadcast(ctx));
  bot.action('admin_channel',   (ctx) => adminHandler.channelSettings(ctx));
  bot.action('admin_payment',   (ctx) => adminHandler.paymentSettings(ctx));
  bot.action('admin_help',      (ctx) => adminHandler.helpSettings(ctx));
  bot.action('admin_settings',  (ctx) => adminHandler.settings(ctx));
  bot.action('admin_logs',      (ctx) => adminHandler.logs(ctx));

  // ─── Free-text routing (multi-step flows: API keys, broadcast, admin settings) ──
  bot.on('text', async (ctx) => {
    try {
      if (await accountHandlers.handleTextInput(ctx)) return;
      if (await adminHandler.handleTextInput(ctx)) return;
      // No active flow matched — ignore silently (don't spam users with "unknown command").
    } catch (err) {
      logger.error('[TEXT-HANDLER-ERROR]', { err: err.message, user: ctx.from?.id });
      try { await ctx.reply('⚠️ Something went wrong processing that. Please try again.'); } catch { /* ignore */ }
    }
  });

  // ─── Global error handler — bot must never crash on a handler error ────────
  bot.catch((err, ctx) => {
    logger.error('[BOT-ERROR]', { err: err.message, stack: err.stack, update: ctx.updateType, user: ctx.from?.id });
    try { ctx.reply('⚠️ An error occurred. Please try again.'); } catch { /* ignore */ }
  });

  return bot;
}

/**
 * Launches the bot with automatic reconnect on polling failure. Telegraf's
 * launch() resolves once long-polling starts; if the underlying polling
 * loop dies (network blip, Telegram outage), we detect it and relaunch
 * with backoff rather than letting the whole process die.
 */
async function launchWithAutoReconnect(bot) {
  let attempt = 0;
  const maxDelay = 30000;

  async function tryLaunch() {
    try {
      await bot.launch();
      attempt = 0;
      logger.info('[TELEGRAM] Bot launched and polling started.');
    } catch (err) {
      attempt++;
      const delay = Math.min(2000 * 2 ** attempt, maxDelay);
      logger.error('[TELEGRAM-LAUNCH-FAILED] retrying', { err: err.message, attempt, delayMs: delay });
      setTimeout(tryLaunch, delay);
    }
  }

  await tryLaunch();
}

module.exports = { createBot, launchWithAutoReconnect };
