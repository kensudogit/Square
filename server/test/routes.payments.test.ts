import { beforeEach, describe, expect, test, vi } from "vitest";
import request from "supertest";
import { SquareError } from "square";
import { makeOrder, makeSquarePayment, repositories, squareClient, useFreshRateLimitWindow } from "./helpers/mocks.js";

vi.mock("../src/db/repositories.js", async () => (await import("./helpers/mocks.js")).repositories);
vi.mock("../src/db/pool.js", async () => (await import("./helpers/mocks.js")).poolModule);
vi.mock("../src/square/client.js", async () => (await import("./helpers/mocks.js")).squareClient);

const { createApp } = await import("../src/app.js");
const { issueToken } = await import("../src/middleware/requireAuth.js");
const { config } = await import("../src/config.js");

const { orders, payments, entitlements } = repositories;
const squarePayments = squareClient.square.payments;

/**
 * 決済の本体。ここで守りたい不変条件は 4 つ。
 *
 *   1. 金額はリクエストではなく DB から取る
 *   2. 他人の注文では決済できない
 *   3. 同じ注文への再送で二重課金しない（冪等性キーを据え置く）
 *   4. 終局的に失敗した注文だけ世代を進める（別カードで再試行できる）
 */

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_REF = "22222222-2222-4222-8222-222222222222";
const TOKEN = issueToken({ userId: USER_ID, email: "buyer@example.test" });

let app: ReturnType<typeof createApp>;

function post(body: object, token = TOKEN) {
  return request(app).post("/api/payments").set("Authorization", `Bearer ${token}`).send(body);
}

function validBody(overrides: Record<string, unknown> = {}) {
  return { orderRef: ORDER_REF, sourceId: "cnon:card-nonce-ok", ...overrides };
}

function squareError(category: string, code: string, statusCode = 400) {
  return new SquareError({ statusCode, body: { errors: [{ category, code }] } });
}

useFreshRateLimitWindow();

beforeEach(() => {
  vi.clearAllMocks();
  app = createApp();
  orders.findForUpdate.mockResolvedValue(makeOrder());
  orders.bumpAttempt.mockResolvedValue(2);
  orders.setStatus.mockResolvedValue(undefined);
  orders.find.mockResolvedValue(makeOrder({ status: "PENDING" }));
  payments.upsert.mockResolvedValue(undefined);
  entitlements.grant.mockResolvedValue(undefined);
  squarePayments.create.mockResolvedValue({ payment: makeSquarePayment() });
});

// ---------------------------------------------------------------- 正常系

describe("成功する決済", () => {
  test("COMPLETED なら受講権限を付与して COMPLETED を返す", async () => {
    const res = await post(validBody());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "COMPLETED", orderRef: ORDER_REF });
    expect(entitlements.grant).toHaveBeenCalledTimes(1);
  });

  // ★ amount を body で受けて Square に流す実装は curl 一発で ¥1 決済を通される
  test("金額は DB の値。リクエストの amount は無視される", async () => {
    await post(validBody({ amount: 1, amountMoney: { amount: 1, currency: "JPY" } }));

    expect(squarePayments.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amountMoney: { amount: 12000n, currency: "JPY" },
        locationId: "LTESTLOCATION",
        referenceId: ORDER_REF, // Webhook から自分の注文に戻る唯一の経路
        autocomplete: true,
      }),
    );
  });

  test("冪等性キーは orderRef:attempt", async () => {
    await post(validBody());
    expect(squarePayments.create).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `${ORDER_REF}:1` }),
    );
  });

  test("3DS の verificationToken は渡されたときだけ含める", async () => {
    await post(validBody({ verificationToken: "verf_abc" }));
    expect(squarePayments.create).toHaveBeenCalledWith(
      expect.objectContaining({ verificationToken: "verf_abc" }),
    );

    squarePayments.create.mockClear();
    await post(validBody());
    expect(squarePayments.create.mock.calls[0]?.[0]).not.toHaveProperty("verificationToken");
  });

  test("決済内容を DB に記録する（bigint は number に落とす）", async () => {
    await post(validBody());

    expect(payments.upsert).toHaveBeenCalledWith({
      squarePaymentId: "sqpay_completed_1",
      orderRef: ORDER_REF,
      status: "COMPLETED",
      amount: 12000,
      currency: "JPY",
      cardBrand: "VISA",
      cardLast4: "1111",
    });
  });

  // ★ autocomplete でも APPROVED で返ることがある。ここで権限を付けると
  //   売上確定していないのに受講できてしまう
  test("APPROVED では権限を付与せず、そのまま状態を返す", async () => {
    squarePayments.create.mockResolvedValue({
      payment: makeSquarePayment({ status: "APPROVED" }),
    });

    const res = await post(validBody());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "APPROVED", orderRef: ORDER_REF });
    expect(entitlements.grant).not.toHaveBeenCalled();
  });

  test("status が無い応答は PENDING として返す", async () => {
    squarePayments.create.mockResolvedValue({
      payment: makeSquarePayment({ status: undefined, cardDetails: undefined, amountMoney: undefined }),
    });

    const res = await post(validBody());

    expect(res.body.status).toBe("PENDING");
    expect(payments.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: "UNKNOWN", amount: 0, currency: "JPY", cardBrand: null }),
    );
  });

  test("payment が返らなければ 502", async () => {
    squarePayments.create.mockResolvedValue({ payment: undefined });

    const res = await post(validBody());

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "payment_provider_error" });
    expect(entitlements.grant).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- 入口の検証

