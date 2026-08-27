import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { courses, entitlements, orders } from "../db/repositories.js";
import { toMajorUnitString, formatAmount } from "../domain/money.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { rateLimit } from "../middleware/rateLimit.js";

export const checkoutRouter = Router();

/**
 * POST /api/checkout/intent  { courseId }
 *
 * 決済を Square に依頼する「前」に、サーバーが金額を確定して注文レコードを作る。
 *
 * ★ orderRef を先に発行するのが要。payment.id を待ってから注文を作ると、
 *   その待ち時間が丸ごと事故の窓になる（課金されたのに自分側に記録が無い状態）。
 */
checkoutRouter.post(
  "/checkout/intent",
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 20 }),
  async (req: Request, res: Response) => {
    if (!config.paymentsEnabled) {
      res.status(503).json({ error: "payments_disabled" });
      return;
    }

    const { courseId } = req.body as { courseId?: string };
    if (!courseId) {
      res.status(400).json({ error: "courseId is required" });
      return;
    }

    const course = await courses.findPurchasable(courseId);
    if (!course) {
      res.status(404).json({ error: "course_not_found" });
      return;
    }

    // 既に持っているものを二重に買わせない
    if (await entitlements.exists(req.auth!.userId, courseId)) {
      res.status(409).json({ error: "already_enrolled" });
      return;
    }

    const orderRef = randomUUID();
    await orders.insert({
      orderRef,
      userId: req.auth!.userId,
      courseId,
      amount: course.price_minor_units, // ★ 金額の唯一の出所
      currency: course.currency,
    });

    res.json({
      orderRef,
      courseId: course.id,
      courseTitle: course.title,
      // 表示用（最小単位の整数）
      amount: course.price_minor_units,
      amountLabel: formatAmount(course.price_minor_units, course.currency),
      // verifyBuyer 用（主単位の文字列）。★ クライアントに単位変換をさせない
      verificationAmount: toMajorUnitString(course.price_minor_units, course.currency),
      currency: course.currency,
    });
  },
);
