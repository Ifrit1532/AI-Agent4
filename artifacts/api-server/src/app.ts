import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==============================================
// НОВЫЙ ОБРАБОТЧИК ДЛЯ КОРНЕВОГО ПУТИ
// ==============================================
app.get("/", (req, res) => {
  res.json({
    message: "AI Agent API is running",
    version: "1.0.0",
    endpoints: {
      api: "/api",
      // можно добавить список доступных эндпоинтов, если знаете
    },
  });
});

// Подключение основных API-маршрутов
app.use("/api", router);

// ==============================================
// ОБРАБОТЧИК 404 ДЛЯ НЕСУЩЕСТВУЮЩИХ МАРШРУТОВ
// ==============================================
app.use((req, res) => {
  res.status(404).json({ error: "Not Found" });
});

// ==============================================
// ЦЕНТРАЛИЗОВАННЫЙ ОБРАБОТЧИК ОШИБОК (опционально)
// ==============================================
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error(err.stack || err.message);
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
  });
});

export default app;
