import { describe, expect, test } from "vitest";
import { SquareError } from "square";
import { classifySquareError } from "../src/square/errors.js";

/**
 * 分類を間違えると、二重課金するか、直せるはずのユーザーを諦めさせる。
 *
 *   terminal=true  … 注文を FAILED にし、次回 attempt を進める（別カードで再試行できる）
 *   terminal=false … PENDING のまま。同じ冪等性キーで再送して Square に重複を吸収させる
 */

function squareError(category: string, code: string, statusCode = 400): SquareError {
  return new SquareError({
    statusCode,
    body: { errors: [{ category, code, detail: `${code} detail` }] },
  });
}

describe("classifySquareError", () => {
  test("カード否認は 402 + terminal（別カードでの再試行を可能にする）", () => {
    const result = classifySquareError(squareError("PAYMENT_METHOD_ERROR", "CARD_DECLINED", 402));
    expect(result).toEqual({
      httpStatus: 402,
      error: "payment_declined",
      code: "CARD_DECLINED",
      category: "PAYMENT_METHOD_ERROR",
      terminal: true,
    });
  });

  test("残高不足も terminal", () => {
    expect(classifySquareError(squareError("PAYMENT_METHOD_ERROR", "INSUFFICIENT_FUNDS")).terminal).toBe(
      true,
    );
  });

  test("カード系でも未知のコードは terminal にしない（迷ったら PENDING 側に倒す）", () => {
    const result = classifySquareError(squareError("PAYMENT_METHOD_ERROR", "SOME_NEW_CODE"));
    expect(result.httpStatus).toBe(402);
    expect(result.terminal).toBe(false);
  });

  test("リクエスト不正は 500（ユーザーには直せない実装バグ）", () => {
    const result = classifySquareError(squareError("INVALID_REQUEST_ERROR", "INVALID_VALUE"));
    expect(result).toMatchObject({ httpStatus: 500, error: "internal_error", terminal: false });
  });

  test("認証エラーは 500（環境変数の取り違え。ユーザーには見せない）", () => {
    const result = classifySquareError(squareError("AUTHENTICATION_ERROR", "UNAUTHORIZED", 401));
    expect(result).toMatchObject({ httpStatus: 500, error: "internal_error", terminal: false });
  });

  test("レート制限は 503 で terminal ではない（同じキーで再送させる）", () => {
    const result = classifySquareError(squareError("RATE_LIMIT_ERROR", "RATE_LIMITED", 429));
    expect(result).toMatchObject({ httpStatus: 503, error: "rate_limited", terminal: false });
  });

  test("Square 側の障害は 502 で terminal ではない", () => {
    const result = classifySquareError(squareError("API_ERROR", "INTERNAL_SERVER_ERROR", 500));
    expect(result).toMatchObject({
      httpStatus: 502,
      error: "payment_provider_error",
      terminal: false,
    });
  });

  test("SquareError 以外（ネットワーク断など）は 500 / terminal ではない", () => {
    // ★ ここで terminal にすると、成功しているかもしれない決済に
    //   新しい冪等性キーで再挑戦して二重課金する
    const result = classifySquareError(new Error("socket hang up"));
    expect(result).toEqual({
      httpStatus: 500,
      error: "internal_error",
      code: null,
      category: null,
      terminal: false,
    });
  });

  test("errors が空の SquareError でも落ちない", () => {
    const e = new SquareError({ statusCode: 500, body: { errors: [] } });
    const result = classifySquareError(e);
    expect(result.code).toBeNull();
    expect(result.category).toBeNull();
    expect(result.httpStatus).toBe(502);
  });

  test("body の無い SquareError でも落ちない", () => {
    const result = classifySquareError(new SquareError({ message: "timeout" }));
    expect(result.httpStatus).toBe(502);
    expect(result.terminal).toBe(false);
  });
});
