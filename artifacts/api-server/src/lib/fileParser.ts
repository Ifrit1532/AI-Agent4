import XLSX from "xlsx";
import type { OrderItem, PriceItem } from "./aiMatcher";
import { logger } from "./logger";

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
  const text = JSON.stringify(rows.slice(0, 100)).slice(0, 10000);
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
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: false,
    blankrows: false,
  });
}

export interface PriceFilePreview {
  columns: string[];
  samples: Record<string, string[]>;
  detected: {
    nameColumn: string | null;
    priceColumn: string | null;
    articleColumn: string | null;
  };
}

export interface OrderFilePreview {
  columns: string[];
  samples: Record<string, string[]>;
  detected: {
    nameColumn: string | null;
    qtyColumn: string | null;
    articleColumn: string | null;
  };
}

export interface PriceColumnOverrides {
  nameColumn?: string;
  priceColumn?: string;
  articleColumn?: string;
}

export interface OrderColumnOverrides {
  nameColumn?: string;
  qtyColumn?: string;
  articleColumn?: string;
}

/**
 * Read a workbook and find the best header row by scanning the first 30 rows.
 * Scores rows by how many cells match known header keywords.
 * Returns columns, data rows, and the header row index found.
 */
function buildColumnsAndRows(
  buffer: Buffer,
  multiSheet: boolean,
): { columns: string[]; rows: Record<string, unknown>[]; headerRowIndex: number } {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetNames = (
    multiSheet ? workbook.SheetNames : [workbook.SheetNames[0]].filter(Boolean)
  ) as string[];

  let bestScore = -Infinity;
  let bestResult: { columns: string[]; rows: Record<string, unknown>[]; headerRowIndex: number } = {
    columns: [],
    rows: [],
    headerRowIndex: 0,
  };

  for (const sheetName of sheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    // Read as raw array-of-arrays so we can find the actual header row
    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
      raw: false,
    });

    let sheetBestScore = -Infinity;
    let sheetBestIdx = 0;

    for (let i = 0; i < Math.min(rawRows.length, 30); i++) {
      const row = rawRows[i] ?? [];
      const cells = row.map((c) => String(c ?? "").trim());
      const nonEmpty = cells.filter((v) => v.length > 0);
      if (nonEmpty.length < 2) continue;

      let score = 0;
      let textCells = 0;

      for (const cell of nonEmpty) {
        const h = normalizeHeader(cell);
        if (isNameHeader(h)) score += 6;
        else if (isPriceHeader(h)) score += 6;
        else if (isQtyHeader(h)) score += 6;
        else if (isArticleHeader(h)) score += 5;
        else if (isUnitHeader(h)) score += 4;
        else if (!isNumeric(cell) && cell.length <= 50) { score += 0.5; textCells++; }
      }
      // Bonus for rows with multiple text-like cells (more likely a header)
      if (textCells >= 3) score += 3;
      // Penalty: all-numeric rows are definitely data, not headers
      if (nonEmpty.every((c) => isNumeric(c))) score -= 20;

      if (score > sheetBestScore) {
        sheetBestScore = score;
        sheetBestIdx = i;
      }
    }

    if (sheetBestScore > bestScore) {
      bestScore = sheetBestScore;

      const headerRow = rawRows[sheetBestIdx] ?? [];
      const seen = new Set<string>();
      const columns: string[] = [];
      const colMap = new Map<number, string>();

      for (let ci = 0; ci < headerRow.length; ci++) {
        // Skip columns that have no data at all in the next 15 rows
        const hasData = rawRows
          .slice(sheetBestIdx + 1, sheetBestIdx + 16)
          .some((r) => String((r as unknown[])[ci] ?? "").trim().length > 0);
        const headerVal = String(headerRow[ci] ?? "").trim();
        if (!hasData && headerVal.length === 0) continue;

        let name = headerVal.length > 0 ? headerVal : `Колонка${ci + 1}`;
        if (seen.has(name)) {
          let s = 2;
          while (seen.has(`${name}_${s}`)) s++;
          name = `${name}_${s}`;
        }
        seen.add(name);
        columns.push(name);
        colMap.set(ci, name);
      }

      const rows: Record<string, unknown>[] = [];
      for (let ri = sheetBestIdx + 1; ri < rawRows.length; ri++) {
        const rawRow = rawRows[ri] ?? [];
        const hasAny = rawRow.some((c) => String(c ?? "").trim().length > 0);
        if (!hasAny) continue;
        const row: Record<string, unknown> = {};
        for (const [ci, colName] of colMap) {
          row[colName] = rawRow[ci] ?? null;
        }
        rows.push(row);
      }

      bestResult = { columns, rows, headerRowIndex: sheetBestIdx };
    }
  }

  return bestResult;
}

