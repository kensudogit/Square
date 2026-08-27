import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  idempotencyKeyFor,
  paymentAction,
  IDEMPOTENCY_KEY_MAX_LENGTH,
} from "../src/domain/idempotency.js";
import { TERMINAL_CODES } from "../src/square/errors.js";

describe("idempotencyKeyFor", () => {
  test("同じ注文・同じ世代なら同じキー（再送で二重課金しない）", () => {
    const orderRef = randomUUID();
    expect(idempotencyKeyFor(orderRef, 1)).toBe(idempotencyKeyFor(orderRef, 1));
  });

  test("世代が進むとキーが変わる（否認後に別カードで再試行できる）", () => {
    const orderRef = randomUUID();
    expect(idempotencyKeyFor(orderRef, 1)).not.toBe(idempotencyKeyFor(orderRef, 2));
  });

  test("別の注文なら別のキー", () => {
    expect(idempotencyKeyFor(randomUUID(), 1)).not.toBe(idempotencyKeyFor(randomUUID(), 1));
  });

  test("UUID v4 + 世代でも Square の上限 45 文字に収まる", () => {
    // 世代が 3 桁まで進んでも収まることを確認する
    for (const attempt of [1, 9, 99, 999]) {
      const key = idempotencyKeyFor(randomUUID(), attempt);
      expect(key.length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_MAX_LENGTH);
    }
  });

  test("orderRef が長すぎるとキー生成時点で失敗する（本番で気付かないより良い）", () => {
    expect(() => idempotencyKeyFor("x".repeat(60), 1)).toThrow(/45/);
  });

  test("attempt が不正なら例外", () => {
    expect(() => idempotencyKeyFor(randomUUID(), 0)).toThrow();
    expect(() => idempotencyKeyFor(randomUUID(), 1.5)).toThrow();
  });
});

describe("paymentAction", () => {
  test("PENDING はそのまま決済する", () => {
    expect(paymentAction("PENDING")).toBe("proceed");
  });

  test("FAILED は世代を進めてから決済する", () => {
    // これをしないと、否認された結果が Square 側に残り続けて別カードでも買えない
    expect(paymentAction("FAILED")).toBe("bump-then-proceed");
  });

  test("PAID は決済せず前回の結果を返す", () => {
    expect(paymentAction("PAID")).toBe("already-paid");
  });

  test("REFUNDED は拒否する", () => {
    expect(paymentAction("REFUNDED")).toBe("refunded");
  });
});

describe("TERMINAL_CODES", () => {
  test("カード側の理由は終局的として扱う", () => {
    for (const code of ["CARD_DECLINED", "INSUFFICIENT_FUNDS", "CVV_FAILURE", "CARD_EXPIRED"]) {
      expect(TERMINAL_CODES.has(code)).toBe(true);
    }
  });

  test("通信・提供側の障害は終局的にしない（同じキーで再送させるため）", () => {
    // ここに含めてしまうと、成功しているかもしれない決済に新しいキーで再挑戦して
    // 二重課金する。判断に迷ったら PENDING 側に倒すのが原則
    for (const code of ["INTERNAL_SERVER_ERROR", "SERVICE_UNAVAILABLE", "GATEWAY_TIMEOUT", "RATE_LIMITED"]) {
      expect(TERMINAL_CODES.has(code)).toBe(false);
    }
  });
});
