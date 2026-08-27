import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { squareWebhookHandler } from "./square/webhookHandler.js";
import { authRouter } from "./routes/auth.js";
import { checkoutRouter } from "./routes/checkout.js";
import { paymentsRouter } from "./routes/payments.js";
import { coursesRouter } from "./routes/courses.js";
import { pool } from "./db/pool.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  // ========================================================================
  // ★ Webhook は express.json() より前に、express.raw() で登録する。
  //
  //   署名は受信したバイト列そのものに対して計算される。
  //   express.json() が先に走ると req.body がパース済みオブジェクトになり、
  //   再シリアライズしても署名は一致しない（Webhook が全件 403 になる原因の第1位）。
  //   この 3 行の位置を動かさないこと。
  // ========================================================================
  app.post(
    "/api/webhooks/square",
    express.raw({ type: "application/json", limit: "1mb" }),
    squareWebhookHandler,
  );

  // ------------------------------------------------------------------------
  // ここから下は通常の JSON API
  // ------------------------------------------------------------------------
  app.use(cors({ origin: config.corsOrigin, credentials: false }));
  app.use(express.json({ limit: "100kb" }));

  app.get("/healthz", async (_req: Request, res: Response) => {
    try {
      await pool.query("select 1");
      res.json({ ok: true, env: config.square.environment });
    } catch {
      res.status(503).json({ ok: false, error: "database_unavailable" });
    }
  });

  app.use("/api", authRouter);
  app.use("/api", coursesRouter);
  app.use("/api", checkoutRouter);
  app.use("/api", paymentsRouter);

  // ------------------------------------------------------------------------
  // ビルド済みフロントの配信（単一コンテナ構成）
  //
  // API と同じオリジンから返すので、フロント側の fetch は相対パス "/api/..." のまま動く。
  // 必ず API ルーターより後ろに置く。前に置くと /api/* が index.html に飲まれる。
  // ------------------------------------------------------------------------
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

  if (config.serveStatic && fs.existsSync(publicDir)) {
    app.use(
      express.static(publicDir, {
        // ハッシュ付きのアセットは長期キャッシュしてよいが、index.html はしない
        setHeaders: (res, filePath) => {
          if (filePath.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache");
          else res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        },
      }),
    );

    // SPA フォールバック。
    // Express 5 は path-to-regexp v8 になり "*" のようなパターンが使えないので、
    // ミドルウェアで判定する。API と Webhook は絶対に飲み込まない
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (req.path.startsWith("/api/") || req.path === "/healthz") return next();
      res.sendFile(path.join(publicDir, "index.html"));
    });
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  // Express 5 は async ハンドラの reject もここへ流す
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: err instanceof Error ? err.stack : String(err) }, "unhandled error");
    if (res.headersSent) return;
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
