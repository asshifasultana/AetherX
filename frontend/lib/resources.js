export class BusyError extends Error {
  constructor() {
    super('The server is busy. Please retry in five seconds.');
    this.status = 503;
    this.retryAfter = 5;
  }
}

export function createWorkGate({ rss = () => process.memoryUsage().rss, limit = 320 * 1024 * 1024 } = {}) {
  let active = false;
  return {
    acquire() {
      if (active || rss() >= limit) throw new BusyError();
      active = true;
      let released = false;
      return () => { if (!released) { released = true; active = false; } };
    }
  };
}

// Shared across collection variants in a running backend; no images enter this cache.
export function createSearchResources({ maxEntries = 8, maxBytes = 8 * 1024 * 1024, gate = createWorkGate() } = {}) {
  const cache = new Map(), pending = new Map();
  let bytes = 0;
  const remove = key => { const entry = cache.get(key); if (entry) { bytes -= entry.bytes; cache.delete(key); } };
  return {
    pending, gate,
    get(key, now) {
      const entry = cache.get(key);
      if (!entry) return null;
      remove(key);
      if (entry.expires <= now) return null;
      cache.set(key, entry); bytes += entry.bytes;
      return JSON.parse(entry.data.toString('utf8'));
    },
    set(key, result, expires, now) {
      for (const [oldKey, entry] of cache) if (entry.expires <= now) remove(oldKey);
      remove(key);
      const serialized = JSON.stringify(result);
      const size = Buffer.byteLength(serialized);
      if (size > maxBytes || maxEntries < 1) return;
      while (cache.size && (cache.size >= maxEntries || bytes + size > maxBytes)) remove(cache.keys().next().value);
      cache.set(key, { data: Buffer.from(serialized), bytes: size, expires }); bytes += size;
    }
  };
}

export const metadataResources = createSearchResources();
export const cutoutGate = createWorkGate();