interface ColStats {
  numericRatio: number;
  textRatio: number;
  avgLen: number;
  articleRatio: number; // short mixed alphanumeric
  maxNum: number;
}

/** Analyze data rows to understand what kind of data is in each column */
function analyzeColumnStats(
  rows: Record<string, unknown>[],
  columns: string[],
): Record<string, ColStats> {
  const result: Record<string, ColStats> = {};
  const sample = rows.slice(0, 100);

  for (const col of columns) {
    const vals = sample.map((r) => String(r[col] ?? "").trim()).filter((v) => v.length > 0);
    if (!vals.length) {
      result[col] = { numericRatio: 0, textRatio: 0, avgLen: 0, articleRatio: 0, maxNum: 0 };
      continue;
    }
    const numeric = vals.filter((v) => isNumeric(v));
    const numVals = numeric.map((v) => toNumber(v)).filter((v) => !isNaN(v));
    const maxNum = numVals.length ? Math.max(...numVals) : 0;
    // Article-like: has both letters and digits, not purely numeric, short
    const articleLike = vals.filter(
      (v) => !isNumeric(v) && v.length >= 2 && v.length <= 30 && /[A-Za-z]/.test(v) && /\d/.test(v),
    );
    result[col] = {
      numericRatio: numeric.length / vals.length,
      textRatio: (vals.length - numeric.length) / vals.length,
      avgLen: vals.reduce((s, v) => s + v.length, 0) / vals.length,
      articleRatio: articleLike.length / vals.length,
      maxNum,
    };
  }
  return result;
}

function collectSamples(
  rows: Record<string, unknown>[],
  columns: string[],
): Record<string, string[]> {
  const samples: Record<string, string[]> = {};
  for (const col of columns) samples[col] = [];
  for (const row of rows) {
    let full = true;
    for (const col of columns) {
      if ((samples[col]?.length ?? 0) < 3) {
        full = false;
        const val = String(row[col] ?? "").trim();
        if (val && val.toLowerCase() !== normalizeHeader(col)) {
          samples[col] = [...(samples[col] ?? []), val];
        }
      }
    }
    if (full) break;
  }
  return samples;
}

function detectPriceColumns(
  columns: string[],
  rows: Record<string, unknown>[],
): { nameColumn: string | null; priceColumn: string | null; articleColumn: string | null } {
  let nameColumn: string | null = null;
  let priceColumn: string | null = null;
  let articleColumn: string | null = null;

  // Step 1: keyword matching on header names
  for (const col of columns) {
    const h = normalizeHeader(col);
    if (!articleColumn && isArticleHeader(h)) articleColumn = col;
    if (!nameColumn && isNameHeader(h)) nameColumn = col;
    if (!priceColumn && isPriceHeader(h)) priceColumn = col;
  }

  // Step 2: data-driven detection for unresolved columns
  const stats = analyzeColumnStats(rows, columns);

  if (!priceColumn) {
    const candidates = columns
      .filter((c) => c !== nameColumn && c !== articleColumn)
      .filter((c) => (stats[c]?.numericRatio ?? 0) > 0.6)
      .sort((a, b) => (stats[b]?.maxNum ?? 0) - (stats[a]?.maxNum ?? 0)); // larger numbers → price
    if (candidates.length) priceColumn = candidates[0] ?? null;
  }

  if (!nameColumn) {
    const candidates = columns
      .filter((c) => c !== priceColumn && c !== articleColumn)
      .filter((c) => (stats[c]?.textRatio ?? 0) > 0.4)
      .sort((a, b) => (stats[b]?.avgLen ?? 0) - (stats[a]?.avgLen ?? 0)); // longer text → name
    if (candidates.length) nameColumn = candidates[0] ?? null;
  }

  if (!articleColumn) {
    const candidates = columns
      .filter((c) => c !== nameColumn && c !== priceColumn)
      .filter((c) => (stats[c]?.articleRatio ?? 0) > 0.25);
    if (candidates.length) articleColumn = candidates[0] ?? null;
  }

  if (!nameColumn && columns.length > 0) nameColumn = columns[0] ?? null;
  return { nameColumn, priceColumn, articleColumn };
}

