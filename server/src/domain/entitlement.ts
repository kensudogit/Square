import { orders, entitlements } from "../db/repositories.js";
import { logger } from "../logger.js";

/**
 * 受講権限の付与・剥奪。
 *
 * ★ この 2 つの関数は「同期経路（決済 API のレスポンス）」と
 *   「非同期経路（Webhook）」の両方から呼ばれる。同時に呼ばれることもある。
 *
 *   同期経路は速いがネットワークで切れる。Webhook は確実だが遅い。
 *   両方走らせて、冪等性で衝突を吸収するのがこの設計の要。
 *   冪等性の実体は entitlements の unique(user_id, course_id) 制約。
 */

/**
 * 決済完了で権限を付与する。何回呼ばれても、同時に呼ばれても結果は同じ。
 * @returns 付与の対象になったか（未知の orderRef なら false）
 */
export async function grantEntitlement(orderRef: string): Promise<boolean> {
  const order = await orders.find(orderRef);

  if (!order) {
    // Dashboard から送られるテストイベントなど、身に覚えのない reference_id が来ることがある。
    // エラーにせず黙って無視する（エラーにすると Square が再送を繰り返す）
    logger.info({ orderRef }, "未知の orderRef。権限付与をスキップしました");
    return false;
  }

  await entitlements.grant({
    userId: order.user_id,
    courseId: order.course_id,
    orderRef: order.order_ref,
  });

  if (order.status !== "PAID") {
    await orders.setStatus(orderRef, "PAID");
  }

  logger.info(
    { orderRef, userId: order.user_id, courseId: order.course_id },
    "受講権限を付与しました",
  );
  return true;
}

/**
 * 返金確定で権限を剥奪する。付与と対称に冪等。
 *
 * ★ 返金 API のレスポンス直後ではなく、refund.updated が COMPLETED に
 *   なったときに呼ぶ。返金は非同期に確定するもので、API が 200 を返した
 *   時点ではまだ確定していない。
 */
export async function revokeEntitlement(orderRef: string, reason: string): Promise<boolean> {
  const revoked = await entitlements.revokeByOrderRef(orderRef);
  await orders.setStatus(orderRef, "REFUNDED", reason);

  if (revoked > 0) {
    logger.info({ orderRef, reason }, "受講権限を剥奪しました");
  } else {
    logger.info({ orderRef, reason }, "剥奪対象の有効な権限はありませんでした（冪等）");
  }
  return revoked > 0;
}
