import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * 設定の検証。
 *
 * ★ config.ts は import された瞬間に検証して throw する。テストでは
 *   環境変数を差し替えてから vi.resetModules() → 動的 import で読み直す。
 *
 * ★ dotenv をモックしているのは、開発者のローカルにある server/.env が
 *   テスト結果を左右しないようにするため。「自分の環境では通るのに CI で落ちる」
 *   の典型がこれ。
 */
vi.mock("dotenv/config", () => ({}));

const VALID: Record<string, string> = {
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  JWT_SECRET: "test-jwt-secret",
  SQUARE_ENVIRONMENT: "sandbox",
  SQUARE_APPLICATION_ID: "sandbox-sq0idb-test",
  SQUARE_LOCATION_ID: "LTEST",
  SQUARE_ACCESS_TOKEN: "EAAA_test_token",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "whsk_test",
  SQUARE_WEBHOOK_NOTIFICATION_URL: "https://example.test/api/webhooks/square",
};

const OPTIONAL_KEYS = [
  "NODE_ENV",
  "PORT",
  "CORS_ORIGIN",
  "CURRENCY",
  "PAYMENTS_ENABLED",
  "SERVE_STATIC",
  "RUN_MIGRATIONS",
  "RUN_SEED",
];

const TOUCHED = [...Object.keys(VALID), ...OPTIONAL_KEYS];
const ORIGINAL = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of TOUCHED) {
    const value = ORIGINAL[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

/** 環境変数を置き換えて config を読み直す */
async function loadConfig(overrides: Record<string, string | undefined> = {}) {
  for (const key of TOUCHED) delete process.env[key];
  for (const [key, value] of Object.entries({ ...VALID, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  const mod = await import("../src/config.js");
  return mod.config;
}

describe("config", () => {
  test("必須が揃っていれば読み込める", async () => {
    const config = await loadConfig();
    expect(config.databaseUrl).toBe(VALID.DATABASE_URL);
    expect(config.square.locationId).toBe("LTEST");
    expect(config.square.webhookNotificationUrl).toBe(VALID.SQUARE_WEBHOOK_NOTIFICATION_URL);
  });

  test("任意項目には既定値が入る", async () => {
    const config = await loadConfig();
    expect(config.env).toBe("development");
    expect(config.port).toBe(3000);
    expect(config.corsOrigin).toBe("http://localhost:5173");
    expect(config.currency).toBe("JPY");
    expect(config.paymentsEnabled).toBe(true);
    expect(config.serveStatic).toBe(true);
    // 起動時マイグレーション/シードは既定で無効。既知パスワードのユーザーを
    // 勝手に作らないための既定値なので、ここが true に変わったら気付けるようにする
    expect(config.runMigrationsOnBoot).toBe(false);
    expect(config.runSeedOnBoot).toBe(false);
  });

  test("任意項目を上書きできる", async () => {
    const config = await loadConfig({
      NODE_ENV: "production",
      PORT: "8080",
      CORS_ORIGIN: "https://app.example.test",
      CURRENCY: "USD",
      PAYMENTS_ENABLED: "false",
      SERVE_STATIC: "false",
      RUN_MIGRATIONS: "true",
      RUN_SEED: "true",
      SQUARE_ENVIRONMENT: "production",
      SQUARE_APPLICATION_ID: "sq0idp-production",
    });
    expect(config.env).toBe("production");
    expect(config.port).toBe(8080);
    expect(config.corsOrigin).toBe("https://app.example.test");
    expect(config.currency).toBe("USD");
    expect(config.paymentsEnabled).toBe(false);
    expect(config.serveStatic).toBe(false);
    expect(config.runMigrationsOnBoot).toBe(true);
    expect(config.runSeedOnBoot).toBe(true);
  });

  test("前後の空白は取り除かれる", async () => {
    const config = await loadConfig({ SQUARE_LOCATION_ID: "  LTEST  ", CURRENCY: "  USD  " });
    expect(config.square.locationId).toBe("LTEST");
    expect(config.currency).toBe("USD");
  });

  test("必須が 1 つ欠けると起動できない", async () => {
    await expect(loadConfig({ DATABASE_URL: undefined })).rejects.toThrow(/1 件/);
  });

  test("空文字も「未設定」として扱う", async () => {
    await expect(loadConfig({ JWT_SECRET: "   " })).rejects.toThrow(/1 件/);
  });

  // ★ 1 件ずつ投げると、コンテナデプロイでは 6 件足りないときに 6 回やり直すことになる
  test("不足はまとめて報告される", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      loadConfig({
        DATABASE_URL: undefined,
        JWT_SECRET: undefined,
        SQUARE_ACCESS_TOKEN: undefined,
      }),
    ).rejects.toThrow(/3 件/);

    const printed = error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("DATABASE_URL");
    expect(printed).toContain("JWT_SECRET");
    expect(printed).toContain("SQUARE_ACCESS_TOKEN");
  });

  test("SQUARE_ENVIRONMENT が sandbox / production 以外なら落ちる", async () => {
    await expect(loadConfig({ SQUARE_ENVIRONMENT: "staging" })).rejects.toThrow();
  });

  // ★ 環境の取り違え検出。ここを通すと sandbox のつもりで本番課金しうる
  test("sandbox なのに production の Application ID だと落ちる", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      loadConfig({ SQUARE_ENVIRONMENT: "sandbox", SQUARE_APPLICATION_ID: "sq0idp-production" }),
    ).rejects.toThrow();
    expect(error.mock.calls.map((c) => String(c[0])).join("\n")).toContain("Sandbox");
  });

  test("production なのに sandbox の Application ID だと落ちる", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      loadConfig({ SQUARE_ENVIRONMENT: "production", SQUARE_APPLICATION_ID: "sandbox-sq0idb-x" }),
    ).rejects.toThrow();
    expect(error.mock.calls.map((c) => String(c[0])).join("\n")).toContain("Production");
  });

  test("署名キーとアクセストークンに同じ値を貼ると落ちる", async () => {
    // Dashboard から違う画面の値をコピーする取り違えが多い。
    // 通してしまうと Webhook が全件 403 になり、原因が分からず時間を溶かす
    await expect(
      loadConfig({ SQUARE_WEBHOOK_SIGNATURE_KEY: "same", SQUARE_ACCESS_TOKEN: "same" }),
    ).rejects.toThrow(/1 件/);
  });
});
