import crypto from "node:crypto";

/**
 * scrypt によるパスワードハッシュ。"salt:hash" の形で保存する。
 * bcrypt / argon2 のネイティブ依存を増やさないため node:crypto を使っている。
 * 既存の認証基盤があるならそちらに置き換える。
 */

const KEYLEN = 64;

export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(plain, salt, KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(plain, salt, KEYLEN);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}
