import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import request from "supertest";
import { poolModule } from "./helpers/mocks.js";

vi.mock("../src/db/repositories.js", async () => (await import("./helpers/mocks.js")).repositories);
vi.mock("../src/db/pool.js", async () => (await import("./helpers/mocks.js")).poolModule);

const { createApp } = await import("../src/app.js");
const { config } = await import("../src/config.js");

/**
 * 単一コンテナ構成（ビルド済みフロントを同じプロセスから配信する）の検証。
 *
 * ★ SPA フォールバックが API を飲み込むと、全ての API が index.html を返して
 *   「フロントが動かない」ではなく「決済が静かに壊れる」形で表面化する。
 *   ここだけは実際にファイルを置いて確かめる価値がある。
 */

// app.ts が見に行く場所（src/ から見た ../public）
const publicDir = path.resolve(
  path.dirname(fileURLToPath(new URL("../src/app.ts", import.meta.url))),
  "..",
  "public",
);

let createdByTest = false;
let app: ReturnType<typeof createApp>;
const mutableConfig = config as unknown as { serveStatic: boolean };
const originalServeStatic = mutableConfig.serveStatic;

beforeAll(() => {
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
    createdByTest = true;
  }
  fs.writeFileSync(path.join(publicDir, "index.html"), "<!doctype html><title>spa</title>", "utf8");
  fs.writeFileSync(path.join(publicDir, "app.abc123.js"), "console.log('bundle');", "utf8");
});

afterAll(() => {
  mutableConfig.serveStatic = originalServeStatic;
  // 実ビルドの成果物は消さない。このテストが作ったときだけ片付ける
  if (createdByTest) fs.rmSync(publicDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  poolModule.pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  mutableConfig.serveStatic = true;
  app = createApp();
});

describe("SERVE_STATIC=true", () => {
  test("フロントの入口が返る", async () => {
    const res = await request(app).get("/");

    expect(res.status).toBe(200);
    expect(res.text).toContain("<title>spa</title>");
  });

  test("ハッシュ付きアセットは長期キャッシュ、index.html はキャッシュしない", async () => {
    const asset = await request(app).get("/app.abc123.js");
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const html = await request(app).get("/index.html");
    expect(html.headers["cache-control"]).toBe("no-cache");
  });

  test("フロントのルーティングは index.html にフォールバックする", async () => {
    const res = await request(app).get("/courses/basic");

    expect(res.status).toBe(200);
    expect(res.text).toContain("<title>spa</title>");
  });

  // ★ ここが崩れると、API が HTML を返して原因不明の JSON パースエラーになる
  test("API は絶対に飲み込まない", async () => {
    const res = await request(app).get("/api/nope");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  test("/healthz も飲み込まない", async () => {
    const res = await request(app).get("/healthz");
    expect(res.body).toMatchObject({ ok: true });
  });

  test("GET / HEAD 以外のメソッドはフォールバックしない", async () => {
    const res = await request(app).post("/courses/basic").send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });
});

describe("SERVE_STATIC=false", () => {
  test("静的配信を無効にすると 404 の JSON になる（フロント別ホスティング構成）", async () => {
    mutableConfig.serveStatic = false;
    const separated = createApp();

    const res = await request(separated).get("/courses/basic");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });
});
