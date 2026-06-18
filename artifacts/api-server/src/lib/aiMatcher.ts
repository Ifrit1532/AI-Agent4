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
  quantity: number;
  unit: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  found: boolean;
  matchedName: string | null;
  matchedArticle: string | null;
}

export interface MatchResult {
  items: MatchedItem[];
  grandTotal: number;
  currency: string;
  notes: string | null;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\wа-яёa-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeArticle(a: string): string {
  // Strip spaces, dashes, dots — focus on digits/letters
  return a.toLowerCase().replace(/[\s\-._]/g, "");
}

function keywords(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((w) => w.length > 2);
}

function scoreMatch(orderItem: OrderItem, priceItem: PriceItem): number {
  // 1. Exact article match → guaranteed top candidate (score 2.0)
  if (orderItem.article && priceItem.article) {
    const oa = normalizeArticle(orderItem.article);
    const pa = normalizeArticle(priceItem.article);
    if (oa === pa && oa.length > 0) return 2.0;
    // Partial article match (one contains the other) → high score
    if (oa.length >= 3 && (pa.includes(oa) || oa.includes(pa))) return 1.5;
  }

  // 2. Name-based keyword score
  const orderKw = keywords(orderItem.name);
  const priceNorm = normalize(priceItem.name);
  if (orderKw.length === 0) return 0;

  let hits = 0;
  for (const kw of orderKw) {
    if (priceNorm.includes(kw)) hits++;
  }
  return hits / orderKw.length;
}

function findCandidates(orderItem: OrderItem, priceItems: PriceItem[], topN = 12): PriceItem[] {
  const scored = priceItems
    .map((p) => ({ item: p, score: scoreMatch(orderItem, p) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  if (scored.length === 0) {
    // Fallback: prefix-match on first 4 chars of each keyword
    const normOrder = normalize(orderItem.name).split(" ").filter((w) => w.length > 2);
    return priceItems
      .filter((p) => {
        const pn = normalize(p.name);
        return normOrder.some((kw) => pn.includes(kw.slice(0, 4)));
      })
      .slice(0, topN);
  }

  return scored.map((x) => x.item);
}

interface BatchOrderItem {
  orderItem: OrderItem;
  candidates: PriceItem[];
}

async function matchBatch(batchItems: BatchOrderItem[], currency: string): Promise<MatchedItem[]> {
  const systemPrompt = `You are a procurement assistant doing fuzzy product name and article matching.
For each numbered order item, pick the best matching product from its candidate list.
Names may differ: abbreviations, word order, typos, synonyms — use your best judgment.
If an article number is provided, prioritize article match over name similarity.

Return ONLY a valid JSON array (no markdown, no extra text) with exactly one object per order item, in the same order:
[
  {
    "name": "<original order item name>",
    "article": "<original order item article or null>",
    "quantity": <number>,
    "unit": "<unit or null>",
    "unitPrice": <price number or null if no good match>,
    "totalPrice": <unitPrice * quantity or null>,
    "found": <true or false>,
    "matchedName": "<name as in candidates list or null>",
    "matchedArticle": "<article from the matched candidate or null>"
  }
]`;

  const lines = batchItems.map((b, i) => {
    const artPart = b.orderItem.article ? ` арт.=${b.orderItem.article}` : "";
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
    return `[${i + 1}] "${b.orderItem.name}"${artPart} qty=${b.orderItem.quantity}${b.orderItem.unit ? ` ${b.orderItem.unit}` : ""}
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

const BATCH_SIZE = 25;

export async function matchPricesSSE(
  orderItems: OrderItem[],
  priceItems: PriceItem[],
  currency: string,
  onProgress: (batchIndex: number, totalBatches: number, batchSize: number) => void
): Promise<MatchResult> {
  logger.info(
    { orderCount: orderItems.length, priceCount: priceItems.length },
    "Starting price matching with pre-filtering"
  );

  const batchedItems: BatchOrderItem[] = orderItems.map((orderItem) => ({
    orderItem,
    candidates: findCandidates(orderItem, priceItems, 12),
  }));

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
