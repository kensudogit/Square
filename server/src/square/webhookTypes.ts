/**
 * Webhook のペイロード型。
 *
 * ★ Webhook の JSON は snake_case。SDK のレスポンスは camelCase。
 *   同じ payment を扱うのに表記が違うので、型を分けて定義する。
 *   共通の型で扱おうとすると実行時に undefined が出る。
 *
 * ★ amount_money.amount は Webhook では素の number。SDK 経由だと bigint。
 *   同じ値が経路によって別の型で来るので、DB に入れる前に必ず正規化する。
 */

export type WebhookMoney = {
  amount?: number;
  currency?: string;
};

export type WebhookPayment = {
  id: string;
  status: "APPROVED" | "COMPLETED" | "CANCELED" | "FAILED" | string;
  /** 決済作成時に referenceId として渡した orderRef */
  reference_id?: string | null;
  order_id?: string | null;
  location_id?: string;
  amount_money?: WebhookMoney;
  card_details?: {
    card?: { card_brand?: string; last_4?: string };
  };
  created_at?: string;
  updated_at?: string;
};

export type WebhookRefund = {
  id: string;
  status: "PENDING" | "COMPLETED" | "REJECTED" | "FAILED" | string;
  payment_id: string;
  amount_money?: WebhookMoney;
  reason?: string;
};

export type SquareWebhookEvent = {
  merchant_id: string;
  type: string;
  event_id: string;
  created_at: string;
  data: {
    type: string;
    id: string;
    object: {
      payment?: WebhookPayment;
      refund?: WebhookRefund;
    };
  };
};

/** 最低限の形をしているかだけ見る。詳細な検証は各ハンドラで行う */
export function looksLikeSquareEvent(value: unknown): value is SquareWebhookEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.event_id === "string" && typeof v.type === "string" && typeof v.data === "object";
}
