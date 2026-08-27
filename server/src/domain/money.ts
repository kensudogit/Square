/**
 * 通貨の単位変換。
 *
 * ★ Square では 2 つの API が別々の単位を要求する。
 *
 *   Payments API の amountMoney.amount … 最小単位の整数   ¥1,000 -> 1000 / $10.00 -> 1000
 *   Web SDK の verifyBuyer() の amount  … 主単位の文字列   ¥1,000 -> "1000" / $10.00 -> "10.00"
 *
 * JPY はゼロ小数通貨なので数値が偶然一致するが、単位としては別物。
 * ここを 1 箇所に閉じ込め、クライアントに変換させないことで
 * 多通貨対応したときの 100 倍・1/100 バグを防ぐ。
 */

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX"]);

export function isZeroDecimal(currency: string): boolean {
  return ZERO_DECIMAL.has(currency.toUpperCase());
}

/** 最小単位の整数 -> verifyBuyer に渡す主単位の文字列 */
export function toMajorUnitString(minor: number, currency: string): string {
  if (!Number.isInteger(minor)) {
    throw new Error(`金額は最小単位の整数で扱う。受け取った値: ${minor}`);
  }
  return isZeroDecimal(currency) ? String(minor) : (minor / 100).toFixed(2);
}

/** 表示用 */
export function formatAmount(minor: number, currency: string): string {
  if (isZeroDecimal(currency)) {
    return `${currency === "JPY" ? "¥" : ""}${minor.toLocaleString("ja-JP")}`;
  }
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

/**
 * Square SDK の Money（amount が bigint）を、そのまま JSON にできる形へ落とす。
 * JSON.stringify は BigInt で例外を投げるので、境界で必ず通す。
 */
export function fromSquareMoney(
  money: { amount?: bigint | number | null; currency?: string | null } | null | undefined,
): { amount: number; currency: string | null } | null {
  if (!money || money.amount === null || money.amount === undefined) return null;
  return { amount: Number(money.amount), currency: money.currency ?? null };
}
