import { SquareError } from "square";
import { logger } from "../logger.js";

/**
 * 終局的な失敗＝カード側の理由で、同じカードで再試行しても同じ結果になるもの。
 *
 * ★ ここに該当したときだけ注文を FAILED にして、冪等性キーの世代（attempt）を進める。
 *   ネットワークエラーや Square 側の障害では進めない。成功しているかもしれないため、
 *   同じキーで再送させて Square に重複を吸収させる。
 *   判断に迷ったら PENDING 側に倒す。二重課金より、購入できない時間が延びるほうが回復しやすい。
 */
export const TERMINAL_CODES = new Set([
  "CARD_DECLINED",
  "GENERIC_DECLINE",
  "INSUFFICIENT_FUNDS",
  "CVV_FAILURE",
  "VERIFY_CVV_FAILURE",
  "INVALID_CARD",
  "INVALID_CARD_DATA",
  "INVALID_EXPIRATION",
  "CARD_EXPIRED",
  "ADDRESS_VERIFICATION_FAILURE",
  "VERIFY_AVS_FAILURE",
  "CARD_NOT_SUPPORTED",
  "INVALID_PIN",
  "CARD_DECLINED_VERIFICATION_REQUIRED",
  "ALLOWABLE_PIN_TRIES_EXCEEDED",
  "PAN_FAILURE",
]);

export type Classified = {
  /** HTTP レスポンスのステータス */
  httpStatus: number;
  /** クライアントに返すエラー識別子 */
  error: string;
  /** Square のエラーコード（あれば） */
  code: string | null;
  category: string | null;
  /** 注文を FAILED にして attempt を進めるか */
  terminal: boolean;
};

export function classifySquareError(e: unknown): Classified {
  if (!(e instanceof SquareError)) {
    return { httpStatus: 500, error: "internal_error", code: null, category: null, terminal: false };
  }

  const first = e.errors?.[0];
  const code = first?.code ?? null;
  const category = first?.category ?? null;

  switch (category) {
    case "PAYMENT_METHOD_ERROR":
      // カード側の問題。ユーザーが直せる
      return {
        httpStatus: 402,
        error: "payment_declined",
        code,
        category,
        terminal: code !== null && TERMINAL_CODES.has(code),
      };

    case "INVALID_REQUEST_ERROR":
      // こちらのリクエストが不正。実装バグなのでアラートを上げる
      logger.error({ code, detail: first?.detail }, "Square へのリクエストが不正です（実装バグ）");
      return { httpStatus: 500, error: "internal_error", code, category, terminal: false };

    case "AUTHENTICATION_ERROR":
      logger.error({ code }, "Square の認証情報が無効です。環境変数を確認してください");
      return { httpStatus: 500, error: "internal_error", code, category, terminal: false };

    case "RATE_LIMIT_ERROR":
      // 同じ冪等性キーで再送させる
      return { httpStatus: 503, error: "rate_limited", code, category, terminal: false };

    default:
      // API_ERROR など Square 側の問題。PENDING のままにして同じキーで再送
      return { httpStatus: 502, error: "payment_provider_error", code, category, terminal: false };
  }
}
