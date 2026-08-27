import type { OrderStatus } from "../db/repositories.js";

/**
 * 冪等性キーの世代管理。
 *
 * ★ ここを間違えると、二重課金するか、カード変更での再購入ができなくなる。
 *
 *   ダブルクリック・タイムアウト後の再送 … 同じキー
 *       → Square が前回の結果をそのまま返すので二重課金しない
 *   カード否認のあと別のカードで再試行 … 新しいキー
 *       → 同じキーだと前回の「否認」が返り続け、永久に買えない
 *
 * これを `${orderRef}:${attempt}` で表現し、attempt を進めるのは
 * 「終局的な失敗（カード側の理由）」と判定したときだけにする。
 */

/** Square の idempotency_key の上限 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 45;

export function idempotencyKeyFor(orderRef: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`attempt は 1 以上の整数。受け取った値: ${attempt}`);
  }
  const key = `${orderRef}:${attempt}`;
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    // UUID v4(36) + ":" + 数字 なら収まる。orderRef の生成方法を変えたときの保険
    throw new Error(
      `冪等性キーが ${IDEMPOTENCY_KEY_MAX_LENGTH} 文字を超えました (${key.length}): ${key}`,
    );
  }
  return key;
}

/**
 * 決済を再度実行してよい状態か。
 * PAID は再実行せずに前回の結果を返し、REFUNDED は拒否する。
 */
export function paymentAction(
  status: OrderStatus,
): "proceed" | "bump-then-proceed" | "already-paid" | "refunded" {
  switch (status) {
    case "PENDING":
    case "ABANDONED":
      return "proceed";
    case "FAILED":
      // 終局的に失敗した注文。世代を進めてから再挑戦する
      return "bump-then-proceed";
    case "PAID":
      return "already-paid";
    case "REFUNDED":
      return "refunded";
  }
}
