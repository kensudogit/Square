import { describe, expect, test } from "vitest";
import { toMajorUnitString, formatAmount, fromSquareMoney, isZeroDecimal } from "../src/domain/money.js";

/**
 * Payments API（最小単位の整数）と verifyBuyer（主単位の文字列）は別の単位。
 * JPY では数値が偶然一致するので、USD で単位が揃っていないことを検証しておく。
 */

describe("toMajorUnitString", () => {
  test("JPY はゼロ小数通貨なので数値がそのまま文字列になる", () => {
    expect(toMajorUnitString(1000, "JPY")).toBe("1000");
    expect(toMajorUnitString(12000, "JPY")).toBe("12000");
    expect(toMajorUnitString(1, "JPY")).toBe("1");
  });

  test("USD は 2 桁小数に変換される（ここが JPY と揃っていないポイント）", () => {
    expect(toMajorUnitString(1000, "USD")).toBe("10.00");
    expect(toMajorUnitString(999, "USD")).toBe("9.99");
    expect(toMajorUnitString(5, "USD")).toBe("0.05");
  });

  test("小数を渡すと例外。金額は必ず最小単位の整数で扱う", () => {
    expect(() => toMajorUnitString(10.5, "JPY")).toThrow();
  });

  test("通貨コードの大小文字を問わない", () => {
    expect(toMajorUnitString(1000, "jpy")).toBe("1000");
  });
});

describe("isZeroDecimal", () => {
  test("JPY はゼロ小数、USD は違う", () => {
    expect(isZeroDecimal("JPY")).toBe(true);
    expect(isZeroDecimal("USD")).toBe(false);
  });
});

describe("formatAmount", () => {
  test("JPY は円記号と桁区切り", () => {
    expect(formatAmount(12000, "JPY")).toBe("¥12,000");
  });
});

describe("fromSquareMoney", () => {
  // SDK の Money.amount は bigint。JSON.stringify は BigInt で例外を投げるため、
  // レスポンスやログに載せる前に必ず Number へ落とす
  test("bigint を number に落とす", () => {
    expect(fromSquareMoney({ amount: 12000n, currency: "JPY" })).toEqual({
      amount: 12000,
      currency: "JPY",
    });
  });

  test("変換後の値は JSON にできる", () => {
    const converted = fromSquareMoney({ amount: 12000n, currency: "JPY" });
    expect(() => JSON.stringify(converted)).not.toThrow();
  });

  test("変換しない bigint は JSON.stringify で例外になる（この関数が必要な理由）", () => {
    expect(() => JSON.stringify({ amount: 12000n })).toThrow(TypeError);
  });

  test("null / undefined を安全に扱う", () => {
    expect(fromSquareMoney(null)).toBeNull();
    expect(fromSquareMoney(undefined)).toBeNull();
    expect(fromSquareMoney({ amount: null, currency: "JPY" })).toBeNull();
  });
});
