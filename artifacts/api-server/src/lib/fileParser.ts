import XLSX from "xlsx";
import type { OrderItem, PriceItem } from "./aiMatcher";

function normalizeHeader(h: unknown): string {
  return String(h ?? "").toLowerCase().trim();
}

function isNumeric(val: unknown): boolean {
  if (val === null || val === undefined || val === "") return false;
  return !isNaN(Number(String(val).replace(/\s/g, "").replace(",", ".")));
}

function toNumber(val: unknown): number {
  return parseFloat(String(val).replace(/\s/g, "").replace(",", "."));
}

function detectCurrency(rows: Record<string, unknown>[]): string {
  const text = JSON.stringify(rows).slice(0, 50000);
  if (/руб|rub|₽/i.test(text)) return "RUB";
  if (/uah|грн/i.test(text)) return "UAH";
  if (/usd|\$/i.test(text)) return "USD";
  if (/eur|€/i.test(text)) return "EUR";
  return "RUB";
}

// Detect article/SKU column from header name
function isArticleHeader(h: string): boolean {
  const n = h.toLowerCase();
  return (
    n.includes("артик") ||
    n.includes("арт.") ||
    n === "арт" ||
    n.includes("article") ||
    n.includes("sku") ||
    n.includes("код") ||
    n.includes("code") ||
    n.includes("партном") ||
    n.includes("part")
  );
}

function isPriceHeader(h: string): boolean {
  return (
    h.includes("цен") ||
    h.includes("price") ||
    h.includes("стоим") ||
    h.includes("cost")
  );
}

function isNameHeader(h: string): boolean {
  return (
    h.includes("наим") ||
    h.includes("товар") ||
    h.includes("продукт") ||
    h.includes("name") ||
    h.includes("descrip") ||
    h.includes("позиц") ||
    h.includes("номенкл")
  );
}

function isUnitHeader(h: string): boolean {
  return h.includes("ед") || h.includes("unit") || h.includes("мера") || h.includes("уп");
}

function isQtyHeader(h: string): boolean {
  return (
    h.includes("кол") ||
    h.includes("qty") ||
    h.includes("quant") ||
    h.includes("количест") ||
    h.includes("count")
  );
}

/**
 * Read ALL sheets from a workbook, including hidden/collapsed rows.
 * Returns combined rows tagged with the sheet name.
 */
function allSheetsToRows(buffer: Buffer): Record<string, unknown>[] {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    // cellStyles: needed to detect hidden rows via !rows metadata
    cellStyles: true,
  });

  const allRows: Record<string, unknown>[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    // sheet_to_json includes hidden rows by default.
    // We explicitly set raw: false so dates/numbers are formatted strings,
    // and defval: null so empty cells are null, not undefined.
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: null,
      raw: false,
      // blankrows: false skips rows where EVERY cell is blank/null
      blankrows: false,
    });

    allRows.push(...rows);
  }

  return allRows;
}

/**
 * Read only the first sheet (used for order files which are typically single-sheet).
 */
function firstSheetToRows(buffer: Buffer): Record<string, unknown>[] {
  const workbook = XLSX.read(buffer, { type: "buffer", cellStyles: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: false,
    blankrows: false,
  });
}

export function parsePriceList(buffer: Buffer): { items: PriceItem[]; currency: string } {
  // Read ALL sheets so grouped/collapsed sections are included
  const rows = allSheetsToRows(buffer);
  const currency = detectCurrency(rows);

  const items: PriceItem[] = [];

  // Detect column layout from the first row that has meaningful headers
  let nameKey = "";
  let priceKey = "";
  let unitKey = "";
  let articleKey = "";

  // First pass: detect columns from headers
  for (const row of rows) {
    const keys = Object.keys(row);
    let foundHeaders = false;

    for (const key of keys) {
      const h = normalizeHeader(key);
      if (!articleKey && isArticleHeader(h)) { articleKey = key; foundHeaders = true; }
      if (!nameKey && isNameHeader(h)) { nameKey = key; foundHeaders = true; }
      if (!priceKey && isPriceHeader(h)) { priceKey = key; foundHeaders = true; }
      if (!unitKey && isUnitHeader(h)) { unitKey = key; foundHeaders = true; }
    }

    if (foundHeaders && (nameKey || priceKey)) break;
  }

  // Second pass: extract item rows
  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length < 2) continue;

    // Per-row fallback detection if global detection found nothing
    let localNameKey = nameKey;
    let localPriceKey = priceKey;
    let localUnitKey = unitKey;
    let localArticleKey = articleKey;

    if (!localNameKey) localNameKey = keys[0];
    if (!localPriceKey) {
      for (const key of keys) {
        if (key !== localNameKey && isNumeric(row[key])) {
          localPriceKey = key;
          break;
        }
      }
    }

    const nameVal = String(row[localNameKey] ?? "").trim();
    const priceVal = row[localPriceKey];

    if (!nameVal || !priceVal || !isNumeric(priceVal)) continue;
    // Skip rows that look like headers themselves
    if (nameVal.toLowerCase() === normalizeHeader(localNameKey)) continue;

    const articleVal = localArticleKey
      ? String(row[localArticleKey] ?? "").trim() || null
      : null;

    items.push({
      name: nameVal,
      price: toNumber(priceVal),
      unit: localUnitKey ? String(row[localUnitKey] ?? "").trim() || null : null,
      article: articleVal,
    });
  }

  return { items, currency };
}