function detectOrderColumns(
  columns: string[],
  rows: Record<string, unknown>[],
): { nameColumn: string | null; qtyColumn: string | null; articleColumn: string | null } {
  let nameColumn: string | null = null;
  let qtyColumn: string | null = null;
  let articleColumn: string | null = null;

  for (const col of columns) {
    const h = normalizeHeader(col);
    if (!articleColumn && isArticleHeader(h)) articleColumn = col;
    if (!nameColumn && isNameHeader(h)) nameColumn = col;
    if (!qtyColumn && isQtyHeader(h)) qtyColumn = col;
  }

  const stats = analyzeColumnStats(rows, columns);

  if (!qtyColumn) {
    const candidates = columns
      .filter((c) => c !== nameColumn && c !== articleColumn)
      .filter((c) => (stats[c]?.numericRatio ?? 0) > 0.6)
      .sort((a, b) => (stats[a]?.maxNum ?? 0) - (stats[b]?.maxNum ?? 0)); // smaller numbers → qty
    if (candidates.length) qtyColumn = candidates[0] ?? null;
  }

  if (!nameColumn) {
    const candidates = columns
      .filter((c) => c !== qtyColumn && c !== articleColumn)
      .filter((c) => (stats[c]?.textRatio ?? 0) > 0.4)
      .sort((a, b) => (stats[b]?.avgLen ?? 0) - (stats[a]?.avgLen ?? 0));
    if (candidates.length) nameColumn = candidates[0] ?? null;
  }

  if (!articleColumn) {
    const candidates = columns
      .filter((c) => c !== nameColumn && c !== qtyColumn)
      .filter((c) => (stats[c]?.articleRatio ?? 0) > 0.25);
    if (candidates.length) articleColumn = candidates[0] ?? null;
  }

  if (!nameColumn && columns.length > 0) nameColumn = columns[0] ?? null;
  return { nameColumn, qtyColumn, articleColumn };
}

/**
 * Parse a single worksheet with smart header-row detection (scans first 30 rows).
 * Returns extracted PriceItems for that sheet.
 */
