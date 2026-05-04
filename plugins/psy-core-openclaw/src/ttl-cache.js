export class TtlCache {
  constructor(ttlMs, maxEntries) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  remember(key) {
    const now = Date.now();
    this.prune(now);
    if (this.entries.has(key)) {
      this.entries.delete(key);
      this.entries.set(key, { value: true, ts: now });
      return true;
    }
    this.set(key, true, now);
    return false;
  }

  set(key, value, now = Date.now()) {
    this.prune(now);
    this.entries.delete(key);
    this.entries.set(key, { value, ts: now });
    this.trimToSize();
  }

  take(key) {
    const now = Date.now();
    this.prune(now);
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    return entry.value;
  }

  prune(now = Date.now()) {
    const cutoff = now - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.ts < cutoff) this.entries.delete(key);
    }
    this.trimToSize();
  }

  trimToSize() {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }
}
