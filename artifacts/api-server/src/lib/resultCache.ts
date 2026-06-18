import crypto from "crypto";
import type { MatchResult, PriceItem } from "./aiMatcher";
import { extractProductCodes } from "./aiMatcher";

interface CacheEntry {
  result: MatchResult;
  priceItems: PriceItem[];
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

function isAlive(entry: CacheEntry): boolean {
  return Date.now() - entry.createdAt <= CACHE_TTL_MS;
}

export function getCached(key: string): MatchResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (!isAlive(entry)) { cache.delete(key); return null; }
  entry.hits++;
  return entry.result;
}

export function setCached(key: string, result: MatchResult, priceItems: PriceItem[]): void {
  cache.set(key, { result, priceItems, createdAt: Date.now(), hits: 0 });
}

function normalizeCode(s: string): string {
  return s.toLowerCase().replace(/[\s\-._]/g, "");
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\wа-яёa-z0-9\s]/gi, " ").replace(/\s+/g, " ").trim();
}

/**
 * Search the cached price list by article code or name.
 * Returns up to `limit` best matches.
 */
export function searchPriceItems(
  sessionId: string,
  query: string,
  limit = 8
): PriceItem[] {
  const entry = cache.get(sessionId);
  if (!entry || !isAlive(entry)) return [];

  const q = query.trim();
  if (q.length < 2) return [];

  const qNorm = normalizeCode(q);
  const qKw = normalize(q).split(" ").filter((w) => w.length > 1);

  type Scored = { item: PriceItem; score: number };
  const scored: Scored[] = [];

  for (const item of entry.priceItems) {
    let score = 0;

    // Exact article match → top
    if (item.article) {
      const an = normalizeCode(item.article);
      if (an === qNorm) { score = 4; }
      else if (an.includes(qNorm) || qNorm.includes(an)) { score = 3; }
    }

    // Codes embedded in the price item name
    if (score === 0) {
      const priceCodes = extractProductCodes(item.name);
      for (const pc of priceCodes) {
        const pn = normalizeCode(pc);
        if (pn === qNorm && pn.length >= 4) { score = Math.max(score, 3.5); }
        else if (pn.includes(qNorm) && qNorm.length >= 4) { score = Math.max(score, 2.5); }
      }
    }

    // Keyword match on name
    if (score === 0 && qKw.length > 0) {
      const nameNorm = normalize(item.name);
      let hits = 0;
      for (const kw of qKw) { if (nameNorm.includes(kw)) hits++; }
      if (hits > 0) score = hits / qKw.length;
    }

    if (score > 0) scored.push({ item, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item);
}
