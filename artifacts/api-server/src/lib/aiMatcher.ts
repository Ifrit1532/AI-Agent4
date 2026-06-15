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
  currency?: string;
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

export async function matchPrices(
  orderItems: OrderItem[],
  priceItems: PriceItem[],
  currency: string
): Promise<MatchResult> {
  const systemPrompt = `You are a procurement assistant. You will be given a list of ordered items and a price list.
Your job is to match each ordered item to the best matching item in the price list using fuzzy matching — the names may differ slightly (abbreviations, different word order, typos, synonyms).

Return ONLY a valid JSON object with this structure:
{
  "items": [
    {
      "name": "<original order item name>",
      "quantity": <number>,
      "unit": "<unit or null>",
      "unitPrice": <price number or null if not found>,
      "totalPrice": <unitPrice * quantity or null if not found>,
      "found": <true or false>,
      "matchedName": "<name as in price list or null>"
    }
  ],
  "grandTotal": <sum of all totalPrices>,
  "currency": "<currency>",
  "notes": "<any notes about difficult matches, or null>"
}

Rules:
- Match items as best you can, even with name variations
- If an item cannot be found at all, set found=false, unitPrice=null, totalPrice=null, matchedName=null
- grandTotal is the sum of all non-null totalPrices
- Return ONLY the JSON, no extra text`;

  const userPrompt = `Currency: ${currency}

ORDER LIST:
${orderItems.map((i, idx) => `${idx + 1}. ${i.name} — qty: ${i.quantity}${i.unit ? ` ${i.unit}` : ""}`).join("\n")}

PRICE LIST:
${priceItems.map((i, idx) => `${idx + 1}. ${i.name} — ${i.price} ${i.unit ? `(${i.unit})` : ""}`).join("\n")}`;

  logger.info({ orderCount: orderItems.length, priceCount: priceItems.length }, "Calling DeepSeek AI for price matching");

  const response = await openai.chat.completions.create({
    model: "deepseek-chat",
    max_tokens: 4096,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const content = response.choices[0]?.message?.content ?? "";
  logger.info({ responseLength: content.length }, "AI response received");

  // Extract JSON from the response (strip markdown code blocks if present)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("AI did not return valid JSON");
  }

  const result = JSON.parse(jsonMatch[0]) as MatchResult;
  return result;
}
