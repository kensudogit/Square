import { beforeEach, describe, expect, test, vi } from "vitest";
import request from "supertest";
import { makeUser, repositories, useFreshRateLimitWindow } from "./helpers/mocks.js";

vi.mock("../src/db/repositories.js", async () => (await import("./helpers/mocks.js")).repositories);
vi.mock("../src/db/pool.js", async () => (await import("./helpers/mocks.js")).poolModule);

const { createApp } = await import("../src/app.js");
const { hashPassword } = await import("../src/db/password.js");
const { issueToken } = await import("../src/middleware/requireAuth.js");

const { users } = repositories;

/**
 * 認証はデモ用の最小実装だが、決済側が req.auth.userId を信頼する以上、
 * ここが緩いと「他人の注文で決済できる」に直結する。
 */

const PASSWORD = "correct horse battery staple";
let app: ReturnType<typeof createApp>;

useFreshRateLimitWindow();

beforeEach(() => {
  vi.clearAllMocks();
  app = createApp();
  users.findByEmail.mockResolvedValue(makeUser({ password_hash: hashPassword(PASSWORD) }));
  users.findById.mockResolvedValue(makeUser());
});

describe("POST /api/auth/login", () => {
  test("正しい資格情報でトークンとユーザー情報を返す", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "buyer@example.test", password: PASSWORD });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.user).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      email: "buyer@example.test",
      displayName: "テスト太郎",
    });
    // ★ パスワードハッシュを返していないこと
    expect(JSON.stringify(res.body)).not.toContain("password");
  });

  test("email / password が欠けていれば 400", async () => {
    expect((await request(app).post("/api/auth/login").send({})).status).toBe(400);
    expect(
      (await request(app).post("/api/auth/login").send({ email: "a@example.test" })).status,
    ).toBe(400);
    expect((await request(app).post("/api/auth/login").send({ password: "x" })).status).toBe(400);
  });

  test("パスワードが違えば 401", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "buyer@example.test", password: "wrong" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid_credentials" });
  });

  // ★ ユーザーの存在有無を応答で区別しない（列挙攻撃を防ぐ）
  test("存在しないユーザーでもパスワード誤りと同じ応答", async () => {
    users.findByEmail.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@example.test", password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid_credentials" });
  });

  test("連続でログインを試すとレート制限がかかる（総当たり対策）", async () => {
    users.findByEmail.mockResolvedValue(null);

    let lastStatus = 0;
    for (let i = 0; i < 12; i += 1) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "nobody@example.test", password: "x" });
      lastStatus = res.status;
    }

    expect(lastStatus).toBe(429);
  });
});

describe("GET /api/auth/me", () => {
  test("トークンがあれば自分の情報を返す", async () => {
    const token = issueToken({ userId: "u1", email: "buyer@example.test" });

    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: "buyer@example.test", displayName: "テスト太郎" });
  });

  test("トークンが無ければ 401", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
    expect(users.findById).not.toHaveBeenCalled();
  });

  test("トークンは有効だがユーザーが消えていれば 404", async () => {
    users.findById.mockResolvedValue(null);
    const token = issueToken({ userId: "deleted", email: "x@example.test" });

    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "user_not_found" });
  });
});
