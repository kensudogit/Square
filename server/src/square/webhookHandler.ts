import type { Request, Response } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { isValidSquareSignature } from "./verifySignature.js";
import { looksLikeSquareEvent, type SquareWebhookEvent } from "./webhookTypes.js";
import { payments, webhookEvents } from "../db/repositories.js";
import { grantEntitlement, revokeEntitlement } from "../domain/entitlement.js";

/**
 * Square Webhook の受信。
 *
 * このルートは app.ts で express.raw() を使い、express.json() より前に登録している。
 * 署名は受信したバイト列そのものに対して計算されるため、
 * 一度パースしたものを再シリアライズすると絶対に一致しない。
 */
export async function squareWebhookHandler(req: Request, res: Response): Promise<void> {
  const rawBody = req.body as Buffer;

  if (!Buffer.isBuffer(rawBody)) {
    // ルート順序の設定ミス。ここに来たら express.json() が先に走っている
    logger.error({}, "webhook の body が Buffer ではありません。express.raw のルート順序を確認してください");
    res.status(500).end();
    return;
  }

  if (
    !isValidSquareSignature({
      rawBody,
      signatureHeader: req.header("x-square-hmacsha256-signature"),
      signatureKey: config.square.webhookSignatureKey,
      notificationUrl: config.square.webhookNotificationUrl,
    })
  ) {
    logger.warn({ ip: req.ip }, "square webhook: 署名が一致しません");
    res.status(403).end();
    return;
  }

  let event: SquareWebhookEvent;
  try {
    const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
    if (!looksLikeSquareEvent(parsed)) {
      res.status(400).end();
      return;
    }
    event = parsed;
  } catch {
    // 壊れた JSON は再送されても直らないので 4xx を返して打ち切る
    res.status(400).end();
    return;
  }

  // 受信を記録。同じ event_id で 2 回目以降は行が既に存在する
  const record = await webhookEvents.upsertReceived(event.event_id, event.type, event);

  // ★ 「処理まで完了している」ものだけスキップする。
  //   受信だけで判定すると、処理に失敗したイベントが再送時にスキップされ二度と処理されない
  if (record.processed_at) {
    logger.info({ eventId: event.event_id, type: event.type }, "処理済みイベントの再送を受信（冪等）");
    res.status(200).end();
    return;
  }

  try {
    await processSquareEvent(event);
    await webhookEvents.markProcessed(event.event_id);
    res.status(200).end();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await webhookEvents.markError(event.event_id, message);
    logger.error({ eventId: event.event_id, type: event.type, err: message }, "webhook 処理に失敗");
    // 500 を返すと Square が指数バックオフで再送する。それが自前のリトライ機構の代わりになる
    res.status(500).end();
  }
}

async function processSquareEvent(event: SquareWebhookEvent): Promise<void> {
  switch (event.type) {
    case "payment.created":
    case "payment.updated": {
      const payment = event.data.object.payment;
      if (!payment) return;

      // 決済作成時に referenceId へ orderRef を入れておいたので、ここで自分の注文に戻れる
      const orderRef = payment.reference_id ?? null;
      if (!orderRef) {
        logger.info({ paymentId: payment.id }, "reference_id が無い決済。処理をスキップ");
        return;
      }

      await payments.upsert({
        squarePaymentId: payment.id,
        orderRef,
        status: payment.status,
        amount: payment.amount_money?.amount ?? 0,
        currency: payment.amount_money?.currency ?? config.currency,
        cardBrand: payment.card_details?.card?.card_brand ?? null,
        cardLast4: payment.card_details?.card?.last_4 ?? null,
      }).catch((e) => {
        // 注文が存在しない（Dashboard のテストイベント等）場合は外部キーで落ちる。無視してよい
        logger.info({ orderRef, err: String(e) }, "payments の記録をスキップしました");
      });

      if (payment.status === "COMPLETED") {
        await grantEntitlement(orderRef); // ★ 同期経路とまったく同じ関数
      }
      return;
    }

    case "refund.created":
    case "refund.updated": {
      const refund = event.data.object.refund;
      if (!refund) return;

      // 返金は非同期に確定する。COMPLETED になって初めて剥奪する
      if (refund.status !== "COMPLETED") {
        logger.info({ refundId: refund.id, status: refund.status }, "返金が未確定のため剥奪しません");
        return;
      }

      const orderRef = await payments.findOrderRefByPaymentId(refund.payment_id);
      if (!orderRef) {
        logger.info({ paymentId: refund.payment_id }, "返金に対応する注文が見つかりません");
        return;
      }
      await revokeEntitlement(orderRef, refund.reason ?? "refund");
      return;
    }

    default:
      // 購読していないイベントが届いてもエラーにしない。500 を返すと無限に再送される
      logger.debug({ type: event.type }, "処理対象外のイベント");
      return;
  }
}
