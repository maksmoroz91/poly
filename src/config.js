import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadDotEnv(path = resolve(process.cwd(), '.env')) {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, 'utf8');
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function num(value, fallback, { min, max } = {}) {
  if (value === undefined || value === '' || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Expected numeric value, got: ${value}`);
  }
  if (min !== undefined && n < min) throw new Error(`Value ${n} below min ${min}`);
  if (max !== undefined && n > max) throw new Error(`Value ${n} above max ${max}`);
  return n;
}

function str(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const s = String(value).trim();
  return s === '' ? fallback : s;
}

const VALID_MODES = new Set(['monitor', 'auto']);

export function buildConfig(env = process.env, fileEnv = {}) {
  const get = (k) => (env[k] !== undefined ? env[k] : fileEnv[k]);

  const mode = str(get('BOT_MODE'), 'monitor').toLowerCase();
  if (!VALID_MODES.has(mode)) {
    throw new Error(`BOT_MODE must be one of ${[...VALID_MODES].join(', ')}, got: ${mode}`);
  }

  const config = {
    minProfitPercent: num(get('MIN_PROFIT_PERCENT'), 3, { min: 0, max: 100 }),
    maxBetUsdc: num(get('MAX_BET_USDC'), 10, { min: 0 }),
    daysToClose: num(get('DAYS_TO_CLOSE'), 7, { min: 0 }),
    mode,
    scanIntervalSec: num(get('SCAN_INTERVAL_SEC'), 5, { min: 1 }),
    minLiquidityUsdc: num(get('MIN_LIQUIDITY_USDC'), 5000, { min: 0 }),
    minVolume24hUsdc: num(get('MIN_VOLUME_24H_USDC'), 500, { min: 0 }),
    feePercent: num(get('FEE_PERCENT'), 2, { min: 0, max: 100 }),
    telegram: {
      botToken: str(get('TELEGRAM_BOT_TOKEN'), ''),
      chatId: str(get('TELEGRAM_CHAT_ID'), ''),
    },
    polymarket: {
      clobUrl: str(get('POLYMARKET_CLOB_URL'), 'https://clob.polymarket.com'),
      gammaUrl: str(get('POLYMARKET_GAMMA_URL'), 'https://gamma-api.polymarket.com'),
      walletPrivateKey: str(get('WALLET_PRIVATE_KEY'), ''),
    },
  };

  if (config.mode === 'auto' && !config.polymarket.walletPrivateKey) {
    throw new Error('BOT_MODE=auto requires WALLET_PRIVATE_KEY to be set');
  }

  return config;
}

export function loadConfig() {
  const fileEnv = loadDotEnv();
  return buildConfig(process.env, fileEnv);
}
