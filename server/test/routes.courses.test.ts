import { beforeEach, describe, expect, test, vi } from "vitest";
import request from "supertest";
import { makeCourse, repositories } from "./helpers/mocks.js";

vi.mock("../src/db/repositories.js", async () => (await import("./helpers/mocks.js")).repositories);
vi.mock("../src/db/pool.js", async () => (await import("./helpers/mocks.js")).poolModule);

const { createApp } = await import("../src/app.js");
const { issueToken } = await import("../src/middleware/requireAuth.js");

const { courses, entitlements } = repositories;

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  vi.clearAllMocks();
  app = createApp();
});

describe("GET /api/courses", () => {
  test("購入可能なコースを表示用の形で返す", async () => {
    courses.listPurchasable.mockResolvedValue([makeCourse()]);

    const res = await request(app).get("/api/courses");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "course-basic",
        title: "はじめての決済実装",
        description: "Square で決済を組む",
        amount: 12000,
        // ★ 表示用の文字列はサーバーで組む。クライアントに単位変換をさせない
        amountLabel: "¥12,000",
        currency: "JPY",
      },
    ]);
  });

  test("ログインしていなくても一覧は見られる", async () => {
    courses.listPurchasable.mockResolvedValue([]);
    const res = await request(app).get("/api/courses");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("GET /api/me/entitlements", () => {
  test("自分の有効な受講権限を返す", async () => {
    entitlements.listActive.mockResolvedValue([
      {
        id: "e1",
        user_id: "u1",
        course_id: "course-basic",
        order_ref: "order-1",
        status: "ACTIVE",
        granted_at: new Date("2026-01-02T03:04:05.000Z"),
        revoked_at: null,
        title: "はじめての決済実装",
      },
    ]);

    const token = issueToken({ userId: "u1", email: "buyer@example.test" });
    const res = await request(app)
      .get("/api/me/entitlements")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(entitlements.listActive).toHaveBeenCalledWith("u1");
    expect(res.body).toEqual([
      {
        courseId: "course-basic",
        title: "はじめての決済実装",
        grantedAt: "2026-01-02T03:04:05.000Z",
        orderRef: "order-1",
      },
    ]);
  });

  test("未ログインなら 401", async () => {
    const res = await request(app).get("/api/me/entitlements");
    expect(res.status).toBe(401);
    expect(entitlements.listActive).not.toHaveBeenCalled();
  });
});

describe("GET /api/config", () => {
  test("フロントに必要な公開値だけを返す", async () => {
    const res = await request(app).get("/api/config");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      squareApplicationId: "sandbox-sq0idb-test-application-id",
      squareLocationId: "LTESTLOCATION",
      squareEnvironment: "sandbox",
      currency: "JPY",
      paymentsEnabled: true,
    });
  });

  // ★ このエンドポイントは誰でも叩ける。秘密を 1 つでも足したら即漏洩する
  test("アクセストークンと署名キーは絶対に含めない", async () => {
    const body = JSON.stringify((await request(app).get("/api/config")).body);

    expect(body).not.toContain(process.env.SQUARE_ACCESS_TOKEN);
    expect(body).not.toContain(process.env.SQUARE_WEBHOOK_SIGNATURE_KEY);
    expect(body).not.toContain(process.env.JWT_SECRET);
    expect(body).not.toContain(process.env.DATABASE_URL);
  });
});
