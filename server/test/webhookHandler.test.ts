import crypto from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Request, Response } from "express";
import { repositories } from "./helpers/mocks.js";

vi.mock("../src/db/repositories.js", async () => (await import("./helpers/mocks.js")).repositories);

const { squareWebhookHandler } = await import("../src/square/webhookHandler.js");
const { config } = await import("../src/config.js");

const { payments, webhookEvents, orders, entitlements } = repositories;

/**
 * Webhook の受信経路。
 *
 * ★ 検証したいのは 4 点。
 *   1. 署名が無い / 合わないリクエストは絶対に処理しない
 *   2. 同じ event_id の再送で二重に権限を付けない
 *   3. ただし「受信済みだが未処理」のイベントは再送で処理される
 *   4. 処理に失敗したら 500 を返す（Square の再送に乗せる）
 */

function sign(rawBody: Buffer): string {
  return crypto
    .createHmac("sha256", config.square.webhookSignatureKey)
    .update(config.square.webhookNotificationUrl)
    .update(rawBody)
    .digest("base64");
}

function makeRes() {
  const res = {
    statusCode: 200,
    ended: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return res;
}

async function post(
  body: unknown,
  options: { signature?: string | null; raw?: Buffer } = {},
): Promise<ReturnType<typeof makeRes>> {
  const rawBody = options.raw ?? Buffer.from(JSON.stringify(body), "utf8");
  const signature =
    options.signature === null ? undefined : (options.signature ?? sign(rawBody));

  const req = {
    body: rawBody,
    ip: "203.0.113.1",
    header: (name: string) =>
      name.toLowerCase() === "x-square-hmacsha256-signature" ? signature : undefined,
  } as unknown as Request;

  const res = makeRes();
  await squareWebhookHandler(req, res as unknown as Response);
  return res;
}

function paymentEvent(overrides: Record<string, unknown> = {}) {
  return {
    merchant_id: "M1",
    type: "payment.updated",
    event_id: "evt_payment_1",
    created_at: "2026-01-01T00:00:00Z",
    data: {
      type: "payment",
      id: "sqpay_1",
      object: {
        payment: {
          id: "sqpay_1",
          status: "COMPLETED",
          reference_id: "order-1",
          amount_money: { amount: 12000, currency: "JPY" },
          card_details: { card: { card_brand: "VISA", last_4: "1111" } },
          ...overrides,
        },
      },
    },
  };
}

function refundEvent(overrides: Record<string, unknown> = {}) {
  return {
    merchant_id: "M1",
    type: "refund.updated",
    event_id: "evt_refund_1",
    created_at: "2026-01-01T00:00:00Z",
    data: {
      type: "refund",
      id: "sqref_1",
      object: {
        refund: {
          id: "sqref_1",
          status: "COMPLETED",
          payment_id: "sqpay_1",
          amount_money: { amount: 12000, currency: "JPY" },
          reason: "requested_by_customer",
          ...overrides,
        },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  webhookEvents.upsertReceived.mockResolvedValue({
    event_id: "evt_payment_1",
    type: "payment.updated",
    received_at: new Date(),
    processed_at: null,
    attempts: 1,
  });
  webhookEvents.markProcessed.mockResolvedValue(undefined);
  webhookEvents.markError.mockResolvedValue(undefined);
  payments.upsert.mockResolvedValue(undefined);
  payments.findOrderRefByPaymentId.mockResolvedValue("order-1");
  orders.find.mockResolvedValue({
    order_ref: "order-1",
    user_id: "u1",
    course_id: "course-basic",
    amount: 12000,
    currency: "JPY",
    status: "PENDING",
    attempt: 1,
    last_error: null,
    created_at: new Date(),
  });
  orders.setStatus.mockResolvedValue(undefined);
  entitlements.grant.mockResolvedValue(undefined);
  entitlements.revokeByOrderRef.mockResolvedValue(1);
});

// ---------------------------------------------------------------- 署名

describe("署名の検証", () => {
  test("正しい署名なら 200 で処理される", async () => {
    const res = await post(paymentEvent());
    expect(res.statusCode).toBe(200);
    expect(webhookEvents.markProcessed).toHaveBeenCalledWith("evt_payment_1");
  });

  // ★ 「署名ヘッダが無ければ検証をスキップ」は正常系のテストでは絶対に見つからない
  test("署名ヘッダが無ければ 403 で、DB には一切触らない", async () => {
    const res = await post(paymentEvent(), { signature: null });
    expect(res.statusCode).toBe(403);
    expect(webhookEvents.upsertReceived).not.toHaveBeenCalled();
    expect(entitlements.grant).not.toHaveBeenCalled();
  });

  test("署名が一致しなければ 403", async () => {
    const res = await post(paymentEvent(), { signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    expect(res.statusCode).toBe(403);
    expect(entitlements.grant).not.toHaveBeenCalled();
  });

  test("ボディを改竄すると 403（署名は生のバイト列に対して計算される）", async () => {
    const original = Buffer.from(JSON.stringify(paymentEvent()), "utf8");
    const tampered = Buffer.from(original.toString("utf8").replace("12000", "1"), "utf8");
    const res = await post(null, { raw: tampered, signature: sign(original) });
    expect(res.statusCode).toBe(403);
  });

  // ★ app.ts で express.json() を先に登録してしまったときの症状。
  //   Webhook が全件 403 になる原因の第 1 位なので、500 で明確に落とす
  test("body が Buffer でなければ 500（express.raw のルート順序ミス）", async () => {
    const req = {
      body: { event_id: "evt_1" },
      header: () => "signature",
    } as unknown as Request;
    const res = makeRes();
    await squareWebhookHandler(req, res as unknown as Response);
    expect(res.statusCode).toBe(500);
    expect(webhookEvents.upsertReceived).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- ペイロード

describe("ペイロードの検証", () => {
  test("壊れた JSON は 400 で打ち切る（再送されても直らない）", async () => {
    const raw = Buffer.from("{ this is not json", "utf8");
    const res = await post(null, { raw, signature: sign(raw) });
    expect(res.statusCode).toBe(400);
    expect(webhookEvents.upsertReceived).not.toHaveBeenCalled();
  });

  test("Square のイベントの形をしていなければ 400", async () => {
    const res = await post({ hello: "world" });
    expect(res.statusCode).toBe(400);
    expect(webhookEvents.upsertReceived).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- 冪等性

describe("冪等性", () => {
  test("処理済みイベントの再送はスキップして 200", async () => {
    webhookEvents.upsertReceived.mockResolvedValue({
      event_id: "evt_payment_1",
      type: "payment.updated",
      received_at: new Date(),
      processed_at: new Date(), // 前回処理済み
      attempts: 2,
    });

    const res = await post(paymentEvent());

    expect(res.statusCode).toBe(200);
    expect(entitlements.grant).not.toHaveBeenCalled();
    expect(webhookEvents.markProcessed).not.toHaveBeenCalled();
  });

  // ★ 「受信したか」ではなく「処理し終えたか」で判定していることの検証。
  //   受信だけで重複排除すると、失敗したイベントが二度と処理されなくなる
  test("受信済みだが未処理のイベントは再送で処理される", async () => {
    webhookEvents.upsertReceived.mockResolvedValue({
      event_id: "evt_payment_1",
      type: "payment.updated",
      received_at: new Date(),
      processed_at: null, // 前回失敗している
      attempts: 3,
    });

    const res = await post(paymentEvent());

    expect(res.statusCode).toBe(200);
    expect(entitlements.grant).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- payment イベント

describe("payment イベント", () => {
  test("COMPLETED で決済を記録し、受講権限を付与する", async () => {
    await post(paymentEvent());

    expect(payments.upsert).toHaveBeenCalledWith({
      squarePaymentId: "sqpay_1",
      orderRef: "order-1",
      status: "COMPLETED",
      amount: 12000,
      currency: "JPY",
      cardBrand: "VISA",
      cardLast4: "1111",
    });
    expect(entitlements.grant).toHaveBeenCalledTimes(1);
  });

  test("APPROVED では権限を付与しない（売上確定していない）", async () => {
    await post(paymentEvent({ status: "APPROVED" }));

    expect(payments.upsert).toHaveBeenCalledTimes(1);
    expect(entitlements.grant).not.toHaveBeenCalled();
  });

  test("payment.created も同じ経路で扱う", async () => {
    const event = paymentEvent();
    event.type = "payment.created";
    await post(event);
    expect(entitlements.grant).toHaveBeenCalledTimes(1);
  });

  test("reference_id が無い決済はスキップする（自分の注文に紐付かない）", async () => {
    await post(paymentEvent({ reference_id: null }));

    expect(payments.upsert).not.toHaveBeenCalled();
    expect(entitlements.grant).not.toHaveBeenCalled();
  });

  test("金額や通貨が欠けていても既定値で記録する", async () => {
    await post(paymentEvent({ amount_money: undefined, card_details: undefined }));

    expect(payments.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 0, currency: config.currency, cardBrand: null, cardLast4: null }),
    );
  });

  // ★ Dashboard のテストイベントは自分の DB に存在しない注文を指す。
  //   外部キー違反で 500 を返すと Square が延々と再送してくる
  test("payments の記録に失敗しても処理は続き、権限付与まで進む", async () => {
    payments.upsert.mockRejectedValue(new Error("foreign key violation"));

    const res = await post(paymentEvent());

    expect(res.statusCode).toBe(200);
    expect(entitlements.grant).toHaveBeenCalledTimes(1);
  });

  test("payment が入っていないイベントは何もせず 200", async () => {
    const event = paymentEvent();
    event.data.object = {} as typeof event.data.object;
    const res = await post(event);
    expect(res.statusCode).toBe(200);
    expect(payments.upsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- refund イベント

describe("refund イベント", () => {
  test("COMPLETED の返金で受講権限を剥奪する", async () => {
    const res = await post(refundEvent());

    expect(res.statusCode).toBe(200);
    expect(payments.findOrderRefByPaymentId).toHaveBeenCalledWith("sqpay_1");
    expect(entitlements.revokeByOrderRef).toHaveBeenCalledWith("order-1");
    expect(orders.setStatus).toHaveBeenCalledWith("order-1", "REFUNDED", "requested_by_customer");
  });

  // ★ 返金は非同期に確定する。PENDING で剥奪すると、返金が失敗したときに
  //   支払い済みの人の受講権限だけが消える
  test("PENDING の返金では剥奪しない", async () => {
    await post(refundEvent({ status: "PENDING" }));
    expect(entitlements.revokeByOrderRef).not.toHaveBeenCalled();
  });

  test("REJECTED の返金でも剥奪しない", async () => {
    await post(refundEvent({ status: "REJECTED" }));
    expect(entitlements.revokeByOrderRef).not.toHaveBeenCalled();
  });

  test("対応する注文が見つからなければ何もせず 200", async () => {
    payments.findOrderRefByPaymentId.mockResolvedValue(null);

    const res = await post(refundEvent());

    expect(res.statusCode).toBe(200);
    expect(entitlements.revokeByOrderRef).not.toHaveBeenCalled();
  });

  test("reason が無ければ既定の理由で記録する", async () => {
    await post(refundEvent({ reason: undefined }));
    expect(orders.setStatus).toHaveBeenCalledWith("order-1", "REFUNDED", "refund");
  });

  test("refund が入っていないイベントは何もせず 200", async () => {
    const event = refundEvent();
    event.data.object = {} as typeof event.data.object;
    const res = await post(event);
    expect(res.statusCode).toBe(200);
    expect(entitlements.revokeByOrderRef).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- その他

describe("その他のイベントと失敗", () => {
  test("購読していない種類のイベントも 200 で受け流す（500 だと無限に再送される）", async () => {
    const event = paymentEvent();
    event.type = "customer.created";
    const res = await post(event);

    expect(res.statusCode).toBe(200);
    expect(webhookEvents.markProcessed).toHaveBeenCalled();
  });

  // ★ 500 を返すと Square が指数バックオフで再送する。それが自前のリトライ機構の代わり
  test("処理中の例外は記録して 500 を返す", async () => {
    entitlements.grant.mockRejectedValue(new Error("db down"));

    const res = await post(paymentEvent());

    expect(res.statusCode).toBe(500);
    expect(webhookEvents.markError).toHaveBeenCalledWith("evt_payment_1", "db down");
    expect(webhookEvents.markProcessed).not.toHaveBeenCalled();
  });

  test("Error でない値が投げられても記録できる", async () => {
    entitlements.grant.mockRejectedValue("文字列で投げられた");

    const res = await post(paymentEvent());

    expect(res.statusCode).toBe(500);
    expect(webhookEvents.markError).toHaveBeenCalledWith("evt_payment_1", "文字列で投げられた");
  });
});
