import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { square, SQUARE_LOCATION_ID } from "../square/client.js";
import { orders, payments } from "../db/repositories.js";
import { grantEntitlement } from "../domain/entitlement.js";
import { closePool } from "../db/pool.js";

/**
 * 照合バッチ。
 *
 * Webhook はベストエフォート、同期経路も切れることがある。
 * 「PENDING のまま滞留している注文」を Square に問い合わせて突き合わせる。
 *
 * ★ このバッチが検出した件数はゼロであるべきで、ゼロでないなら
 *   Webhook か同期経路のどこかが壊れている。監視のメトリクスとして出す価値がある。
 *
 *   npm run reconcile
 */

const STALE_MINUTES = 15;
const ABANDON_AFTER_HOURS = 24;
const MAX_PAGES = 5;

export async function reconcilePendingOrders(): Promise<{ checked: number; recovered: number }> {
  const stale = await orders.findStalePending(STALE_MINUTES);
  if (stale.length === 0) {
    logger.info({ checked: 0, recovered: 0 }, "照合バッチ: 滞留している注文はありません");
    return { checked: 0, recovered: 0 };
  }

  logger.warn({ count: stale.length }, "照合バッチ: 滞留中の注文を検出しました");

  let recovered = 0;

  for (const order of stale) {
    // referenceId に orderRef を入れておいた効果がここで出る
    let found: { id?: string; status?: string; amountMoney?: { amount?: bigint | null; currency?: string } } | null =
      null;

    try {
      const page = await square.payments.list({
        locationId: SQUARE_LOCATION_ID,
        beginTime: new Date(order.created_at.getTime() - 60_000).toISOString(),
        limit: 100,
      });

      let pages = 0;
      outer: for (let p: typeof page | null = page; p; p = p.hasNextPage() ? await p.getNextPage() : null) {
        for (const payment of p.data) {
          if (payment.referenceId === order.order_ref) {
            found = payment;
            break outer;
          }
        }
        if (++pages >= MAX_PAGES) break;
      }
    } catch (e) {
      logger.error(
        { orderRef: order.order_ref, err: e instanceof Error ? e.message : String(e) },
        "照合バッチ: Square への問い合わせに失敗",
      );
      continue;
    }

    if (found?.status === "COMPLETED" && found.id) {
      logger.warn(
        { orderRef: order.order_ref, squarePaymentId: found.id },
        "照合バッチ: 決済完了を検出しました。同期経路と Webhook の両方が失敗しています",
      );
      await payments.upsert({
        squarePaymentId: found.id,
        orderRef: order.order_ref,
        status: found.status,
        amount: Number(found.amountMoney?.amount ?? 0n),
        currency: found.amountMoney?.currency ?? config.currency,
      });
      await grantEntitlement(order.order_ref);
      recovered += 1;
      continue;
    }

    const ageHours = (Date.now() - order.created_at.getTime()) / 3_600_000;
    if (!found && ageHours > ABANDON_AFTER_HOURS) {
      await orders.setStatus(order.order_ref, "ABANDONED", "reconcile: 決済が見つかりません");
      logger.info({ orderRef: order.order_ref }, "照合バッチ: 放棄された注文として記録しました");
    }
  }

  logger.info({ checked: stale.length, recovered }, "照合バッチ: 完了");
  return { checked: stale.length, recovered };
}

// 単体実行されたときだけ動かす（import された場合は動かさない）
const entry = process.argv[1];
const isMain = entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);

if (isMain) {
  reconcilePendingOrders()
    .catch((e) => {
      logger.error({ err: e instanceof Error ? e.message : String(e) }, "照合バッチが失敗しました");
      process.exitCode = 1;
    })
    .finally(closePool);
}
