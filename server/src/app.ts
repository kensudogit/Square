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
