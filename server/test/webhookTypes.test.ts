import { describe, expect, test } from "vitest";
import { looksLikeSquareEvent } from "../src/square/webhookTypes.js";

/**
 * 署名を通った後の入口ガード。
 * ここで弾いたものは 400 を返して打ち切る（再送されても直らないため）。
 */

describe("looksLikeSquareEvent", () => {
  test("最低限の形が揃っていれば通す", () => {
    expect(
      looksLikeSquareEvent({
        event_id: "evt_1",
        type: "payment.updated",
        data: { type: "payment", id: "p1", object: {} },
      }),
    ).toBe(true);
  });

  test("event_id が無いものは通さない（冪等性の鍵がないと重複排除できない）", () => {
    expect(looksLikeSquareEvent({ type: "payment.updated", data: {} })).toBe(false);
  });

  test("type が無いものは通さない", () => {
    expect(looksLikeSquareEvent({ event_id: "evt_1", data: {} })).toBe(false);
  });

  test("data が無いものは通さない", () => {
    expect(looksLikeSquareEvent({ event_id: "evt_1", type: "payment.updated" })).toBe(false);
  });

  test("event_id が文字列でないものは通さない", () => {
    expect(looksLikeSquareEvent({ event_id: 1, type: "t", data: {} })).toBe(false);
  });

  test("null / undefined / プリミティブ / 配列を安全に扱う", () => {
    expect(looksLikeSquareEvent(null)).toBe(false);
    expect(looksLikeSquareEvent(undefined)).toBe(false);
    expect(looksLikeSquareEvent("evt_1")).toBe(false);
    expect(looksLikeSquareEvent(42)).toBe(false);
    expect(looksLikeSquareEvent([])).toBe(false);
  });
});
