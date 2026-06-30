'use strict';
const assert = require('assert');
const path = require('path');

process.chdir(path.join(__dirname, '..'));
const fs = require('fs');
if (fs.existsSync('./data')) fs.rmSync('./data', { recursive: true, force: true });
fs.mkdirSync('./data', { recursive: true });
fs.mkdirSync('./data/.backups', { recursive: true });
if (!fs.existsSync('./logs')) fs.mkdirSync('./logs', { recursive: true });

const db = require('../db');
const accountManager = require('../services/accountManager');
const tradingEngine = require('../services/tradingEngine');

// ─── PURE FUNCTION TESTS ──────────────────────────────────────────────────────
function testRoundToStep() {
  assert.strictEqual(tradingEngine.roundToStep(1.23456, 0.001), 1.234);
  assert.strictEqual(tradingEngine.roundToStep(1.23456, 0.01), 1.23);
  assert.strictEqual(tradingEngine.roundToStep(5, 1), 5);
  console.log('  roundToStep() OK');
}

function testComputeQuantitySpot() {
  const { quantity, marginUsed, riskPct } = tradingEngine.computeQuantity({
    marketType: 'spot', available: 1000, entry: 100, sl: 95, grade: 'SNIPER', stepSize: 0.001, minQty: 0,
  });
  assert.strictEqual(riskPct, 0.75);
  assert.ok(Math.abs(quantity - 1.5) < 0.01, 'expected ~1.5 qty, got ' + quantity);
  assert.ok(Math.abs(marginUsed - quantity * 100) < 0.01);
  console.log('  computeQuantity() spot OK:', quantity);
}

function testComputeQuantityFutures() {
  const { quantity, marginUsed, riskPct } = tradingEngine.computeQuantity({
    marketType: 'futures', available: 1000, entry: 100, sl: 95, grade: 'ELITE_SNIPER', leverage: 5, stepSize: 0.001, minQty: 0,
  });
  assert.strictEqual(riskPct, 1.0);
  assert.strictEqual(marginUsed, 10);
  assert.ok(Math.abs(quantity - 0.5) < 0.01, 'expected ~0.5 qty, got ' + quantity);
  console.log('  computeQuantity() futures OK:', quantity);
}

function testComputeQuantityNeverExceedsBalanceOnSpot() {
  const { quantity } = tradingEngine.computeQuantity({
    marketType: 'spot', available: 10, entry: 100, sl: 50, grade: 'ELITE_SNIPER', stepSize: 0.0001, minQty: 0,
  });
  assert.ok(quantity * 100 <= 10 + 1e-6, 'spot notional must never exceed available balance');
  console.log('  computeQuantity() spot balance-cap OK');
}

function testCalcPnlSpotBuy() {
  const { profit, profitPct } = tradingEngine.calcPnl({ marketType: 'spot', side: 'BUY', entry: 100, exit: 110, quantity: 2, leverage: 1 });
  assert.strictEqual(profit, 20);
  assert.strictEqual(profitPct, 10);
  console.log('  calcPnl() spot BUY OK');
}

function testCalcPnlFuturesSell() {
  const { profit, profitPct } = tradingEngine.calcPnl({ marketType: 'futures', side: 'SELL', entry: 100, exit: 90, quantity: 1, leverage: 5 });
  assert.strictEqual(profit, 10);
  assert.strictEqual(profitPct, 50);
  console.log('  calcPnl() futures SELL (5x leverage) OK');
}

// ─── FULL LIFECYCLE INTEGRATION TEST (fake Binance client, no network) ──────
function makeFakeFuturesClient() {
  let price = 100;
  let positionOpen = true;
  return {
    marketType: 'futures', testnet: true,
    getExchangeInfo: async () => ({ symbols: [{ symbol: 'BTCUSDT', filters: [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MIN_NOTIONAL', minNotional: '5' },
    ] }] }),
    getBalance: async () => ({ available: 1000, total: 1000, margin_balance: 1000, unrealized_pnl: 0 }),
    setLeverage: async () => ({ leverage: 5 }),
    placeMarketOrder: async () => ({ orderId: 'order-1' }),
    placeStopOrder: async () => ({ orderId: 'sl-1' }),
    placeTakeProfitOrder: async () => ({ orderId: 'tp-1' }),
    cancelOrder: async () => true,
    getPrice: async () => ({ price: String(price) }),
    getOpenPositions: async () => (positionOpen ? [{ symbol: 'BTCUSDT' }] : []),
    getActualFillPrice: async () => 106,
    __setPrice: (p) => { price = p; },
    __closePositionExternally: () => { positionOpen = false; },
  };
}

