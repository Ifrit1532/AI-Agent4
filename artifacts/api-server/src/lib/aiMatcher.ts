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
    .replace(/[^\wа-яёa-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCode(a: string): string {
  // Strip separators so "40X-8080", "40X_8080", "40X8080" all match
  return a.toLowerCase().replace(/[\s\-._]/g, "");
}

function keywords(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((w) => w.length > 2);
}

// ─── Product code extraction ───────────────────────────────────────────────────

/**
 * Extract product/part codes embedded in a free-text product name.
 * Matches tokens that look like model numbers or part numbers:
 *   - Mixed letter+digit, at least 4 meaningful chars: 40X8080, CF226X, TK-3170
 *   - Pure numeric, at least 5 digits: 12345
 *   - May include internal dashes, dots, or underscores: 106R-03623, CF226X
 */
export function extractProductCodes(name: string): string[] {
  const raw = name.match(/\b[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*\b/g) ?? [];
  return raw.filter((t) => {
    const stripped = t.replace(/[-_.]/g, "");
    const hasLetter = /[A-Za-z]/.test(stripped);
    const hasDigit = /[0-9]/.test(stripped);
    // Mixed alphanumeric, at least 4 chars
    if (hasLetter && hasDigit && stripped.length >= 4) return true;
    // Pure numeric, at least 5 digits
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

  // 1. Explicit article field on order item vs price article
  if (orderItem.article && pa) {
    const oa = normalizeCode(orderItem.article);
    if (oa === pa && oa.length > 0) {
      return { item: priceItem, score: 3.0, matchMethod: "article" };
    }
    if (oa.length >= 3 && (pa.includes(oa) || oa.includes(pa))) {
      return { item: priceItem, score: 2.5, matchMethod: "article" };
    }
  }

  // 2. Extract product codes from order name, match against price article
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

    // Also check codes against the price item name (in case article is in the name)
    const priceNameNorm = normalize(priceItem.name);
    const orderCodes = extractProductCodes(orderItem.name);
    const priceCodes = extractProductCodes(priceItem.name);
    for (const oc of orderCodes) {
      const nc = normalizeCode(oc);
      // Check against article column already done above; now check price name codes
      for (const pc of priceCodes) {
        if (nc === normalizeCode(pc) && nc.length >= 4) {
          return { item: priceItem, score: 2.0, matchMethod: "embedded_code" };
        }
      }
      // Check if the code appears literally in the price name string
      if (nc.length >= 4 && priceNameNorm.replace(/[\s\-._]/g, "").includes(nc)) {
        return { item: priceItem, score: 1.8, matchMethod: "embedded_code" };
      }
    }
  }

  // 3. Also check codes from order name against price name directly (no article col)
  const orderCodes = extractProductCodes(orderItem.name);
  if (orderCodes.length > 0) {
    const priceNameFlat = normalize(priceItem.name).replace(/[\s\-._]/g, "");
    for (const code of orderCodes) {
      const nc = normalizeCode(code);
      if (nc.length >= 4 && priceNameFlat.includes(nc)) {
        return { item: priceItem, score: 1.8, matchMethod: "embedded_code" };
      }
    }
    // Check price codes extracted from price name
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

  // 4. Keyword-based name matching
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

function findCandidates(
  orderItem: OrderItem,
  priceItems: PriceItem[],
  topN = 12
): { candidates: PriceItem[]; extractedCodes: string[] } {
  const extractedCodes = extractProductCodes(orderItem.name);

  const scored: ScoredCandidate[] = priceItems
    .map((p) => scoreCandidate(orderItem, p))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  // If nothing scored, try prefix fallback
  if (scored.length === 0) {
    const normOrder = normalize(orderItem.name).split(" ").filter((w) => w.length > 2);
    const fallback = priceItems
      .filter((p) => {
        const pn = normalize(p.name);
        return normOrder.some((kw) => pn.includes(kw.slice(0, 4)));
      })
      .slice(0, topN);
    return { candidates: fallback, extractedCodes };
  }

  return { candidates: scored.map((x) => x.item), extractedCodes };
}

// ─── Dual price list helpers ──────────────────────────────────────────────────

function findCandidatesDual(
  orderItem: OrderItem,
  priceItems1: PriceItem[],
  priceItems2: PriceItem[],
  topN = 12
): { candidates: TaggedPriceItem[]; extractedCodes: string[] } {
  const extractedCodes = extractProductCodes(orderItem.name);
  const tagged1: TaggedPriceItem[] = priceItems1.map((p) => ({ ...p, _source: 1 as const }));
  const tagged2: TaggedPriceItem[] = priceItems2.map((p) => ({ ...p, _source: 2 as const }));
  const all: TaggedPriceItem[] = [...tagged1, ...tagged2];

  const scored = all
    .map((p) => ({ scored: scoreCandidate(orderItem, p), taggedItem: p }))
    .filter((x) => x.scored.score > 0)
    .sort((a, b) => b.scored.score - a.scored.score)
    .slice(0, topN);

  if (scored.length === 0) {
    const normOrder = normalize(orderItem.name).split(" ").filter((w) => w.length > 2);
    const fallback = all
      .filter((p) => {
        const pn = normalize(p.name);
        return normOrder.some((kw) => pn.includes(kw.slice(0, 4)));
      })
      .slice(0, topN);
    return { candidates: fallback, extractedCodes };
  }

  return { candidates: scored.map((x) => x.taggedItem), extractedCodes };
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

  return JSON.parse(jsonMatch[0]) as MatchedItem[];
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

  return JSON.parse(jsonMatch[0]) as MatchedItem[];
}

// ─── Main entry point ─────────────────────────────────────────────────────────

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

  const batchedItems: BatchOrderItem[] = orderItems.map((orderItem) => {
    const { candidates, extractedCodes } = findCandidates(orderItem, priceItems, 12);
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
    const matched = await matchBatch(batches[i], currency);
    allMatched.push(...matched);
  }

  const grandTotal = allMatched.reduce((sum, item) => sum + (item.totalPrice ?? 0), 0);
  const notFoundCount = allMatched.filter((i) => !i.found).length;
  const notes =
    notFoundCount > 0
      ? `${notFoundCount} из ${allMatched.length} позиций не найдено в прайс-листе`
      : null;

  return { items: allMatched, grandTotal, currency, notes };
}

// ─── Dual price list entry point ──────────────────────────────────────────────

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

  const batchedItems: BatchOrderItemDual[] = orderItems.map((orderItem) => {
    const { candidates, extractedCodes } = findCandidatesDual(orderItem, priceItems1, priceItems2, 12);
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
    const matched = await matchBatchDual(batches[i], currency);
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
