import XLSX from "xlsx";
import type { OrderItem, PriceItem } from "./aiMatcher";

function normalizeHeader(h: unknown): string {
  return String(h ?? "").toLowerCase().trim();
}

function isNumeric(val: unknown): boolean {
  if (val === null || val === undefined || val === "") return false;
  return !isNaN(Number(val));
}

function toNumber(val: unknown): number {
  return parseFloat(String(val).replace(/\s/g, "").replace(",", "."));
}

function detectCurrency(rows: Record<string, unknown>[]): string {
  const text = JSON.stringify(rows);
  if (/руб|rub|₽/i.test(text)) return "RUB";
  if (/uah|грн|UAH/i.test(text)) return "UAH";
  if (/usd|\$/i.test(text)) return "USD";
  if (/eur|€/i.test(text)) return "EUR";
  return "RUB";
}

function sheetToRows(buffer: Buffer): Record<string, unknown>[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: false,
  });
  return rows;
}

export function parsePriceList(buffer: Buffer): { items: PriceItem[]; currency: string } {
  const rows = sheetToRows(buffer);
  const currency = detectCurrency(rows);

  // Try to detect columns
  const items: PriceItem[] = [];

  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length < 2) continue;

    // Find name column (first text-heavy column)
    let nameKey = "";
    let priceKey = "";
    let unitKey = "";

    for (const key of keys) {
      const h = normalizeHeader(key);
      if (!nameKey && (h.includes("наим") || h.includes("товар") || h.includes("продукт") || h.includes("name") || h.includes("descrip") || h.includes("позиц"))) {
        nameKey = key;
      }
      if (!priceKey && (h.includes("цен") || h.includes("price") || h.includes("стоим") || h.includes("cost"))) {
        priceKey = key;
      }
      if (!unitKey && (h.includes("ед") || h.includes("unit") || h.includes("мера") || h.includes("уп"))) {
        unitKey = key;
      }
    }

    // Fallback: first column is name, find first numeric column as price
    if (!nameKey) nameKey = keys[0];
    if (!priceKey) {
      for (const key of keys) {
        if (key !== nameKey && isNumeric(row[key])) {
          priceKey = key;
          break;
        }
      }
    }

    const nameVal = String(row[nameKey] ?? "").trim();
    const priceVal = row[priceKey];

    if (!nameVal || !priceVal || !isNumeric(priceVal)) continue;
    if (nameVal.toLowerCase() === normalizeHeader(nameKey)) continue; // skip header rows

    items.push({
      name: nameVal,
      price: toNumber(priceVal),
      unit: unitKey ? String(row[unitKey] ?? "").trim() || null : null,
    });
  }

  return { items, currency };
}

export function parseOrderList(buffer: Buffer): OrderItem[] {
  const rows = sheetToRows(buffer);
  const items: OrderItem[] = [];

  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length < 2) continue;

    let nameKey = "";
    let qtyKey = "";
    let unitKey = "";

    for (const key of keys) {
      const h = normalizeHeader(key);
      if (!nameKey && (h.includes("наим") || h.includes("товар") || h.includes("продукт") || h.includes("name") || h.includes("descrip") || h.includes("позиц"))) {
        nameKey = key;
      }
      if (!qtyKey && (h.includes("кол") || h.includes("qty") || h.includes("quant") || h.includes("количест") || h.includes("count"))) {
        qtyKey = key;
      }
      if (!unitKey && (h.includes("ед") || h.includes("unit") || h.includes("мера") || h.includes("уп"))) {
        unitKey = key;
      }
    }

    if (!nameKey) nameKey = keys[0];
    if (!qtyKey) {
      for (const key of keys) {
        if (key !== nameKey && isNumeric(row[key])) {
          qtyKey = key;
          break;
        }
      }
    }

    const nameVal = String(row[nameKey] ?? "").trim();
    const qtyVal = row[qtyKey];

    if (!nameVal || !qtyVal || !isNumeric(qtyVal)) continue;
    if (nameVal.toLowerCase() === normalizeHeader(nameKey)) continue;

    items.push({
      name: nameVal,
      quantity: toNumber(qtyVal),
      unit: unitKey ? String(row[unitKey] ?? "").trim() || null : null,
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
  }>;
  grandTotal: number;
  currency: string;
  notes: string | null;
}): Buffer {
  const wb = XLSX.utils.book_new();

  const header = ["Наименование (запрос)", "Найдено в прайсе", "Кол-во", "Ед.", `Цена за ед. (${result.currency})`, `Сумма (${result.currency})`, "Статус"];

  const dataRows = result.items.map((item) => [
    item.name,
    item.matchedName ?? "—",
    item.quantity,
    item.unit ?? "",
    item.unitPrice ?? "",
    item.totalPrice ?? "",
    item.found ? "Найдено" : "Не найдено",
  ]);

  // Add grand total row
  dataRows.push(["", "", "", "", "ИТОГО:", result.grandTotal, ""]);

  if (result.notes) {
    dataRows.push(["", "", "", "", "", "", ""]);
    dataRows.push([`Примечания: ${result.notes}`, "", "", "", "", "", ""]);
  }

  const wsData = [header, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Column widths
  ws["!cols"] = [{ wch: 40 }, { wch: 40 }, { wch: 10 }, { wch: 8 }, { wch: 18 }, { wch: 18 }, { wch: 15 }];

  XLSX.utils.book_append_sheet(wb, ws, "Результат");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
