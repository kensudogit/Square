import { describe, expect, test } from "vitest";
import { hashPassword, verifyPassword } from "../src/db/password.js";

describe("hashPassword / verifyPassword", () => {
  test("正しいパスワードは検証を通る", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  test("違うパスワードは通らない", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("Correct horse battery staple", stored)).toBe(false);
  });

  test("同じパスワードでも毎回違うハッシュになる（salt が効いている）", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  test("保存形式は salt:hash", () => {
    const [salt, hash] = hashPassword("x").split(":");
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toMatch(/^[0-9a-f]{128}$/); // scrypt keylen 64 バイト
  });

  test("壊れた保存値は例外にせず false を返す", () => {
    // 移行途中の行や手で入れた行が来ても、ログインが 500 で落ちないようにする
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "saltonly")).toBe(false);
    expect(verifyPassword("x", ":onlyhash")).toBe(false);
    expect(verifyPassword("x", "salt:")).toBe(false);
  });

  test("長さの違うハッシュでも timingSafeEqual で例外にならない", () => {
    expect(() => verifyPassword("x", "abcd:00ff")).not.toThrow();
    expect(verifyPassword("x", "abcd:00ff")).toBe(false);
  });

  test("空パスワードも一貫して扱える", () => {
    const stored = hashPassword("");
    expect(verifyPassword("", stored)).toBe(true);
    expect(verifyPassword("x", stored)).toBe(false);
  });
});