async function testFullTradeLifecycle() {
  await db.users.create({ telegram_id: 9001, username: 'trader' });
  await db.accounts.saveAccount(9001, 'testnet_futures', { apiKey: 'k', apiSecret: 's' });
  await accountManager.switchAccount(9001, 'testnet_futures');

  const fakeClient = makeFakeFuturesClient();
  accountManager.getActiveClient   = () => fakeClient;
  accountManager.getClientForType  = () => fakeClient;

  const signal = { symbol: 'BTCUSDT', signal: 'BUY', entry: 100, sl: 95, tp: 115, score: 97, grade: 'ELITE_SNIPER', signal_id: 'sig-1' };
  const user = db.users.findById(9001);
  const openResult = await tradingEngine.openTrade(user, signal);
  assert.strictEqual(openResult.opened, true, JSON.stringify(openResult));
  assert.strictEqual(openResult.trade.status, 'open');
  assert.strictEqual(openResult.trade.sl_order_id, 'sl-1');
  assert.strictEqual(openResult.trade.tp_order_id, 'tp-1');
  console.log('  openTrade() OK — qty:', openResult.trade.quantity, 'margin:', openResult.trade.margin_used);

  // duplicate open attempt must be rejected
  const dupAttempt = await tradingEngine.openTrade(db.users.findById(9001), signal);
  assert.strictEqual(dupAttempt.opened, false);
  assert.strictEqual(dupAttempt.reason, 'ALREADY_OPEN');

  // simulate price moving in favor, then monitor loop should NOT close yet (no SL/TP hit on spot logic; futures relies on position disappearing)
  fakeClient.__setPrice(105);
  await tradingEngine.monitorOpenTrades();
  let trade = db.trades.findById(openResult.trade.trade_id);
  assert.strictEqual(trade.status, 'open');
  assert.ok(trade.profit > 0, 'unrealized profit should be tracked while open');

  // simulate the exchange filling the TP order externally (futures) -> monitor loop should detect & close
  fakeClient.__closePositionExternally();
  await tradingEngine.monitorOpenTrades();
  trade = db.trades.findById(openResult.trade.trade_id);
  assert.strictEqual(trade.status, 'closed');
  assert.strictEqual(trade.result, 'WIN');
  console.log('  monitorOpenTrades() correctly detected externally-filled TP and closed the trade. profit:', trade.profit);

  const updatedUser = db.users.findById(9001);
  assert.strictEqual(updatedUser.wins, 1);
  assert.strictEqual(updatedUser.total_trades, 1);
  assert.strictEqual(updatedUser.active_trades, 0);
  console.log('  user stats correctly updated after trade close:', { wins: updatedUser.wins, net_pnl: updatedUser.net_pnl, win_rate: updatedUser.win_rate });
}

async function testManualClose() {
  await db.users.create({ telegram_id: 9002, username: 'trader2' });
  await db.accounts.saveAccount(9002, 'testnet_futures', { apiKey: 'k', apiSecret: 's' });
  await accountManager.switchAccount(9002, 'testnet_futures');
  const fakeClient = makeFakeFuturesClient();
  accountManager.getActiveClient  = () => fakeClient;
  accountManager.getClientForType = () => fakeClient;

  const signal = { symbol: 'ETHUSDT', signal: 'SELL', entry: 100, sl: 105, tp: 85, score: 92, grade: 'SNIPER', signal_id: 'sig-2' };
  const openResult = await tradingEngine.openTrade(db.users.findById(9002), signal);
  assert.strictEqual(openResult.opened, true);

  fakeClient.__setPrice(96); // price dropped 4% in our favor on a SELL
  const closeResult = await tradingEngine.closeTrade(openResult.trade, 'MANUAL');
  assert.strictEqual(closeResult.closed, true);
  assert.strictEqual(closeResult.result, 'WIN');
  console.log('  closeTrade() manual close OK — profit:', closeResult.profit);
}

(async () => {
  testRoundToStep();
  testComputeQuantitySpot();
  testComputeQuantityFutures();
  testComputeQuantityNeverExceedsBalanceOnSpot();
  testCalcPnlSpotBuy();
  testCalcPnlFuturesSell();
  await testFullTradeLifecycle();
  await testManualClose();
  console.log('\nALL TRADING ENGINE TESTS PASSED');
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
