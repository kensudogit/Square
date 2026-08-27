import type { NextFunction, Request, Response } from "express";
import { logger } from "../logger.js";

/**
 * 決済エンドポイント向けの簡易レート制限。
 *
 * ★ 決済 API を無防備に晒すと、盗難カードの有効性確認（カードテスティング）の
 *   踏み台にされる。Square 側でも検知されるが、まず自分で止める。
 *
 * このプロセス内のメモリで数えるだけなので、複数インスタンスで動かすなら
 * Redis 等の共有ストアに置き換えること。
 */

type Bucket = { count: number; resetAt: number };

export function rateLimit(options: {
  windowMs: number;
  max: number;
  keyOf?: (req: Request) => string;
}) {
  const buckets = new Map<string, Bucket>();
  const keyOf = options.keyOf ?? ((req: Request) => req.auth?.userId ?? req.ip ?? "unknown");

  // 放置するとメモリが増え続けるので定期的に掃除する
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  }, options.windowMs);
  timer.unref();

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    const key = keyOf(req);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > options.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      logger.warn({ key, count: bucket.count }, "レート制限に到達しました");
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "too_many_requests", retryAfter });
      return;
    }
    next();
  };
}
