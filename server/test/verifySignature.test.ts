import crypto from "node:crypto";
import { describe, expect, test } from "vitest";
import { isValidSquareSignature } from "../src/square/verifySignature.js";

/**
 * 署名検証は同じアルゴリズムで期待値を自作できるので、
 * フィクスチャを外部から持ってくる必要がない。
 */

const KEY = "test-signature-key-0123456789";
const URL = "https://example.com/api/webhooks/square";
const BODY = Buffer.from(
  JSON.stringify({ event_id: "evt_1", type: "payment.updated", merchant_id: "M1" }),
  "utf8",
);

function sign(url: string, body: Buffer, key = KEY): string {
  return crypto.createHmac("sha256", key).update(url).update(body).digest("base64");
}

describe("isValidSquareSignature", () => {
  test("正しい署名は通る", () => {
    expect(
      isValidSquareSignature({
        rawBody: BODY,
        signatureHeader: sign(URL, BODY),
        signatureKey: KEY,
        notificationUrl: URL,
      }),
    ).toBe(true);
  });

  test("ボディが 1 文字違うと落ちる", () => {
    const tampered = Buffer.from(BODY.toString("utf8").replace("evt_1", "evt_2"), "utf8");
    expect(
      isValidSquareSignature({
        rawBody: tampered,
        signatureHeader: sign(URL, BODY),
        signatureKey: KEY,
        notificationUrl: URL,
      }),
    ).toBe(false);
  });

  test("URL の末尾スラッシュが違うと落ちる", () => {
    expect(
      isValidSquareSignature({
        rawBody: BODY,
        signatureHeader: sign(`${URL}/`, BODY),
        signatureKey: KEY,
        notificationUrl: URL,
      }),
    ).toBe(false);
  });

  test("プロトコルが違うと落ちる", () => {
    const httpUrl = URL.replace("https://", "http://");
    expect(
      isValidSquareSignature({
        rawBody: BODY,
        signatureHeader: sign(httpUrl, BODY),
        signatureKey: KEY,
        notificationUrl: URL,
      }),
    ).toBe(false);
  });

  test("署名キーが違うと落ちる（sandbox と production の取り違え）", () => {
    expect(
      isValidSquareSignature({
        rawBody: BODY,
        signatureHeader: sign(URL, BODY, "another-signature-key-9876"),
        signatureKey: KEY,
        notificationUrl: URL,
      }),
    ).toBe(false);
  });

  // ★ これが最も重要なテスト。
  //   「署名が無ければ検証をスキップする」バグは正常系のテストでは絶対に検出できない
  test("署名ヘッダが無いと落ちる", () => {
    expect(
      isValidSquareSignature({
        rawBody: BODY,
        signatureHeader: undefined,
        signatureKey: KEY,
        notificationUrl: URL,
      }),
    ).toBe(false);
  });

  test("空の署名ヘッダで落ちる", () => {
    expect(
      isValidSquareSignature({
        rawBody: BODY,
        signatureHeader: "",
        signatureKey: KEY,
        notificationUrl: URL,
      }),
    ).toBe(false);
  });

  test("長さの違う署名でも例外を投げずに false を返す", () => {
    // timingSafeEqual は長さが違うと例外を投げるので、事前に長さを見ている
    expect(() =>
      isValidSquareSignature({
        rawBody: BODY,
        signatureHeader: "short",
        signatureKey: KEY,
        notificationUrl: URL,
      }),
    ).not.toThrow();
  });

  test("マルチバイトを含むボディでも一致する（Buffer のまま扱えているか）", () => {
    const jp = Buffer.from(JSON.stringify({ note: "決済が完了しました", event_id: "evt_ja" }), "utf8");
    expect(
      isValidSquareSignature({
        rawBody: jp,
        signatureHeader: sign(URL, jp),
        signatureKey: KEY,
        notificationUrl: URL,
      }),
    ).toBe(true);
  });

  test("パース済みオブジェクトを再シリアライズしたものは一致しない", () => {
    // express.json() を先に通してしまった場合に起きる状況の再現。
    // キー順が変わるため署名が合わなくなる
    const reserialized = Buffer.from(
      JSON.stringify({ merchant_id: "M1", type: "payment.updated", event_id: "evt_1" }),
      "utf8",
    );
    expect(
      isValidSquareSignature({
        rawBody: reserialized,
        signatureHeader: sign(URL, BODY),
        signatureKey: KEY,
        notificationUrl: URL,
      }),
    ).toBe(false);
  });
});
