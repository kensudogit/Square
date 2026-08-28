import crypto from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import request from "supertest";
import { poolModule, repositories } from "./helpers/mocks.js";

vi.mock("../src/db/repositories.js", async () => (await import("./helpers/mocks.js")).repositories);
vi.mock("../src/db/pool.js", async () => (await import("./helpers/mocks.js")).poolModule);

const { createApp } = await import("../src/app.js");
const { config } = await import("../src/config.js");

const { courses, webhookEvents } = repositories;

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  vi.clearAllMocks();
  poolModule.pool.query.mockResolvedValue({ rows: [{ "?column?": 1 }], rowCount: 1 });
  app = createApp();
});

describe("GET /healthz", () => {
  test("DB に繋がれば ok を返す", async () => {
    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, env: "sandbox" });
    expect(poolModule.pool.query).toHaveBeenCalledWith("select 1");
  });

  // ★ 疎通確認は「プロセスが生きている」ではなく「DB に繋がる」で判定する。
  //   前者だと DB 断でもロードバランサに入れられ続ける
  test("DB に繋がらなければ 503", async () => {
    poolModule.pool.query.mockRejectedValue(new Error("connection refused"));

    const res = await request(app).get("/healthz");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: "database_unavailable" });
  });
});

describe("ルーティング", () => {
  test("未知のパスは JSON の 404（HTML を返さない）", async () => {
    const res = await request(app).get("/api/nope");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  test("CORS のオリジンが設定値になっている", async () => {
    const res = await request(app).get("/api/config").set("Origin", config.corsOrigin);
    expect(res.headers["access-control-allow-origin"]).toBe(config.corsOrigin);
  });

  test("x-powered-by は返さない", async () => {
    const res = await request(app).get("/api/config");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  // ★ webhook は express.json() より前に express.raw() で登録されている必要がある。
  //   順序が崩れると body が Buffer でなくなり 500、あるいは署名不一致で全件 403 になる
  describe("POST /api/webhooks/square", () => {
    function sign(raw: Buffer): string {
      return crypto
        .createHmac("sha256", config.square.webhookSignatureKey)
        .update(config.square.webhookNotificationUrl)
        .update(raw)
        .digest("base64");
    }

    test("生ボディのまま署名検証され、正しい署名なら 200", async () => {
      webhookEvents.upsertReceived.mockResolvedValue({
        event_id: "evt_app_1",
        type: "customer.created",
        received_at: new Date(),
        processed_at: null,
        attempts: 1,
      });
      webhookEvents.markProcessed.mockResolvedValue(undefined);

      const raw = Buffer.from(
        JSON.stringify({
          merchant_id: "M1",
          type: "customer.created",
          event_id: "evt_app_1",
          created_at: "2026-01-01T00:00:00Z",
          data: { type: "customer", id: "c1", object: {} },
        }),
        "utf8",
      );

      const res = await request(app)
        .post("/api/webhooks/square")
        .set("Content-Type", "application/json")
        .set("x-square-hmacsha256-signature", sign(raw))
        // ★ superagent は既定で JSON を再シリアライズする。それをさせると
        //   バイト列が変わって署名が合わない（本番で起きる事故の再現でもある）
        .serialize((body) => body as string)
        .send(raw as unknown as string);

      expect(res.status).toBe(200);
    });

    test("署名が無ければ 403（DB には触らない）", async () => {
      const res = await request(app)
        .post("/api/webhooks/square")
        .set("Content-Type", "application/json")
        .send(Buffer.from("{}", "utf8"));

      expect(res.status).toBe(403);
      expect(webhookEvents.upsertReceived).not.toHaveBeenCalled();
    });
  });
});

describe("エラーハンドラ", () => {
  // Express 5 は async ハンドラの reject も終端ハンドラに流す
  test("ハンドラ内の例外は 500 の JSON になり、詳細は漏らさない", async () => {
    courses.listPurchasable.mockRejectedValue(new Error("relation \"courses\" does not exist"));

    const res = await request(app).get("/api/courses");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(res.body)).not.toContain("courses");
  });

  test("Error でない値が投げられても 500 を返す", async () => {
    courses.listPurchasable.mockRejectedValue("文字列で投げられた");

    const res = await request(app).get("/api/courses");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal_error" });
  });
});