describe("入口の検証", () => {
  test("orderRef / sourceId が無ければ 400", async () => {
    expect((await post({ sourceId: "cnon:x" })).status).toBe(400);
    expect((await post({ orderRef: ORDER_REF })).status).toBe(400);
    expect(squarePayments.create).not.toHaveBeenCalled();
  });

  test("未ログインなら 401", async () => {
    const res = await request(app).post("/api/payments").send(validBody());
    expect(res.status).toBe(401);
    expect(squarePayments.create).not.toHaveBeenCalled();
  });

  test("存在しない注文は 404", async () => {
    orders.findForUpdate.mockResolvedValue(null);

    const res = await post(validBody());

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "order_not_found" });
    expect(squarePayments.create).not.toHaveBeenCalled();
  });

  // ★ 忘れられがちな穴。他人の orderRef を投げれば決済できてしまう
  test("他人の注文への決済は 403", async () => {
    orders.findForUpdate.mockResolvedValue(makeOrder({ user_id: "someone-else" }));

    const res = await post(validBody());

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
    expect(squarePayments.create).not.toHaveBeenCalled();
  });

  test("PAYMENTS_ENABLED=false なら 503", async () => {
    const mutable = config as unknown as { paymentsEnabled: boolean };
    const original = mutable.paymentsEnabled;
    mutable.paymentsEnabled = false;
    try {
      const res = await post(validBody());
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "payments_disabled" });
      expect(squarePayments.create).not.toHaveBeenCalled();
    } finally {
      mutable.paymentsEnabled = original;
    }
  });

  test("呼びすぎるとレート制限がかかる（カードテスティング対策）", async () => {
    let lastStatus = 0;
    for (let i = 0; i < 12; i += 1) lastStatus = (await post(validBody())).status;
    expect(lastStatus).toBe(429);
  });
});

// ---------------------------------------------------------------- 冪等性

describe("注文の状態による分岐", () => {
  // ★ ダブルクリックやタイムアウト後の再送。決済せずに前回の結果を返す
  test("PAID の注文は決済せずに COMPLETED を返す", async () => {
    orders.findForUpdate.mockResolvedValue(makeOrder({ status: "PAID" }));

    const res = await post(validBody());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "COMPLETED", orderRef: ORDER_REF });
    expect(squarePayments.create).not.toHaveBeenCalled();
  });

  test("返金済みの注文は 409", async () => {
    orders.findForUpdate.mockResolvedValue(makeOrder({ status: "REFUNDED" }));

    const res = await post(validBody());

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "order_refunded" });
    expect(squarePayments.create).not.toHaveBeenCalled();
  });

  // ★ 世代を進めないと、否認された結果が Square 側に残り続けて
  //   別のカードに変えても永久に買えなくなる
  test("FAILED の注文は世代を進めてから再挑戦する", async () => {
    orders.findForUpdate.mockResolvedValue(makeOrder({ status: "FAILED", attempt: 1 }));
    orders.bumpAttempt.mockResolvedValue(2);

    await post(validBody());

    expect(orders.bumpAttempt).toHaveBeenCalledTimes(1);
    expect(squarePayments.create).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `${ORDER_REF}:2` }),
    );
  });

  test("ABANDONED の注文はそのまま決済できる", async () => {
    orders.findForUpdate.mockResolvedValue(makeOrder({ status: "ABANDONED" }));

    await post(validBody());

    expect(orders.bumpAttempt).not.toHaveBeenCalled();
    expect(squarePayments.create).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `${ORDER_REF}:1` }),
    );
  });
});

// ---------------------------------------------------------------- 失敗系

describe("Square の失敗の扱い", () => {
  test("カード否認は 402 を返し、注文を FAILED にする", async () => {
    squarePayments.create.mockRejectedValue(
      squareError("PAYMENT_METHOD_ERROR", "CARD_DECLINED", 402),
    );

    const res = await post(validBody());

    expect(res.status).toBe(402);
    expect(res.body).toEqual({ error: "payment_declined", code: "CARD_DECLINED" });
    // 次回の POST で attempt が進み、別のカードで再試行できる
    expect(orders.setStatus).toHaveBeenCalledWith(ORDER_REF, "FAILED", "CARD_DECLINED");
    expect(entitlements.grant).not.toHaveBeenCalled();
  });

  // ★ ここを FAILED にすると、成功しているかもしれない決済に
  //   新しい冪等性キーで再挑戦して二重課金する
  test("Square 側の障害では注文を FAILED にしない（PENDING のまま再送させる）", async () => {
    squarePayments.create.mockRejectedValue(squareError("API_ERROR", "INTERNAL_SERVER_ERROR", 500));

    const res = await post(validBody());

    expect(res.status).toBe(502);
    expect(orders.setStatus).not.toHaveBeenCalled();
  });

  test("ネットワークエラーでも注文を FAILED にしない", async () => {
    squarePayments.create.mockRejectedValue(new Error("socket hang up"));

    const res = await post(validBody());

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal_error" });
    expect(orders.setStatus).not.toHaveBeenCalled();
  });

  test("レート制限は 503 で、注文は PENDING のまま", async () => {
    squarePayments.create.mockRejectedValue(squareError("RATE_LIMIT_ERROR", "RATE_LIMITED", 429));

    const res = await post(validBody());

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "rate_limited" });
    expect(orders.setStatus).not.toHaveBeenCalled();
  });

  test("Square のエラーコードが無ければ code を返さない", async () => {
    squarePayments.create.mockRejectedValue(new Error("boom"));

    const res = await post(validBody());

    expect(res.body).not.toHaveProperty("code");
  });
});
