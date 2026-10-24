// Tiny LRU cache (used to memoize recent screenshots / transcripts so repeated
// calls within a short window are cheap).
class LRUCache {
  constructor(max = 12, ttlMs = 30000) {
    this.max = max;
    this.ttl = ttlMs;
    this.map = new Map();
  }

  get(key) {
    const item = this.map.get(key);
    if (!item) return undefined;
    if (Date.now() - item.at > this.ttl) {
      this.map.delete(key);
      return undefined;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, item);
    return item.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, at: Date.now() });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  clear() {
    this.map.clear();
  }
}

module.exports = { LRUCache };