export function parseOrderList(buffer: Buffer): OrderItem[] {
  const rows = firstSheetToRows(buffer);
  const items: OrderItem[] = [];

  let nameKey = "";
  let qtyKey = "";
  let unitKey = "";
  let articleKey = "";

  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length < 2) continue;

    // Detect columns per row (headers may shift per row in some formats)
    for (const key of keys) {
      const h = normalizeHeader(key);
      if (!articleKey && isArticleHeader(h)) articleKey = key;
      if (!nameKey && isNameHeader(h)) nameKey = key;
      if (!qtyKey && isQtyHeader(h)) qtyKey = key;
      if (!unitKey && isUnitHeader(h)) unitKey = key;
    }

    if (!nameKey) nameKey = keys[0];
    if (!qtyKey) {
      for (const key of keys) {
        if (key !== nameKey && key !== articleKey && isNumeric(row[key])) {
          qtyKey = key;
          break;
        }
      }
    }

    const nameVal = String(row[nameKey] ?? "").trim();
    const qtyVal = row[qtyKey];

    if (!nameVal || !qtyVal || !isNumeric(qtyVal)) continue;
    if (nameVal.toLowerCase() === normalizeHeader(nameKey)) continue;

    const articleVal = articleKey
      ? String(row[articleKey] ?? "").trim() || null
      : null;

    items.push({
      name: nameVal,
      quantity: toNumber(qtyVal),
      unit: unitKey ? String(row[unitKey] ?? "").trim() || null : null,
      article: articleVal,
    });
  }

  return items;
}

export function buildExcelFromResult(result: {
  items: Array<{
    name: string;
    quantity: number;
    unit: string | null;
    unitPrice: number | null;
    totalPrice: number | null;
    found: boolean;
    matchedName: string | null;
    matchedArticle?: string | null;
  }>;
  grandTotal: number;
  currency: string;
  notes: string | null;
}): Buffer {
  const wb = XLSX.utils.book_new();

  const hasArticles = result.items.some((i) => i.matchedArticle);

  const header = [
    "Наименование (запрос)",
    "Артикул (запрос)",
    "Найдено в прайсе",
    ...(hasArticles ? ["Артикул (прайс)"] : []),
    "Кол-во",
    "Ед.",
    `Цена за ед. (${result.currency})`,
    `Сумма (${result.currency})`,
    "Статус",
  ];

  const dataRows = result.items.map((item) => [
    item.name,
    (item as unknown as { article?: string | null }).article ?? "",
    item.matchedName ?? "—",
    ...(hasArticles ? [item.matchedArticle ?? ""] : []),
    item.quantity,
    item.unit ?? "",
    item.unitPrice ?? "",
    item.totalPrice ?? "",
    item.found ? "Найдено" : "Не найдено",
  ]);

  const totalColIdx = hasArticles ? 7 : 6;
  const emptyRow = new Array(header.length).fill("");
  emptyRow[totalColIdx - 1] = "ИТОГО:";
  emptyRow[totalColIdx] = result.grandTotal;
  dataRows.push(emptyRow);

  if (result.notes) {
    dataRows.push(new Array(header.length).fill(""));
    const noteRow = new Array(header.length).fill("");
    noteRow[0] = `Примечания: ${result.notes}`;
    dataRows.push(noteRow);
  }

  const wsData = [header, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  ws["!cols"] = hasArticles
    ? [{ wch: 38 }, { wch: 14 }, { wch: 38 }, { wch: 14 }, { wch: 10 }, { wch: 8 }, { wch: 18 }, { wch: 18 }, { wch: 15 }]
    : [{ wch: 42 }, { wch: 14 }, { wch: 42 }, { wch: 10 }, { wch: 8 }, { wch: 18 }, { wch: 18 }, { wch: 15 }];

  XLSX.utils.book_append_sheet(wb, ws, "Результат");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
