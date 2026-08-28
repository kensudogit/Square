import { beforeEach, describe, expect, test, vi } from "vitest";
import request from "supertest";
import { makeCourse, repositories, useFreshRateLimitWindow } from "./helpers/mocks.js";

vi.mock("../src/db/repositories.js", async () => (await import("./helpers/mocks.js")).repositories);
vi.mock("../src/db/pool.js", async () => (await import("./helpers/mocks.js")).poolModule);

const { createApp } = await import("../src/app.js");
const { issueToken } = await import("../src/middleware/requireAuth.js");
const { config } = await import("../src/config.js");

const { courses, entitlements, orders } = repositories;

/**
 * 決済を Square に依頼する「前」に、サーバーが金額を確定して注文レコードを作る。
 *
 * ★ ここで検証したいのは「金額の出所は DB だけ」であること。
 *   リクエストの amount が結果に影響したら、curl 一発で ¥1 決済が通る。
 */

const TOKEN = issueToken({ userId: "u1", email: "buyer@example.test" });
let app: ReturnType<typeof createApp>;

function post(body: object) {
  return request(app).post("/api/checkout/intent").set("Authorization", `Bearer ${TOKEN}`).send(body);
}

useFreshRateLimitWindow();

beforeEach(() => {
  vi.clearAllMocks();
  app = createApp();
  courses.findPurchasable.mockResolvedValue(makeCourse());
  entitlements.exists.mockResolvedValue(false);
  orders.insert.mockResolvedValue(undefined);
});

describe("POST /api/checkout/intent", () => {
  test("注文を作り、金額と 3DS 用の文字列を返す", async () => {
    const res = await post({ courseId: "course-basic" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      courseId: "course-basic",
      courseTitle: "はじめての決済実装",
      amount: 12000,
      amountLabel: "¥12,000",
      // verifyBuyer に渡す主単位の文字列。クライアントに単位変換をさせない
      verificationAmount: "12000",
      currency: "JPY",
    });
    // orderRef は決済前に発行される。payment.id を待つと、その待ち時間が事故の窓になる
    expect(res.body.orderRef).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("注文には DB の価格が入る", async () => {
    await post({ courseId: "course-basic" });

    expect(orders.insert).toHaveBeenCalledWith({
      orderRef: expect.any(String),
      userId: "u1",
      courseId: "course-basic",
      amount: 12000,
      currency: "JPY",
    });
  });

  // ★ これが最重要。amount を信じる実装なら ¥1 の注文が作られる
  test("リクエストの amount は完全に無視される", async () => {
    const res = await post({ courseId: "course-basic", amount: 1, price_minor_units: 1 });

    expect(res.body.amount).toBe(12000);
    expect(orders.insert).toHaveBeenCalledWith(expect.objectContaining({ amount: 12000 }));
  });

  test("ゼロ小数でない通貨では主単位に変換される", async () => {
    courses.findPurchasable.mockResolvedValue(makeCourse({ currency: "USD", price_minor_units: 4999 }));

    const res = await post({ courseId: "course-basic" });

    expect(res.body.amount).toBe(4999); // Payments API 用は最小単位のまま
    expect(res.body.verificationAmount).toBe("49.99"); // verifyBuyer 用は主単位
  });

  test("courseId が無ければ 400", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(orders.insert).not.toHaveBeenCalled();
  });

  test("購入できないコースは 404", async () => {
    courses.findPurchasable.mockResolvedValue(null);

    const res = await post({ courseId: "unknown" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "course_not_found" });
    expect(orders.insert).not.toHaveBeenCalled();
  });

  test("既に受講権限があれば 409（二重購入させない）", async () => {
    entitlements.exists.mockResolvedValue(true);

    const res = await post({ courseId: "course-basic" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "already_enrolled" });
    expect(orders.insert).not.toHaveBeenCalled();
  });

  test("未ログインなら 401（注文は作られない）", async () => {
    const res = await request(app).post("/api/checkout/intent").send({ courseId: "course-basic" });

    expect(res.status).toBe(401);
    expect(orders.insert).not.toHaveBeenCalled();
  });

  test("呼びすぎるとレート制限がかかる", async () => {
    let lastStatus = 0;
    for (let i = 0; i < 22; i += 1) {
      lastStatus = (await post({ courseId: "course-basic" })).status;
    }
    expect(lastStatus).toBe(429);
  });

  // ★ 障害時に決済受付だけを止めるフラグ。効かないと止められない
  test("PAYMENTS_ENABLED=false なら 503 を返して注文も作らない", async () => {
    const mutable = config as unknown as { paymentsEnabled: boolean };
    const original = mutable.paymentsEnabled;
    mutable.paymentsEnabled = false;
    try {
      const res = await post({ courseId: "course-basic" });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "payments_disabled" });
      expect(orders.insert).not.toHaveBeenCalled();
    } finally {
      mutable.paymentsEnabled = original;
    }
  });
});
