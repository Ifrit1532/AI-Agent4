import crypto from "crypto";
import type { MatchResult } from "./aiMatcher";

interface CacheEntry {
  result: MatchResult;
  createdAt: number;
  hits: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const cache = new Map<string, CacheEntry>();

export function hashFiles(priceBuffer: Buffer, orderBuffer: Buffer): string {
  return crypto
    .createHash("sha256")
    .update(priceBuffer)
    .update("|")
    .update(orderBuffer)
    .digest("hex");
}

export function getCached(key: string): MatchResult | null {
  const entry = cache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  entry.hits++;
  return entry.result;
}

export function setCached(key: string, result: MatchResult): void {
  cache.set(key, { result, createdAt: Date.now(), hits: 0 });
}

export function getCacheStats(): { size: number; keys: string[] } {
  // Clean expired entries
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now - entry.createdAt > CACHE_TTL_MS) {
      cache.delete(key);
    }
  }
  return { size: cache.size, keys: [...cache.keys()].map((k) => k.slice(0, 8) + "…") };
}