function parseSheetItems(
  sheet: XLSX.WorkSheet,
  overrides?: PriceColumnOverrides,
): PriceItem[] {
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: false,
  });

  if (rawRows.length < 2) return [];

  // Score each of the first 30 rows to find the best header row
  let bestScore = -Infinity;
  let bestIdx = 0;

  for (let i = 0; i < Math.min(rawRows.length, 30); i++) {
    const row = rawRows[i] ?? [];
    const cells = (row as unknown[]).map((c) => String(c ?? "").trim());
    const nonEmpty = cells.filter((v) => v.length > 0);
    if (nonEmpty.length < 2) continue;

    let score = 0;
    let textCells = 0;
    for (const cell of nonEmpty) {
      const h = normalizeHeader(cell);
      if (isNameHeader(h)) score += 6;
      else if (isPriceHeader(h)) score += 6;
      else if (isArticleHeader(h)) score += 5;
      else if (isUnitHeader(h)) score += 4;
      else if (!isNumeric(cell) && cell.length <= 50) { score += 0.5; textCells++; }
    }
    if (textCells >= 3) score += 3;
    if (nonEmpty.every((c) => isNumeric(c))) score -= 20;

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  // Build column map from best header row
  const headerRow = (rawRows[bestIdx] ?? []) as unknown[];
  const seen = new Set<string>();
  const columns: string[] = [];
  const colMap = new Map<number, string>();

  for (let ci = 0; ci < headerRow.length; ci++) {
    const hasData = rawRows
      .slice(bestIdx + 1, bestIdx + 16)
      .some((r) => String(((r as unknown[])[ci]) ?? "").trim().length > 0);
    const headerVal = String(headerRow[ci] ?? "").trim();
    if (!hasData && headerVal.length === 0) continue;
    let name = headerVal.length > 0 ? headerVal : `Колонка${ci + 1}`;
    if (seen.has(name)) {
      let s = 2;
      while (seen.has(`${name}_${s}`)) s++;
      name = `${name}_${s}`;
    }
    seen.add(name);
    columns.push(name);
    colMap.set(ci, name);
  }

  const rows: Record<string, unknown>[] = [];
  for (let ri = bestIdx + 1; ri < rawRows.length; ri++) {
    const rawRow = (rawRows[ri] ?? []) as unknown[];
    const hasAny = rawRow.some((c) => String(c ?? "").trim().length > 0);
    if (!hasAny) continue;
    const row: Record<string, unknown> = {};
    for (const [ci, colName] of colMap) {
      row[colName] = rawRow[ci] ?? null;
    }
    rows.push(row);
  }

  if (rows.length === 0) return [];

  // Detect name/price/article columns
  let nameKey = overrides?.nameColumn ?? "";
  let priceKey = overrides?.priceColumn ?? "";
  let articleKey = overrides?.articleColumn ?? "";
  let unitKey = "";

  for (const col of columns) {
    const h = normalizeHeader(col);
    if (!articleKey && isArticleHeader(h)) articleKey = col;
    if (!nameKey && isNameHeader(h)) nameKey = col;
    if (!priceKey && isPriceHeader(h)) priceKey = col;
    if (!unitKey && isUnitHeader(h)) unitKey = col;
  }

  // Data-driven fallback when header keywords didn't match
  if (!priceKey || !nameKey) {
    const stats = analyzeColumnStats(rows, columns);
    if (!priceKey) {
      const cands = columns
        .filter((c) => c !== nameKey && c !== articleKey)
        .filter((c) => (stats[c]?.numericRatio ?? 0) > 0.6)
        .sort((a, b) => (stats[b]?.maxNum ?? 0) - (stats[a]?.maxNum ?? 0));
      if (cands.length) priceKey = cands[0]!;
    }
    if (!nameKey) {
      const cands = columns
        .filter((c) => c !== priceKey && c !== articleKey)
        .filter((c) => (stats[c]?.textRatio ?? 0) > 0.4)
        .sort((a, b) => (stats[b]?.avgLen ?? 0) - (stats[a]?.avgLen ?? 0));
      if (cands.length) nameKey = cands[0]!;
    }
    if (!articleKey) {
      const cands = columns
        .filter((c) => c !== nameKey && c !== priceKey)
        .filter((c) => (stats[c]?.articleRatio ?? 0) > 0.25);
      if (cands.length) articleKey = cands[0]!;
    }
  }

  if (!nameKey && columns.length > 0) nameKey = columns[0]!;
  if (!nameKey || !priceKey) return [];

  const items: PriceItem[] = [];
  for (const row of rows) {
    const nameVal = String(row[nameKey] ?? "").trim();
    const priceVal = row[priceKey];
    if (!nameVal || !priceVal || !isNumeric(priceVal)) continue;
    if (nameVal.toLowerCase() === normalizeHeader(nameKey)) continue;
    const articleVal = articleKey ? String(row[articleKey] ?? "").trim() || null : null;
    items.push({
      name: nameVal,
      price: toNumber(priceVal),
      unit: unitKey ? String(row[unitKey] ?? "").trim() || null : null,
      article: articleVal,
    });
  }

  return items;
}

export function previewPriceFile(buffer: Buffer): PriceFilePreview {
  const { columns, rows } = buildColumnsAndRows(buffer, true);
  const samples = collectSamples(rows, columns);
  const detected = detectPriceColumns(columns, rows);
  return { columns, samples, detected };
}

