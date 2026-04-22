// Exponential backoff with jitter for transient HTTP failures (network errors,
// 5xx, 429). Used by Gamma fetches and Telegram sends so a brief outage or
// rate-limit doesn't drop arb signals on the floor.

const DEFAULT_RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function retry(fn, opts = {}) {
  const {
    retries = 4,
    baseMs = 250,
    maxMs = 4000,
    jitter = 0.5,
    isRetryable = defaultIsRetryable,
    onRetry,
    sleep = defaultSleep,
  } = opts;

  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      attempt += 1;
      if (attempt > retries || !isRetryable(err)) throw err;
      const delay = backoffDelay({ attempt, baseMs, maxMs, jitter });
      onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}

export function backoffDelay({ attempt, baseMs, maxMs, jitter }) {
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const j = 1 + (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(exp * j));
}

export function defaultIsRetryable(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  if (typeof err.status === 'number') return DEFAULT_RETRYABLE_STATUS.has(err.status);
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EAI_AGAIN') return true;
  // fetch failures surface as TypeError('fetch failed') in Node 20.
  return err.name === 'TypeError' || err.name === 'FetchError';
}

export class HttpError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms > 0 ? ms : 0));
}
