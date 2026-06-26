import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";

// Для работы с __dirname в ES-модулях
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Express = express();

// Логирование
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ==============================================
// 1. Раздача статики из собранного фронтенда
// ==============================================
// Путь к собранному фронтенду (mockup-sandbox/dist)
// Корень проекта = /opt/render/project/src, мы находимся в artifacts/api-server/dist
// Поэтому поднимаемся на два уровня вверх и заходим в mockup-sandbox/dist
const staticPath = path.join(__dirname, "../../../mockup-sandbox/dist");
// Если папка не существует, статика не будет подключена, но мы можем проверить.
app.use(express.static(staticPath));

// ==============================================
// 2. API-маршруты
// ==============================================
app.use("/api", router);

// ==============================================
// 3. Обработка SPA (все GET-запросы, не начинающиеся с /api)
// ==============================================
app.get("*", (req, res, next) => {
  // Если запрос начинается с /api – пропускаем (они уже обработаны выше)
  if (req.path.startsWith("/api")) {
    return next();
  }
  // Отдаём index.html для всех остальных GET-запросов (поддержка роутинга на клиенте)
  res.sendFile(path.join(staticPath, "index.html"), (err) => {
    if (err) {
      // Если index.html не найден – возвращаем 404
      res.status(404).json({ error: "Frontend not built" });
    }
  });
});

// ==============================================
// 4. Обработчик 404 для API (если не найден маршрут)
// ==============================================
app.use("/api/*", (req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
});

// ==============================================
// 5. Централизованный обработчик ошибок
// ==============================================
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error(err.stack || err.message);
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
  });
});

export default app;
