import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../src/config.js';

test('buildConfig applies defaults when env is empty', () => {
  const cfg = buildConfig({});
  assert.equal(cfg.minProfitPercent, 3);
  assert.equal(cfg.maxBetUsdc, 10);
  assert.equal(cfg.daysToClose, 7);
  assert.equal(cfg.mode, 'monitor');
  assert.equal(cfg.scanIntervalSec, 5);
  assert.equal(cfg.feePercent, 2);
  assert.equal(cfg.minLiquidityUsdc, 5000);
  assert.equal(cfg.minVolume24hUsdc, 500);
});

test('buildConfig parses env overrides', () => {
  const cfg = buildConfig({
    MIN_PROFIT_PERCENT: '5',
    MAX_BET_USDC: '25',
    DAYS_TO_CLOSE: '3',
    BOT_MODE: 'monitor',
    SCAN_INTERVAL_SEC: '10',
    MIN_LIQUIDITY_USDC: '10000',
    MIN_VOLUME_24H_USDC: '1000',
    FEE_PERCENT: '1.5',
  });
  assert.equal(cfg.minProfitPercent, 5);
  assert.equal(cfg.maxBetUsdc, 25);
  assert.equal(cfg.daysToClose, 3);
  assert.equal(cfg.scanIntervalSec, 10);
  assert.equal(cfg.minLiquidityUsdc, 10000);
  assert.equal(cfg.minVolume24hUsdc, 1000);
  assert.equal(cfg.feePercent, 1.5);
});

test('buildConfig rejects unknown mode', () => {
  assert.throws(() => buildConfig({ BOT_MODE: 'invalid' }), /BOT_MODE/);
});

test('buildConfig requires wallet key when auto mode is enabled', () => {
  assert.throws(
    () => buildConfig({ BOT_MODE: 'auto' }),
    /WALLET_PRIVATE_KEY/,
  );
});

test('buildConfig accepts auto mode when wallet key is set', () => {
  const cfg = buildConfig({ BOT_MODE: 'auto', WALLET_PRIVATE_KEY: '0xabc' });
  assert.equal(cfg.mode, 'auto');
  assert.equal(cfg.polymarket.walletPrivateKey, '0xabc');
});

test('buildConfig rejects non-numeric strategy values', () => {
  assert.throws(() => buildConfig({ MIN_PROFIT_PERCENT: 'nope' }), /numeric/);
});

test('buildConfig falls back to dotenv values when process env is absent', () => {
  const cfg = buildConfig({}, { MAX_BET_USDC: '42' });
  assert.equal(cfg.maxBetUsdc, 42);
});
