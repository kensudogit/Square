import crypto from "node:crypto";

/**
 * Square Webhook の署名検証。
 *
 * ★ SDK の WebhooksHelper ではなく自前で実装している。
 *   アルゴリズムは HMAC-SHA256 で固定されていて変わらない一方、
 *   ヘルパーの関数名と引数は SDK のメジャーバージョンで変わってきた実績がある。
 *   セキュリティの中心をバージョン差分の影響下に置かないための判断。
 *
 * 署名 = base64( HMAC-SHA256( 通知URL + 生ボディ, 署名キー ) )
 * ヘッダ名は x-square-hmacsha256-signature（x-square-signature は旧 SHA1 方式）
 */
export function isValidSquareSignature(params: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  signatureKey: string;
  notificationUrl: string;
}): boolean {
  const { rawBody, signatureHeader, signatureKey, notificationUrl } = params;
  if (!signatureHeader) return false;

  const hmac = crypto.createHmac("sha256", signatureKey);
  hmac.update(notificationUrl); // ★ Dashboard の登録値と完全一致（末尾スラッシュ・プロトコルまで）
  hmac.update(rawBody);         // ★ Buffer のまま。toString() を挟むとマルチバイトで壊れる
  const expected = hmac.digest("base64");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  if (a.length !== b.length) return false; // timingSafeEqual は長さが違うと例外を投げる
  return crypto.timingSafeEqual(a, b);     // 単純な === は使わない（タイミング攻撃）
}
