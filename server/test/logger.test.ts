import { beforeEach, describe, expect, test, vi } from "vitest";
import { logger } from "../src/logger.js";

/**
 * ログの目的は「調査できること」と「漏らさないこと」の両立。
 * 特に sourceId（カードトークン）を素通しするとログ基盤に決済情報が流れる。
 */

function lastLine(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const calls = spy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return JSON.parse(String(calls[calls.length - 1]![0])) as Record<string, unknown>;
}

describe("logger", () => {
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  test("info は console.log に JSON 1 行を書く", () => {
    logger.info({ orderRef: "o1" }, "決済を作成しました");
    const line = lastLine(log);
    expect(line).toMatchObject({ level: "info", msg: "決済を作成しました", orderRef: "o1" });
    expect(typeof line.ts).toBe("string");
  });

  test("debug も console.log に出る", () => {
    logger.debug({ type: "payment.created" }, "処理対象外のイベント");
    expect(lastLine(log)).toMatchObject({ level: "debug" });
  });

  test("warn は console.warn、error は console.error に振り分けられる", () => {
    logger.warn({}, "レート制限に到達しました");
    logger.error({}, "webhook 処理に失敗");
    expect(lastLine(warn)).toMatchObject({ level: "warn" });
    expect(lastLine(error)).toMatchObject({ level: "error" });
  });

  test("文字列 1 引数でも呼べる", () => {
    logger.info("server started");
    expect(lastLine(log)).toMatchObject({ level: "info", msg: "server started" });
  });

  test("コンテキストのみで message を省略しても落ちない", () => {
    logger.info({ a: 1 });
    expect(lastLine(log)).toMatchObject({ msg: "", a: 1 });
  });

  test("オブジェクト以外のコンテキストは無視される", () => {
    logger.info(42 as unknown as object, "数値コンテキスト");
    expect(lastLine(log)).toMatchObject({ msg: "数値コンテキスト" });
  });

  // ★ ここが本題
  test("決済トークン類は伏せられる", () => {
    logger.info(
      {
        sourceId: "cnon:card-nonce-ok",
        verificationToken: "verf_123",
        accessToken: "EAAA_secret",
        password: "hunter2",
        cardNumber: "4111111111111111",
        orderRef: "o1",
      },
      "決済リクエスト",
    );
    const line = lastLine(log);
    expect(line.sourceId).toBe("[REDACTED]");
    expect(line.verificationToken).toBe("[REDACTED]");
    expect(line.accessToken).toBe("[REDACTED]");
    expect(line.password).toBe("[REDACTED]");
    expect(line.cardNumber).toBe("[REDACTED]");
    // 伏せる必要のない値はそのまま残す（残らないと調査できない）
    expect(line.orderRef).toBe("o1");
  });

  test("snake_case のキーも伏せられる（Webhook のペイロードは snake_case）", () => {
    logger.info({ source_id: "cnon:x", card_number: "4111", access_token: "t" }, "webhook");
    const line = lastLine(log);
    expect(line).toMatchObject({
      source_id: "[REDACTED]",
      card_number: "[REDACTED]",
      access_token: "[REDACTED]",
    });
  });

  test("ネストした構造でも伏せられる", () => {
    logger.info({ req: { body: { sourceId: "cnon:x", orderRef: "o1" } } }, "nested");
    const line = lastLine(log) as { req: { body: Record<string, string> } };
    expect(line.req.body.sourceId).toBe("[REDACTED]");
    expect(line.req.body.orderRef).toBe("o1");
  });

  test("配列の中身も走査される", () => {
    logger.info({ items: [{ token: "t1" }, { token: "t2" }] }, "array");
    const line = lastLine(log) as { items: { token: string }[] };
    expect(line.items.map((i) => i.token)).toEqual(["[REDACTED]", "[REDACTED]"]);
  });

  test("深すぎる入れ子は走査を打ち切る（ログのために無限に潜らない）", () => {
    logger.info({ a: { b: { c: { d: { e: { token: "deep" } } } } } }, "deep");
    const line = lastLine(log) as { a: { b: { c: { d: { e: { token: string } } } } } };
    // 打ち切っても例外にならず、そのままの値が出ることを明示しておく
    expect(line.a.b.c.d.e.token).toBe("deep");
  });

  test("bigint を含んでいても例外にならない（SDK の Money.amount 対策）", () => {
    expect(() => logger.info({ amount: 12000n }, "bigint")).not.toThrow();
    expect(lastLine(log)).toMatchObject({ amount: 12000 });
  });

  test("null は素通しする", () => {
    logger.info({ lastError: null }, "null");
    expect(lastLine(log)).toMatchObject({ lastError: null });
  });
});
