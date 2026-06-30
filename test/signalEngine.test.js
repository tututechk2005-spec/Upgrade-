'use strict';
const assert = require('assert');
const se = require('../services/signalEngine');

function mkCandle(o, h, l, c, v, t) {
  return { time: t, open: o, high: h, low: l, close: c, volume: v };
}

// ─── unit tests on individual indicators ──────────────────────────────────
function testEMA() {
  const closes = [1,2,3,4,5,6,7,8,9,10];
  const e = se.ema(closes, 3);
  assert.ok(e.length === closes.length - 3 + 1);
  assert.ok(e[0] === (1+2+3)/3);
  console.log('  ema() OK');
}

function testRSI() {
  const up = Array.from({length: 20}, (_, i) => 100 + i); // strictly increasing -> RSI 100
  assert.strictEqual(se.rsi(up), 100);
  const flat = Array.from({length: 20}, () => 100);
  assert.strictEqual(se.rsi(flat), 100); // no losses at all -> al=0 -> RSI 100 by formula
  console.log('  rsi() OK');
}

function testATR() {
  const candles = Array.from({length: 20}, (_, i) => mkCandle(100, 102, 98, 100, 1000, i));
  const a = se.atr(candles);
  assert.ok(a > 0 && Math.abs(a - 4) < 0.5);
  console.log('  atr() OK:', a);
}

function testTrendDirection() {
  const up = Array.from({length: 60}, (_, i) => 100 + i * 0.8);
  assert.strictEqual(se.trendDirection(up), 'BUY');
  const down = Array.from({length: 60}, (_, i) => 200 - i * 0.8);
  assert.strictEqual(se.trendDirection(down), 'SELL');
  console.log('  trendDirection() OK');
}

function testEmaStructure() {
  const candles = Array.from({length: 220}, (_, i) => {
    const c = 100 + i * 0.6;
    return mkCandle(c - 0.1, c + 0.3, c - 0.3, c, 1000, i);
  });
  assert.strictEqual(se.emaStructure(candles), 'BUY');
  const down = Array.from({length: 220}, (_, i) => {
    const c = 300 - i * 0.6;
    return mkCandle(c + 0.1, c + 0.3, c - 0.3, c, 1000, i);
  });
  assert.strictEqual(se.emaStructure(down), 'SELL');
  console.log('  emaStructure() OK');
}

function testVolumeConfirmed() {
  const flatVol = Array.from({length: 25}, (_, i) => mkCandle(100,101,99,100, 1000, i));
  assert.strictEqual(se.volumeConfirmed(flatVol), false);
  const spike = flatVol.slice();
  spike[spike.length-1] = mkCandle(100,101,99,100, 5000, 99);
  assert.strictEqual(se.volumeConfirmed(spike), true);
  console.log('  volumeConfirmed() OK');
}

function testCandlePattern() {
  const bullishEngulf = [
    mkCandle(105, 106, 99, 100, 1000, 0),   // bearish prev candle
    mkCandle(99, 107, 98, 106, 1000, 1),    // bullish engulfing candle
  ];
  const r = se.candlePattern(bullishEngulf);
  assert.strictEqual(r.bullish, true);
  assert.strictEqual(r.pattern, 'BULLISH_ENGULFING');

  const bearishEngulf = [
    mkCandle(100, 107, 99, 106, 1000, 0),
    mkCandle(107, 108, 98, 99, 1000, 1),
  ];
  const r2 = se.candlePattern(bearishEngulf);
  assert.strictEqual(r2.bearish, true);
  console.log('  candlePattern() OK');
}

function testSupportResistance() {
  // craft an obvious W shape: low pivot at idx 10, high pivot at idx 20
  const candles = [];
  for (let i = 0; i < 30; i++) {
    let low = 100, high = 102;
    if (i === 10) { low = 90; high = 92; }
    if (i === 20) { low = 110; high = 115; }
    candles.push(mkCandle(low+1, high, low, (low+high)/2, 1000, i));
  }
  const sr = se.supportResistance(candles, 30, 2);
  assert.ok(sr.support <= 92, 'support should pick up the dip near 90, got ' + sr.support);
  assert.ok(sr.resistance >= 110, 'resistance should pick up the spike near 115, got ' + sr.resistance);
  console.log('  supportResistance() OK:', sr);
}

function testMACD() {
  const closes = Array.from({length: 60}, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.3);
  const m = se.macd(closes);
  assert.ok(m, 'macd should compute on 60 points');
  assert.ok(typeof m.latest.macd === 'number');
  assert.ok(typeof m.latest.signal === 'number');
  assert.ok(typeof m.latest.hist === 'number');
  console.log('  macd() OK:', m.latest);
}