export function previewOrderFile(buffer: Buffer): OrderFilePreview {
  const { columns, rows } = buildColumnsAndRows(buffer, false);
  const samples = collectSamples(rows, columns);
  const detected = detectOrderColumns(columns, rows);
  return { columns, samples, detected };
}

export function parsePriceList(
  buffer: Buffer,
  overrides?: PriceColumnOverrides,
): { items: PriceItem[]; currency: string } {
  // Read with cellStyles so xlsx also captures !rows[n].hidden flags
  const workbook = XLSX.read(buffer, { type: "buffer", cellStyles: true, WTF: false });

  // Currency detection from raw combined text
  const rawRows = allSheetsToRows(buffer);
  const currency = detectCurrency(rawRows);

  // ── Raw cell scan: count cells containing "двигател" and hidden rows ──────────
  let rawMotorCells = 0;
  let rawHiddenRows = 0;
  const motorSamples: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    // Count hidden rows via !rows metadata
    const rowsMeta = (sheet["!rows"] ?? []) as Array<{ hidden?: boolean } | null | undefined>;
    for (const r of rowsMeta) {
      if (r?.hidden) rawHiddenRows++;
    }
    // Scan every cell for motor-related text
    for (const addr of Object.keys(sheet)) {
      if (addr.startsWith("!")) continue;
      const cell = sheet[addr] as { v?: unknown; w?: unknown } | undefined;
      const val = String(cell?.v ?? cell?.w ?? "").toLowerCase();
      if (val.includes("двигател") || val.includes("мотор")) {
        rawMotorCells++;
        if (motorSamples.length < 10) motorSamples.push(String(cell?.v ?? ""));
      }
    }
  }
  logger.info(
    { rawMotorCells, rawHiddenRows, motorSamples },
    "Raw cell scan — motors in file",
  );

  const allItems: PriceItem[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    // Parse with hidden-row-aware range walking
    const sheetItems = parseSheetItems(sheet, overrides);
    logger.info({ sheetName, itemCount: sheetItems.length }, "Parsed price sheet");
    allItems.push(...sheetItems);
  }

  // Deduplicate by name+price to avoid counting items from overlapping sheets twice
  const seenKeys = new Set<string>();
  const deduped: PriceItem[] = [];
  for (const item of allItems) {
    const key = `${item.name.toLowerCase()}|||${item.price}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      deduped.push(item);
    }
  }

  // How many parsed items contain motor keywords?
  const parsedMotorItems = deduped.filter(
    (i) => i.name.toLowerCase().includes("двигател") || i.name.toLowerCase().includes("мотор"),
  );
  logger.info(
    {
      totalItems: deduped.length,
      sheetCount: workbook.SheetNames.length,
      parsedMotorItems: parsedMotorItems.length,
      parsedMotorSamples: parsedMotorItems.slice(0, 5).map((i) => i.name),
    },
    "Price list parsed (all sheets)",
  );
  return { items: deduped, currency };
}

export function parseOrderList(buffer: Buffer, overrides?: OrderColumnOverrides): OrderItem[] {
  const { columns, rows } = buildColumnsAndRows(buffer, false);
  const items: OrderItem[] = [];

  // Apply overrides or auto-detect
  const detected = detectOrderColumns(columns, rows);
  const nameKey = overrides?.nameColumn || detected.nameColumn || columns[0] || "";
  const qtyKey = overrides?.qtyColumn || detected.qtyColumn || "";
  const articleKey = overrides?.articleColumn || detected.articleColumn || "";

  // Find unit column
  let unitKey = "";
  for (const col of columns) {
    if (col !== nameKey && col !== qtyKey && col !== articleKey && isUnitHeader(normalizeHeader(col))) {
      unitKey = col;
      break;
    }
  }

  for (const row of rows) {
    const nameVal = String(row[nameKey] ?? "").trim();
    const qtyVal = row[qtyKey];

    if (!nameVal || !qtyVal || !isNumeric(qtyVal)) continue;
    if (nameVal.toLowerCase() === normalizeHeader(nameKey)) continue;

    const articleVal = articleKey ? String(row[articleKey] ?? "").trim() || null : null;

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
