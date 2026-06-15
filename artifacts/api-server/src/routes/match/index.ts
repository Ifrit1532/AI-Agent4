import { Router, type IRouter } from "express";
import multer from "multer";
import { matchPricesSSE } from "../../lib/aiMatcher";
import { parsePriceList, parseOrderList, buildExcelFromResult } from "../../lib/fileParser";
import { logger } from "../../lib/logger";
import type { MatchResult } from "../../lib/aiMatcher";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
});

// In-memory store for download results
const downloadStore = new Map<string, Buffer>();

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// POST /match — upload files, stream SSE progress, final result
router.post(
  "/match",
  upload.fields([{ name: "priceFile", maxCount: 1 }, { name: "orderFile", maxCount: 1 }]),
  async (req, res): Promise<void> => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;

    if (!files?.priceFile?.[0] || !files?.orderFile?.[0]) {
      res.status(400).json({ error: "Необходимо загрузить оба файла: priceFile и orderFile" });
      return;
    }

    // Set up SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const priceBuffer = files.priceFile[0].buffer;
    const orderBuffer = files.orderFile[0].buffer;

    send("status", { message: "Читаем файлы..." });

    let priceData: ReturnType<typeof parsePriceList>;
    let orderItems: ReturnType<typeof parseOrderList>;

    try {
      priceData = parsePriceList(priceBuffer);
      orderItems = parseOrderList(orderBuffer);
    } catch (err) {
      req.log.error({ err }, "Failed to parse files");
      send("error", { error: "Не удалось прочитать файлы. Убедитесь, что файлы в формате Excel или CSV." });
      res.end();
      return;
    }

    if (priceData.items.length === 0) {
      send("error", { error: "Прайс-лист пуст или не удалось распознать данные." });
      res.end();
      return;
    }

    if (orderItems.length === 0) {
      send("error", { error: "Список товаров пуст или не удалось распознать данные." });
      res.end();
      return;
    }

    req.log.info(
      { priceItemCount: priceData.items.length, orderItemCount: orderItems.length },
      "Files parsed"
    );

    send("status", {
      message: `Найдено ${orderItems.length} позиций. Начинаем подбор цен...`,
      priceCount: priceData.items.length,
      orderCount: orderItems.length,
    });

    try {
      const result = await matchPricesSSE(
        orderItems,
        priceData.items,
        priceData.currency,
        (batchIndex, totalBatches, batchSize) => {
          send("progress", {
            batchIndex,
            totalBatches,
            batchSize,
            processed: Math.min(batchIndex * batchSize, orderItems.length),
            total: orderItems.length,
          });
        }
      );

      send("result", result);
      res.end();
    } catch (err) {
      req.log.error({ err }, "AI matching failed");
      send("error", { error: "Ошибка ИИ при сопоставлении данных. Попробуйте ещё раз." });
      res.end();
    }
  }
);

// POST /match/download — generate Excel, return downloadId
router.post("/match/download", async (req, res): Promise<void> => {
  const body = req.body as MatchResult & { items?: unknown[] };

  if (!body?.items || !Array.isArray(body.items)) {
    res.status(400).json({ error: "Некорректные данные для формирования файла" });
    return;
  }

  try {
    const buffer = buildExcelFromResult(body as Parameters<typeof buildExcelFromResult>[0]);
    const downloadId = generateId();
    downloadStore.set(downloadId, buffer);

    // Auto-cleanup after 10 minutes
    setTimeout(() => downloadStore.delete(downloadId), 10 * 60 * 1000);

    res.json({ downloadId });
  } catch (err) {
    req.log.error({ err }, "Failed to build Excel");
    res.status(500).json({ error: "Не удалось сформировать файл Excel" });
  }
});

// GET /match/download/:id — stream the Excel file
router.get("/match/download/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const buffer = downloadStore.get(raw);

  if (!buffer) {
    res.status(404).json({ error: "Файл не найден или истёк срок его хранения" });
    return;
  }

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''%D1%80%D0%B5%D0%B7%D1%83%D0%BB%D1%8C%D1%82%D0%B0%D1%82.xlsx");
  res.send(buffer);
});

export default router;
