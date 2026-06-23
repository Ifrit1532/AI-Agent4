import OpenAI from "openai";
import { logger } from "./logger";

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

export interface OrderItem {
  name: string;
  quantity: number;
  unit?: string | null;
  article?: string | null;
}

export interface PriceItem {
  name: string;
  price: number;
  unit?: string | null;
  article?: string | null;
}

export interface MatchedItem {
  name: string;
  article: string | null;
  extractedCodes: string[];
  quantity: number;
  unit: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  found: boolean;
  matchMethod: "article" | "embedded_code" | "name" | "none";
  matchedName: string | null;
  matchedArticle: string | null;
  priceSource?: 1 | 2;
}

interface TaggedPriceItem extends PriceItem {
  _source: 1 | 2;
}

export interface MatchResult {
  items: MatchedItem[];
  grandTotal: number;
  currency: string;
  notes: string | null;
}

// ─── Text normalization ────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/(\d)[,.](\d)/g, "$1$2")
    .replace(/[^\wа-яёa-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCode(a: string): string {
  return a.toLowerCase().replace(/[\s\-._]/g, "");
}

function keywords(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((w) => w.length >= 2);
}

// ─── Product code extraction ───────────────────────────────────────────────────

export function extractProductCodes(name: string): string[] {
  const raw = name.match(/\b[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*\b/g) ?? [];
  return raw.filter((t) => {
    const stripped = t.replace(/[-_.]/g, "");
    const hasLetter = /[A-Za-z]/.test(stripped);
    const hasDigit = /[0-9]/.test(stripped);
    if (hasLetter && hasDigit && stripped.length >= 4) return true;
    if (!hasLetter && hasDigit && stripped.length >= 5) return true;
    return false;
  });
}

// ─── Candidate scoring ────────────────────────────────────────────────────────

interface ScoredCandidate {
  item: PriceItem;
  score: number;
  matchMethod: MatchedItem["matchMethod"];
}

function scoreCandidate(orderItem: OrderItem, priceItem: PriceItem): ScoredCandidate {
  const pa = priceItem.article ? normalizeCode(priceItem.article) : null;

  if (orderItem.article && pa) {
    const oa = normalizeCode(orderItem.article);
    if (oa === pa && oa.length > 0) {
      return { item: priceItem, score: 3.0, matchMethod: "article" };
    }
    if (oa.length >= 3 && (pa.includes(oa) || oa.includes(pa))) {
      return { item: priceItem, score: 2.5, matchMethod: "article" };
    }
  }

  if (pa) {
    const codes = extractProductCodes(orderItem.name);
    for (const code of codes) {
      const nc = normalizeCode(code);
      if (nc === pa && nc.length >= 4) {
        return { item: priceItem, score: 3.0, matchMethod: "embedded_code" };
      }
      if (nc.length >= 4 && (pa.includes(nc) || nc.includes(pa))) {
        return { item: priceItem, score: 2.5, matchMethod: "embedded_code" };
      }
    }

    const priceNameNorm = normalize(priceItem.name);
    const orderCodes = extractProductCodes(orderItem.name);
    const priceCodes = extractProductCodes(priceItem.name);
    for (const oc of orderCodes) {
      const nc = normalizeCode(oc);
      for (const pc of priceCodes) {
        if (nc === normalizeCode(pc) && nc.length >= 4) {
          return { item: priceItem, score: 2.0, matchMethod: "embedded_code" };
        }
      }
      if (nc.length >= 4 && priceNameNorm.replace(/[\s\-._]/g, "").includes(nc)) {
        return { item: priceItem, score: 1.8, matchMethod: "embedded_code" };
      }
    }
  }

  const orderCodes = extractProductCodes(orderItem.name);
  if (orderCodes.length > 0) {
    const priceNameFlat = normalize(priceItem.name).replace(/[\s\-._]/g, "");
    for (const code of orderCodes) {
      const nc = normalizeCode(code);
      if (nc.length >= 4 && priceNameFlat.includes(nc)) {
        return { item: priceItem, score: 1.8, matchMethod: "embedded_code" };
      }
    }
    const priceCodes = extractProductCodes(priceItem.name);
    for (const oc of orderCodes) {
      const nc = normalizeCode(oc);
      for (const pc of priceCodes) {
        if (nc === normalizeCode(pc) && nc.length >= 4) {
          return { item: priceItem, score: 2.0, matchMethod: "embedded_code" };
        }
      }
    }
  }

  const orderKw = keywords(orderItem.name);
  const priceNorm = normalize(priceItem.name);
  if (orderKw.length === 0) return { item: priceItem, score: 0, matchMethod: "none" };

  let hits = 0;
  for (const kw of orderKw) {
    if (priceNorm.includes(kw)) hits++;
  }
  const nameScore = hits / orderKw.length;
  return {
    item: priceItem,
    score: nameScore,
    matchMethod: nameScore > 0 ? "name" : "none",
  };
}

// ─── Inverted index for fast candidate lookup ─────────────────────────────────

interface PriceItemIndex {
  items: PriceItem[];
  byArticle: Map<string, number[]>;
  byCodeInName: Map<string, number[]>;
  byKeyword: Map<string, number[]>;
}

function buildPriceIndex(items: PriceItem[]): PriceItemIndex {
  const byArticle = new Map<string, number[]>();
  const byCodeInName = new Map<string, number[]>();
  const byKeyword = new Map<string, number[]>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;

    if (item.article) {
      const key = normalizeCode(item.article);
      if (key.length >= 2) {
        let b = byArticle.get(key);
        if (!b) { b = []; byArticle.set(key, b); }
        b.push(i);
      }
    }

    for (const code of extractProductCodes(item.name)) {
      const key = normalizeCode(code);
      let b = byCodeInName.get(key);
      if (!b) { b = []; byCodeInName.set(key, b); }
      b.push(i);
    }

    for (const kw of keywords(item.name)) {
      let b = byKeyword.get(kw);
      if (!b) { b = []; byKeyword.set(kw, b); }
      b.push(i);
    }
  }

  return { items, byArticle, byCodeInName, byKeyword };
}

// Per-keyword bucket cap: avoids O(N) on very common words like "картридж"
const KW_BUCKET_CAP = 1500;

function findFromIndex(
  orderItem: OrderItem,
  index: PriceItemIndex,
  topN = 20,
): { candidates: PriceItem[]; extractedCodes: string[] } {
  const extractedCodes = extractProductCodes(orderItem.name);
  const { items, byArticle, byCodeInName, byKeyword } = index;
  const candidateSet = new Set<number>();

  // 1. Exact article lookup
  if (orderItem.article) {
    const oa = normalizeCode(orderItem.article);
    if (oa.length >= 2) {
      for (const idx of byArticle.get(oa) ?? []) candidateSet.add(idx);
    }
  }

  // 2. Embedded codes → article index + code-in-name index
  for (const code of extractedCodes) {
    const nc = normalizeCode(code);
    if (nc.length < 4) continue;
    for (const idx of byArticle.get(nc) ?? []) candidateSet.add(idx);
    for (const idx of byCodeInName.get(nc) ?? []) candidateSet.add(idx);
  }

  // 3. Keyword hits — take top-50 by hit count
  const orderKws = keywords(orderItem.name);
  const kwHits = new Map<number, number>();
  for (const kw of orderKws) {
    const bucket = byKeyword.get(kw);
    if (!bucket) continue;
    const lim = Math.min(bucket.length, KW_BUCKET_CAP);
    for (let j = 0; j < lim; j++) {
      const idx = bucket[j]!;
      kwHits.set(idx, (kwHits.get(idx) ?? 0) + 1);
    }
  }
  const kwTop = [...kwHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
  for (const [idx] of kwTop) candidateSet.add(idx);

  // 4. Prefix fallback if index returned nothing
  if (candidateSet.size === 0) {
    const normKws = orderKws.filter((w) => w.length > 2);
    for (let i = 0; i < items.length && candidateSet.size < 50; i++) {
      if (normKws.some((kw) => normalize(items[i]!.name).includes(kw.slice(0, 4)))) {
        candidateSet.add(i);
      }
    }
  }

  // Score only the candidates found via index
  const scored: ScoredCandidate[] = [];
  for (const idx of candidateSet) {
    const s = scoreCandidate(orderItem, items[idx]!);
    if (s.score > 0) scored.push(s);
  }
  scored.sort((a, b) => b.score - a.score);
  return { candidates: scored.slice(0, topN).map((x) => x.item), extractedCodes };
}

// ─── Dual price list index ────────────────────────────────────────────────────

interface TaggedPriceItemIndex {
  items: TaggedPriceItem[];
  byArticle: Map<string, number[]>;
  byCodeInName: Map<string, number[]>;
  byKeyword: Map<string, number[]>;
}

function buildTaggedIndex(items1: PriceItem[], items2: PriceItem[]): TaggedPriceItemIndex {
  const tagged: TaggedPriceItem[] = [
    ...items1.map((p) => ({ ...p, _source: 1 as const })),
    ...items2.map((p) => ({ ...p, _source: 2 as const })),
  ];

  const byArticle = new Map<string, number[]>();
  const byCodeInName = new Map<string, number[]>();
  const byKeyword = new Map<string, number[]>();

  for (let i = 0; i < tagged.length; i++) {
    const item = tagged[i]!;

    if (item.article) {
      const key = normalizeCode(item.article);
      if (key.length >= 2) {
        let b = byArticle.get(key);
        if (!b) { b = []; byArticle.set(key, b); }
        b.push(i);
      }
    }

    for (const code of extractProductCodes(item.name)) {
      const key = normalizeCode(code);
      let b = byCodeInName.get(key);
      if (!b) { b = []; byCodeInName.set(key, b); }
      b.push(i);
    }

    for (const kw of keywords(item.name)) {
      let b = byKeyword.get(kw);
      if (!b) { b = []; byKeyword.set(kw, b); }
      b.push(i);
    }
  }

  return { items: tagged, byArticle, byCodeInName, byKeyword };
}

function findDualFromIndex(
  orderItem: OrderItem,
  index: TaggedPriceItemIndex,
  topN = 20,
): { candidates: TaggedPriceItem[]; extractedCodes: string[] } {
  const extractedCodes = extractProductCodes(orderItem.name);
  const { items, byArticle, byCodeInName, byKeyword } = index;
  const candidateSet = new Set<number>();

  if (orderItem.article) {
    const oa = normalizeCode(orderItem.article);
    if (oa.length >= 2) {
      for (const idx of byArticle.get(oa) ?? []) candidateSet.add(idx);
    }
  }

  for (const code of extractedCodes) {
    const nc = normalizeCode(code);
    if (nc.length < 4) continue;
    for (const idx of byArticle.get(nc) ?? []) candidateSet.add(idx);
    for (const idx of byCodeInName.get(nc) ?? []) candidateSet.add(idx);
  }

  const orderKws = keywords(orderItem.name);
  const kwHits = new Map<number, number>();
  for (const kw of orderKws) {
    const bucket = byKeyword.get(kw);
    if (!bucket) continue;
    const lim = Math.min(bucket.length, KW_BUCKET_CAP);
    for (let j = 0; j < lim; j++) {
      const idx = bucket[j]!;
      kwHits.set(idx, (kwHits.get(idx) ?? 0) + 1);
    }
  }
  const kwTop = [...kwHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
  for (const [idx] of kwTop) candidateSet.add(idx);

  if (candidateSet.size === 0) {
    const normKws = orderKws.filter((w) => w.length > 2);
    for (let i = 0; i < items.length && candidateSet.size < 50; i++) {
      if (normKws.some((kw) => normalize(items[i]!.name).includes(kw.slice(0, 4)))) {
        candidateSet.add(i);
      }
    }
  }

  const scored: Array<{ item: TaggedPriceItem; score: number }> = [];
  for (const idx of candidateSet) {
    const item = items[idx]!;
    const s = scoreCandidate(orderItem, item);
    if (s.score > 0) scored.push({ item, score: s.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return { candidates: scored.slice(0, topN).map((x) => x.item), extractedCodes };
}

// ─── AI batch processing ──────────────────────────────────────────────────────

interface BatchOrderItem {
  orderItem: OrderItem;
  candidates: PriceItem[];
  extractedCodes: string[];
}

async function matchBatch(batchItems: BatchOrderItem[], currency: string): Promise<MatchedItem[]> {
  const systemPrompt = `You are a procurement assistant doing fuzzy product matching.

Rules:
1. If an order item name contains an embedded product/part code (e.g. "Блок лазера Lexmark 40X8080" → code "40X8080"), prioritize candidates where that code matches the article or appears in the name.
2. If an explicit article is given for the order item, prioritize article match over name similarity.
3. Otherwise match by name similarity (abbreviations, synonyms, word order OK).

Return ONLY a valid JSON array (no markdown, no extra text) with exactly one object per order item, in the same order:
[
  {
    "name": "<original order item name>",
    "article": "<original order item article or null>",
    "extractedCodes": ["<code1>", ...],
    "quantity": <number>,
    "unit": "<unit or null>",
    "unitPrice": <price or null if no good match>,
    "totalPrice": <unitPrice * quantity or null>,
    "found": <true or false>,
    "matchMethod": "<article|embedded_code|name|none>",
    "matchedName": "<matched candidate name or null>",
    "matchedArticle": "<matched candidate article or null>"
  }
]`;

  const lines = batchItems.map((b, i) => {
    const artPart = b.orderItem.article ? ` арт.=${b.orderItem.article}` : "";
    const codesPart =
      b.extractedCodes.length > 0
        ? ` [коды в названии: ${b.extractedCodes.join(", ")}]`
        : "";
    const candidateList =
      b.candidates.length > 0
        ? b.candidates
            .map((c) => {
              const artStr = c.article ? ` [арт: ${c.article}]` : "";
              const unitStr = c.unit ? ` (${c.unit})` : "";
              return `    - ${c.name}${artStr}: ${c.price}${unitStr}`;
            })
            .join("\n")
        : "    (нет кандидатов)";

    return `[${i + 1}] "${b.orderItem.name}"${artPart}${codesPart} qty=${b.orderItem.quantity}${b.orderItem.unit ? ` ${b.orderItem.unit}` : ""}
  Candidates:
${candidateList}`;
  });

  const userPrompt = `Currency: ${currency}\n\n${lines.join("\n\n")}`;

  const response = await openai.chat.completions.create({
    model: "deepseek-chat",
    max_tokens: 8000,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const content = response.choices[0]?.message?.content ?? "";
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`AI did not return a valid JSON array. Snippet: ${content.slice(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]) as MatchedItem[];

  // Realign by name in case AI reordered or dropped items
  const byName = new Map<string, MatchedItem>();
  for (const item of parsed) {
    if (item.name) byName.set(item.name.trim().toLowerCase(), item);
  }

  const aligned: MatchedItem[] = batchItems.map((b) => {
    const key = b.orderItem.name.trim().toLowerCase();
    const found = byName.get(key);
    if (found) return found;
    // Fuzzy fallback: try partial match
    for (const [k, v] of byName) {
      if (k.includes(key.slice(0, 20)) || key.includes(k.slice(0, 20))) return v;
    }
    logger.warn({ orderName: b.orderItem.name }, "AI did not return result for item — marking not found");
    return {
      name: b.orderItem.name,
      article: b.orderItem.article ?? null,
      extractedCodes: b.extractedCodes,
      quantity: b.orderItem.quantity,
      unit: b.orderItem.unit ?? null,
      unitPrice: null,
      totalPrice: null,
      found: false,
      matchMethod: "none",
      matchedName: null,
      matchedArticle: null,
    };
  });

  if (parsed.length !== batchItems.length) {
    logger.warn({ expected: batchItems.length, got: parsed.length }, "AI returned wrong number of items in batch");
  }

  return aligned;
}

interface BatchOrderItemDual {
  orderItem: OrderItem;
  candidates: TaggedPriceItem[];
  extractedCodes: string[];
}

async function matchBatchDual(batchItems: BatchOrderItemDual[], currency: string): Promise<MatchedItem[]> {
  const systemPrompt = `You are a procurement assistant doing fuzzy product matching.
Candidates are labeled [П1] (from price list 1) or [П2] (from price list 2).

Rules:
1. If an order item name contains an embedded product/part code (e.g. "Блок лазера Lexmark 40X8080" → code "40X8080"), prioritize candidates where that code matches the article or appears in the name.
2. If an explicit article is given for the order item, prioritize article match over name similarity.
3. Otherwise match by name similarity (abbreviations, synonyms, word order OK).
4. You may match from either price list — pick the best overall match.

Return ONLY a valid JSON array (no markdown, no extra text) with exactly one object per order item, in the same order:
[
  {
    "name": "<original order item name>",
    "article": "<original order item article or null>",
    "extractedCodes": ["<code1>", ...],
    "quantity": <number>,
    "unit": "<unit or null>",
    "unitPrice": <price or null if no good match>,
    "totalPrice": <unitPrice * quantity or null>,
    "found": <true or false>,
    "matchMethod": "<article|embedded_code|name|none>",
    "matchedName": "<matched candidate name or null>",
    "matchedArticle": "<matched candidate article or null>",
    "priceSource": <1 or 2 — which price list the match came from, or null if not found>
  }
]`;

  const lines = batchItems.map((b, i) => {
    const artPart = b.orderItem.article ? ` арт.=${b.orderItem.article}` : "";
    const codesPart =
      b.extractedCodes.length > 0
        ? ` [коды в названии: ${b.extractedCodes.join(", ")}]`
        : "";
    const candidateList =
      b.candidates.length > 0
        ? b.candidates
            .map((c) => {
              const artStr = c.article ? ` [арт: ${c.article}]` : "";
              const unitStr = c.unit ? ` (${c.unit})` : "";
              return `    - [П${c._source}] ${c.name}${artStr}: ${c.price}${unitStr}`;
            })
            .join("\n")
        : "    (нет кандидатов)";

    return `[${i + 1}] "${b.orderItem.name}"${artPart}${codesPart} qty=${b.orderItem.quantity}${b.orderItem.unit ? ` ${b.orderItem.unit}` : ""}
  Candidates:
${candidateList}`;
  });

  const userPrompt = `Currency: ${currency}\n\n${lines.join("\n\n")}`;

  const response = await openai.chat.completions.create({
    model: "deepseek-chat",
    max_tokens: 8000,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const content = response.choices[0]?.message?.content ?? "";
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`AI did not return a valid JSON array. Snippet: ${content.slice(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]) as MatchedItem[];

  const byName = new Map<string, MatchedItem>();
  for (const item of parsed) {
    if (item.name) byName.set(item.name.trim().toLowerCase(), item);
  }

  const aligned: MatchedItem[] = batchItems.map((b) => {
    const key = b.orderItem.name.trim().toLowerCase();
    const found = byName.get(key);
    if (found) return found;
    for (const [k, v] of byName) {
      if (k.includes(key.slice(0, 20)) || key.includes(k.slice(0, 20))) return v;
    }
    logger.warn({ orderName: b.orderItem.name }, "AI (dual) did not return result for item — marking not found");
    return {
      name: b.orderItem.name,
      article: b.orderItem.article ?? null,
      extractedCodes: b.extractedCodes,
      quantity: b.orderItem.quantity,
      unit: b.orderItem.unit ?? null,
      unitPrice: null,
      totalPrice: null,
      found: false,
      matchMethod: "none",
      matchedName: null,
      matchedArticle: null,
    };
  });

  if (parsed.length !== batchItems.length) {
    logger.warn({ expected: batchItems.length, got: parsed.length }, "AI (dual) returned wrong number of items in batch");
  }

  return aligned;
}

// ─── Main entry points ─────────────────────────────────────────────────────────

const BATCH_SIZE = 25;

export async function matchPricesSSE(
  orderItems: OrderItem[],
  priceItems: PriceItem[],
  currency: string,
  onProgress: (batchIndex: number, totalBatches: number, batchSize: number) => void
): Promise<MatchResult> {
  logger.info(
    { orderCount: orderItems.length, priceCount: priceItems.length },
    "Starting price matching"
  );

  // Build index once — O(N) — then each order item only scores its small candidate set
  const index = buildPriceIndex(priceItems);

  const batchedItems: BatchOrderItem[] = orderItems.map((orderItem) => {
    const { candidates, extractedCodes } = findFromIndex(orderItem, index, 20);
    if (candidates.length === 0) {
      logger.warn({ orderName: orderItem.name, article: orderItem.article }, "Zero candidates found for order item");
    }
    return { orderItem, candidates, extractedCodes };
  });

  const batches: BatchOrderItem[][] = [];
  for (let i = 0; i < batchedItems.length; i += BATCH_SIZE) {
    batches.push(batchedItems.slice(i, i + BATCH_SIZE));
  }

  logger.info({ batchCount: batches.length }, "Batches prepared");

  const allMatched: MatchedItem[] = [];

  for (let i = 0; i < batches.length; i++) {
    logger.info({ batchIndex: i + 1, batchCount: batches.length }, "Processing batch");
    onProgress(i + 1, batches.length, BATCH_SIZE);
    const matched = await matchBatch(batches[i]!, currency);
    allMatched.push(...matched);
  }

  // Log not-found items with their top candidates so we can diagnose misses
  const batchedByName = new Map(
    batchedItems.map((b) => [b.orderItem.name.trim().toLowerCase(), b])
  );
  for (const item of allMatched.filter((i) => !i.found).slice(0, 15)) {
    const batched = batchedByName.get(item.name.trim().toLowerCase());
    logger.warn(
      {
        orderName: item.name,
        candidateCount: batched?.candidates.length ?? 0,
        topCandidates: batched?.candidates.slice(0, 5).map((c) => ({
          name: c.name,
          article: c.article,
          price: c.price,
        })),
      },
      "Not found — top candidates shown",
    );
  }

  const grandTotal = allMatched.reduce((sum, item) => sum + (item.totalPrice ?? 0), 0);
  const notFoundCount = allMatched.filter((i) => !i.found).length;
  const notes =
    notFoundCount > 0
      ? `${notFoundCount} из ${allMatched.length} позиций не найдено в прайс-листе`
      : null;

  return { items: allMatched, grandTotal, currency, notes };
}

export async function matchPricesSSEDual(
  orderItems: OrderItem[],
  priceItems1: PriceItem[],
  priceItems2: PriceItem[],
  currency: string,
  onProgress: (batchIndex: number, totalBatches: number, batchSize: number) => void
): Promise<MatchResult> {
  logger.info(
    { orderCount: orderItems.length, priceCount1: priceItems1.length, priceCount2: priceItems2.length },
    "Starting dual price matching"
  );

  // Build combined tagged index once — avoids re-tagging 18k+ items per order item
  const index = buildTaggedIndex(priceItems1, priceItems2);

  const batchedItems: BatchOrderItemDual[] = orderItems.map((orderItem) => {
    const { candidates, extractedCodes } = findDualFromIndex(orderItem, index, 20);
    if (candidates.length === 0) {
      logger.warn({ orderName: orderItem.name, article: orderItem.article }, "Zero candidates found for order item (dual)");
    }
    return { orderItem, candidates, extractedCodes };
  });

  const batches: BatchOrderItemDual[][] = [];
  for (let i = 0; i < batchedItems.length; i += BATCH_SIZE) {
    batches.push(batchedItems.slice(i, i + BATCH_SIZE));
  }

  logger.info({ batchCount: batches.length }, "Dual batches prepared");

  const allMatched: MatchedItem[] = [];

  for (let i = 0; i < batches.length; i++) {
    logger.info({ batchIndex: i + 1, batchCount: batches.length }, "Processing dual batch");
    onProgress(i + 1, batches.length, BATCH_SIZE);
    const matched = await matchBatchDual(batches[i]!, currency);
    allMatched.push(...matched);
  }

  const grandTotal = allMatched.reduce((sum, item) => sum + (item.totalPrice ?? 0), 0);
  const notFoundCount = allMatched.filter((i) => !i.found).length;
  const notes =
    notFoundCount > 0
      ? `${notFoundCount} из ${allMatched.length} позиций не найдено в прайс-листах`
      : null;

  return { items: allMatched, grandTotal, currency, notes };
}
