
export const CACHE_BYTES = 128 * 1024 * 1024;
export const WORKING_BYTES = 256 * 1024 * 1024;
export class ImageBudgetError extends Error { constructor() { super('This stack exceeds the browser memory budget. Reduce the field of view or maximum stack frames.'); this.name = 'ImageBudgetError'; } }
export function byteSize(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return 0;
  seen.add(value);
  if (ArrayBuffer.isView(value)) { if (seen.has(value.buffer)) return 0; seen.add(value.buffer); return value.buffer.byteLength; }
  if (value instanceof ArrayBuffer) return value.byteLength;
  let bytes = value.width && value.height && typeof value.getContext === 'function' ? value.width * value.height * 4 : 0;
  for (const entry of Object.values(value)) bytes += byteSize(entry, seen);
  return bytes;
}
// Both decoded and rendered caches use this same ledger.
export function createCacheBudget(limit = CACHE_BYTES) { return { limit, bytes: 0, entries: new Map() }; }
const shared = createCacheBudget();
export class ByteCache extends Map {
  constructor(budget = shared) { super(); this.budget = budget; }
  get(key) { const entry = this.budget.entries.get(this)?.get(key); if (entry) entry.used = ++ByteCache.clock; return super.get(key); }
  set(key, value) {
    this.delete(key);
    const size = byteSize(value);
    if (size > this.budget.limit) return this;
    if (!this.budget.entries.has(this)) this.budget.entries.set(this, new Map());
    this.budget.entries.get(this).set(key, { size, used: ++ByteCache.clock });
    this.budget.bytes += size; super.set(key, value);
    while (this.budget.bytes > this.budget.limit) {
      let oldest, owner, id;
      for (const [map, entries] of this.budget.entries) for (const [key, item] of entries) if (!oldest || item.used < oldest.used) { oldest = item; owner = map; id = key; }
      owner.delete(id);
    }
    return this;
  }
  delete(key) { const entries = this.budget.entries.get(this), entry = entries?.get(key); if (entry) { this.budget.bytes -= entry.size; entries.delete(key); } return super.delete(key); }
  clear() { for (const key of this.keys()) this.delete(key); }
  static clock = 0;
}
export function assertStackBudget(frames, fovArcmin) {
  const pixels = Math.max(1, Math.round(fovArcmin * 60 / 6.15)) ** 2;
  // Daily grids/canvases, median scratch/output, four in-flight bounded reads,
  // and an entire largest daily group retained until its median is complete.
  const maxExposures = Math.max(1, ...frames.map(f => (f.exposures || [f]).length));
  const estimate = pixels * (frames.length * 14 + Math.min(4, frames.length) * maxExposures * 32 + 48) + 64 * 1024 * 1024;
  if (estimate > WORKING_BYTES - CACHE_BYTES) throw new ImageBudgetError();
  return estimate;
}
