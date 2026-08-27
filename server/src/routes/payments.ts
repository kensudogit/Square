import { Router, type Request, type Response } from "express";
import { Square } from "square";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { square, SQUARE_LOCATION_ID } from "../square/client.js";
import { classifySquareError } from "../square/errors.js";
import { withTransaction } from "../db/pool.js";
import { orders, payments, type OrderRow } from "../db/repositories.js";
import { grantEntitlement } from "../domain/entitlement.js";
import { idempotencyKeyFor, paymentAction } from "../domain/idempotency.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { rateLimit } from "../middleware/rateLimit.js";

export const paymentsRouter = Router();

/**
 * POST /api/payments
 *   { orderRef, sourceId, verificationToken }
 *
 * ★ 金額はリクエストから受け取らない。orderRef から DB を引く。
 *   amount を body で受けて payments.create に流す実装は、curl 一発で ¥1 決済を通される。
 */
paymentsRouter.post(
  "/payments",
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 10 }),
  async (req: Request, res: Response) => {
    if (!config.paymentsEnabled) {
      res.status(503).json({ error: "payments_disabled" });
      return;
    }

    const { orderRef, sourceId, verificationToken } = req.body as {
      orderRef?: string;
      sourceId?: string;
      verificationToken?: string;
    };

    if (!orderRef || !sourceId) {
      res.status(400).json({ error: "orderRef and sourceId are required" });
      return;
    }

    // --- 1. 注文を行ロックして取り出す -------------------------------------
    // ダブルクリックや再送が同時に来ても 1 つずつ処理される
    const prepared = await withTransaction(async (client) => {
      const order = await orders.findForUpdate(client, orderRef);
      if (!order) return { reject: { status: 404, body: { error: "order_not_found" } } };
      if (order.user_id !== req.auth!.userId) {
        // 他人の注文で決済できてしまう穴を塞ぐ。ここを忘れる実装が多い
        logger.warn({ orderRef, userId: req.auth!.userId }, "他ユーザーの注文への決済要求");
        return { reject: { status: 403, body: { error: "forbidden" } } };
      }

      switch (paymentAction(order.status)) {
        // 既に成功している注文への再送は、決済せずに同じ結果を返す
        case "already-paid":
          return { reject: { status: 200, body: { status: "COMPLETED", orderRef } } };
        case "refunded":
          return { reject: { status: 409, body: { error: "order_refunded" } } };
        // 前回が終局的に失敗した注文。冪等性キーの世代を進めてから再挑戦する。
        // これをしないと、否認されたカードの結果が Square 側に残り続け、
        // 別のカードに変えても永久に買えなくなる
        case "bump-then-proceed": {
          const attempt = await orders.bumpAttempt(client, orderRef);
          return { order: { ...order, attempt, status: "PENDING" as const } };
        }
        case "proceed":
          return { order };
      }
    });

    if ("reject" in prepared && prepared.reject) {
      res.status(prepared.reject.status).json(prepared.reject.body);
      return;
    }
    const order = (prepared as { order: OrderRow }).order;

    // --- 2. Square で決済を作成 --------------------------------------------
    const idempotencyKey = idempotencyKeyFor(order.order_ref, order.attempt);
    const startedAt = Date.now();

    try {
      const response = await square.payments.create({
        idempotencyKey,
        sourceId,
        ...(verificationToken ? { verificationToken } : {}),
        amountMoney: {
          // ★ DB の値。リクエストの値ではない。JPY は最小単位＝円そのもの
          amount: BigInt(order.amount),
          currency: order.currency as Square.Currency,
        },
        locationId: SQUARE_LOCATION_ID,
        referenceId: order.order_ref, // 40 文字以内。Webhook から自分の注文に戻る唯一の経路
        note: `course:${order.course_id}`.slice(0, 500),
        autocomplete: true, // 与信と売上確定を同時に行う。false にすると APPROVED 止まり
      });

      const payment = response.payment;
      if (!payment?.id) {
        logger.error({ orderRef, idempotencyKey }, "payments.create が payment を返しませんでした");
        res.status(502).json({ error: "payment_provider_error" });
        return;
      }

      await payments.upsert({
        squarePaymentId: payment.id,
        orderRef: order.order_ref,
        status: payment.status ?? "UNKNOWN",
        // ★ SDK では bigint。JSON.stringify は BigInt で例外を投げるので境界で Number に落とす
        amount: Number(payment.amountMoney?.amount ?? 0n),
        currency: payment.amountMoney?.currency ?? order.currency,
        cardBrand: payment.cardDetails?.card?.cardBrand ?? null,
        cardLast4: payment.cardDetails?.card?.last4 ?? null,
      });

      logger.info(
        {
          orderRef: order.order_ref,
          squarePaymentId: payment.id,
          status: payment.status,
          attempt: order.attempt,
          durationMs: Date.now() - startedAt,
        },
        "決済を作成しました",
      );

      if (payment.status === "COMPLETED") {
        await grantEntitlement(order.order_ref); // ★ Webhook とまったく同じ関数
        res.json({ status: "COMPLETED", orderRef: order.order_ref });
        return;
      }

      // APPROVED など。Webhook の確定を待つ
      res.json({ status: payment.status ?? "PENDING", orderRef: order.order_ref });
    } catch (e) {
      const classified = classifySquareError(e);

      logger.warn(
        {
          orderRef: order.order_ref,
          attempt: order.attempt,
          category: classified.category,
          code: classified.code,
          durationMs: Date.now() - startedAt,
        },
        "決済の作成に失敗しました",
      );

      if (classified.terminal) {
        // 次回の POST で attempt が進み、別のカードで再試行できるようになる
        await orders.setStatus(order.order_ref, "FAILED", classified.code);
      }
      // 終局的でない失敗は PENDING のまま。同じ冪等性キーで再送させ、Square に重複を吸収させる

      res.status(classified.httpStatus).json({
        error: classified.error,
        ...(classified.code ? { code: classified.code } : {}),
      });
    }
  },
);
