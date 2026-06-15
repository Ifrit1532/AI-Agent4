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
}

export interface PriceItem {
  name: string;
  price: number;
  unit?: string | null;
}

export interface MatchedItem {
  name: string;
  quantity: number;
  unit: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  found: boolean;
  matchedName: string | null;
}

export interface MatchResult {
  items: MatchedItem[];
  grandTotal: number;
  currency: string;
  notes: string | null;
}

// Normalize string for comparison: lowercase, strip punctuation, collapse spaces
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\wа-яёa-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Extract meaningful keywords from a string (words longer than 2 chars)
function keywords(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((w) => w.length > 2);
}

// Score how well a price item matches an order item name
function scoreMatch(orderName: string, priceName: string): number {
  const orderKw = keywords(orderName);
  const priceNorm = normalize(priceName);

  if (orderKw.length === 0) return 0;

  let score = 0;
  for (const kw of orderKw) {
    if (priceNorm.includes(kw)) score++;
  }
  return score / orderKw.length;
}

// For a given order item, find the top N most relevant price items
function findCandidates(orderName: string, priceItems: PriceItem[], topN = 10): PriceItem[] {
  const scored = priceItems
    .map((p) => ({ item: p, score: scoreMatch(orderName, p.name) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  // If nothing scored, fall back to simple contains check
  if (scored.length === 0) {
    const normOrder = normalize(orderName).split(" ").filter((w) => w.length > 2);
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

async function matchBatch(
  batchItems: BatchOrderItem[],
  currency: string
): Promise<MatchedItem[]> {
  const systemPrompt = `You are a procurement assistant doing fuzzy product name matching.
For each order item, pick the best matching product from its candidate list.
Names may differ: abbreviations, word order, typos, synonyms — use your judgment.

Return ONLY a valid JSON array (no markdown, no extra text) with one object per order item:
[
  {
    "name": "<original order item name>",
    "quantity": <number>,
    "unit": "<unit or null>",
    "unitPrice": <price number or null if no good match>,
    "totalPrice": <unitPrice * quantity or null>,
    "found": <true or false>,
    "matchedName": "<name as in candidates list or null>"
  }
]`;

  const lines = batchItems.map((b, i) => {
    const candidateList = b.candidates.length > 0
      ? b.candidates.map((c) => `    - ${c.name}: ${c.price}${c.unit ? ` (${c.unit})` : ""}`).join("\n")
      : "    (нет кандидатов)";
    return `[${i + 1}] "${b.orderItem.name}" qty=${b.orderItem.quantity}${b.orderItem.unit ? ` ${b.orderItem.unit}` : ""}
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

  // Extract JSON array
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`AI did not return a valid JSON array. Response snippet: ${content.slice(0, 200)}`);
  }

  return JSON.parse(jsonMatch[0]) as MatchedItem[];
}

const BATCH_SIZE = 25;

export async function matchPrices(
  orderItems: OrderItem[],
  priceItems: PriceItem[],
  currency: string
): Promise<MatchResult> {
  logger.info(
    { orderCount: orderItems.length, priceCount: priceItems.length },
    "Starting price matching with pre-filtering"
  );

  // Pre-filter: for each order item find top candidates from price list
  const batches: BatchOrderItem[][] = [];
  const batchedItems: BatchOrderItem[] = orderItems.map((orderItem) => ({
    orderItem,
    candidates: findCandidates(orderItem.name, priceItems, 10),
  }));

  for (let i = 0; i < batchedItems.length; i += BATCH_SIZE) {
    batches.push(batchedItems.slice(i, i + BATCH_SIZE));
  }

  logger.info({ batchCount: batches.length, batchSize: BATCH_SIZE }, "Processing batches");

  const allMatched: MatchedItem[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    logger.info({ batchIndex: i + 1, batchCount: batches.length }, "Processing batch");

    const matched = await matchBatch(batch, currency);
    allMatched.push(...matched);
  }

  const grandTotal = allMatched.reduce((sum, item) => sum + (item.totalPrice ?? 0), 0);
  const notFoundCount = allMatched.filter((i) => !i.found).length;

  const notes =
    notFoundCount > 0
      ? `${notFoundCount} из ${allMatched.length} позиций не найдено в прайс-листе`
      : null;

  return {
    items: allMatched,
    grandTotal,
    currency,
    notes,
  };
}