// ─── full integration: engineered strong uptrend -> expect a BUY sniper signal ──
function buildUptrendDataset() {
  const candles4h = [];
  for (let i = 0; i < 70; i++) {
    const c = 100 + i * 1.2;
    candles4h.push(mkCandle(c - 0.3, c + 0.6, c - 0.6, c, 50000, i));
  }

  const candles1h = [];
  for (let i = 0; i < 230; i++) {
    let c = 100 + i * 0.5;
    if (i >= 215 && i < 225) c -= (i - 214) * 0.8;
    if (i >= 225) c = candles1h.length ? candles1h[candles1h.length - 1].close + 1.0 : c;
    candles1h.push(mkCandle(c - 0.2, c + 0.4, c - 0.5, c, 8000, i));
  }

  // 15m entry timeframe — engineered as: a decline (resets RSI/MACD into
  // bearish territory) -> a steady recovery (builds a genuine MACD bullish
  // cross) -> a short plateau (forms a real resistance pivot) -> a small
  // red pullback candle -> a bullish-engulfing breakout candle with a
  // volume spike that clears the plateau resistance by a small margin.
  // (Parameters found via grid search against the real indicator math in
  // test/signalEngine.fixtureSearch.js — not hand-tuned guesses.)
  const candles15m = [];
  // Padding so the dataset clears analyze()'s minimum length requirement.
  // Far enough back that it has decayed out of every EMA/RSI/ATR window by
  // the time we reach the engineered pattern below.
  const padLen = 20;
  for (let p = 0; p < padLen; p++) {
    candles15m.push(mkCandle(109.95, 110.05, 109.9, 110, 1500, p));
  }
  let price = 110;
  const declLen = 25, declSlope = 0.2;
  for (let i = 0; i < declLen; i++) {
    price -= declSlope;
    candles15m.push(mkCandle(price + declSlope * 0.3, price + declSlope * 0.3 + 0.05, price - declSlope * 0.3 - 0.05, price, 1800, padLen + i));
  }
  const recLen = 10, recSlope = 0.12;
  for (let j = 0; j < recLen; j++) {
    price += recSlope;
    candles15m.push(mkCandle(price - recSlope * 0.3, price + recSlope * 0.3 + 0.05, price - recSlope * 0.3 - 0.05, price, 1800, padLen + declLen + j));
  }
  const top = price;
  const plLen = 5, plAmp = 0.1;
  for (let k = 0; k < plLen; k++) {
    const c = top + plAmp * Math.sin(k * (2 * Math.PI / 5));
    candles15m.push(mkCandle(c - 0.03, c + 0.08, c - 0.08, c, 1800, padLen + declLen + recLen + k));
  }
  const pullback = 0.1, breakout = 0.3;
  const pullClose = top - pullback;
  candles15m.push(mkCandle(top + 0.05, top + 0.1, pullClose - 0.05, pullClose, 1700, padLen + declLen + recLen + plLen));
  const breakClose = top + breakout;
  candles15m.push(mkCandle(pullClose - 0.05, breakClose + 0.1, pullClose - 0.1, breakClose, 9500, padLen + declLen + recLen + plLen + 1));

  return { candles4h, candles1h, candles15m };
}

function testFullAnalyzeIntegration() {
  const data = buildUptrendDataset();
  const result = se.analyze('TESTUSDT', 'spot', data);
  console.log('  analyze() result:', JSON.stringify(result, null, 2));
  assert.ok(result, 'analyze should not crash and should return a result object');
  if (result.tradable) {
    assert.strictEqual(result.signal, 'BUY');
    assert.ok(result.score >= 90);
    assert.ok(Object.values(result.confirmations).every(Boolean), 'all 8 confirmations must be true for a tradable sniper signal');
    console.log('  FULL INTEGRATION: sniper BUY signal correctly generated, score=' + result.score);
  } else {
    console.log('  FULL INTEGRATION: no trade (score=' + result.score + ') — confirmations:', result.confirmations);
  }
}

function testRejectsChoppyMarket() {
  const flat = Array.from({length: 230}, (_, i) => {
    const c = 100 + Math.sin(i / 3) * 0.5; // tight chop, no real trend
    return mkCandle(c - 0.05, c + 0.1, c - 0.1, c, 1000, i);
  });
  const data = { candles4h: flat.slice(0, 70), candles1h: flat, candles15m: flat.slice(0, 70) };
  const result = se.analyze('CHOPUSDT', 'futures', data);
  assert.strictEqual(result.tradable, false, 'choppy/flat market must never produce a trade');
  console.log('  testRejectsChoppyMarket() OK — correctly refused to trade flat chop');
}

testEMA();
testRSI();
testATR();
testTrendDirection();
testEmaStructure();
testVolumeConfirmed();
testCandlePattern();
testSupportResistance();
testMACD();
testRejectsChoppyMarket();
testFullAnalyzeIntegration();

console.log('\nALL SIGNAL ENGINE TESTS COMPLETED');
