// Bounded TTL cache backed by a Map. Used by the scan loop to dedupe
// already-alerted opportunities without muting a market forever (a paginated
// API hiccup can briefly drop a market from the listing — when it comes back
// with a fresh window we want to react again, not silently skip it).

export class TtlCache {
  constructor({ ttlMs = 60 * 60 * 1000, maxSize = 10_000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.now = now;
    this.map = new Map();
  }

  has(key) {
    const entry = this.map.get(key);
    if (entry === undefined) return false;
    if (this.#expired(entry)) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  add(key) {
    // Re-insert to keep insertion-order roughly aligned with recency for
    // the maxSize trim path below.
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, this.now());
    if (this.map.size > this.maxSize) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
  }

  prune() {
    let removed = 0;
    for (const [key, ts] of this.map) {
      if (this.#expired(ts)) {
        this.map.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size() {
    return this.map.size;
  }

  #expired(ts) {
    return this.now() - ts >= this.ttlMs;
  }
}
