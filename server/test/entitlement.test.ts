import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeOrder, repositories } from "./helpers/mocks.js";

vi.mock("../src/db/repositories.js", async () => (await import("./helpers/mocks.js")).repositories);

const { grantEntitlement, revokeEntitlement } = await import("../src/domain/entitlement.js");

const { orders, entitlements } = repositories;

/**
 * 付与と剥奪は「同期経路（決済 API のレスポンス）」と「非同期経路（Webhook）」の
 * 両方から呼ばれる。同時に呼ばれても結果が同じであること（冪等性）が全体設計の要。
 */

beforeEach(() => {
  orders.find.mockReset();
  orders.setStatus.mockReset().mockResolvedValue(undefined);
  entitlements.grant.mockReset().mockResolvedValue(undefined);
  entitlements.revokeByOrderRef.mockReset().mockResolvedValue(0);
});

describe("grantEntitlement", () => {
  test("PENDING の注文に権限を付与し、注文を PAID にする", async () => {
    orders.find.mockResolvedValue(makeOrder({ status: "PENDING" }));

    await expect(grantEntitlement("22222222-2222-4222-8222-222222222222")).resolves.toBe(true);

    expect(entitlements.grant).toHaveBeenCalledWith({
      userId: "11111111-1111-4111-8111-111111111111",
      courseId: "course-basic",
      orderRef: "22222222-2222-4222-8222-222222222222",
    });
    expect(orders.setStatus).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      "PAID",
    );
  });

  // ★ 同期経路が先に PAID にした後、Webhook が同じ orderRef で呼んでくる状況
  test("既に PAID なら状態を書き換えない（Webhook 再送で無駄な UPDATE を打たない）", async () => {
    orders.find.mockResolvedValue(makeOrder({ status: "PAID" }));

    await expect(grantEntitlement("o1")).resolves.toBe(true);

    expect(entitlements.grant).toHaveBeenCalledTimes(1); // 付与自体は冪等なので呼んでよい
    expect(orders.setStatus).not.toHaveBeenCalled();
  });

  test("2 回呼んでも同じ結果になる（同期経路と Webhook の二重実行）", async () => {
    orders.find
      .mockResolvedValueOnce(makeOrder({ status: "PENDING" }))
      .mockResolvedValueOnce(makeOrder({ status: "PAID" }));

    await expect(grantEntitlement("o1")).resolves.toBe(true);
    await expect(grantEntitlement("o1")).resolves.toBe(true);

    expect(entitlements.grant).toHaveBeenCalledTimes(2);
    expect(orders.setStatus).toHaveBeenCalledTimes(1);
  });

  // ★ Dashboard の「テストイベント送信」で身に覚えのない reference_id が来る。
  //   例外にすると Square が指数バックオフで再送し続ける
  test("未知の orderRef は false を返すだけで例外にしない", async () => {
    orders.find.mockResolvedValue(null);

    await expect(grantEntitlement("unknown")).resolves.toBe(false);

    expect(entitlements.grant).not.toHaveBeenCalled();
    expect(orders.setStatus).not.toHaveBeenCalled();
  });
});

describe("revokeEntitlement", () => {
  test("有効な権限があれば剥奪し、注文を REFUNDED にする", async () => {
    entitlements.revokeByOrderRef.mockResolvedValue(1);

    await expect(revokeEntitlement("o1", "requested_by_customer")).resolves.toBe(true);

    expect(orders.setStatus).toHaveBeenCalledWith("o1", "REFUNDED", "requested_by_customer");
  });

  test("剥奪対象が無くても注文の状態は更新し、例外にしない（冪等）", async () => {
    entitlements.revokeByOrderRef.mockResolvedValue(0);

    await expect(revokeEntitlement("o1", "refund")).resolves.toBe(false);

    expect(orders.setStatus).toHaveBeenCalledWith("o1", "REFUNDED", "refund");
  });

  test("剥奪は何回呼んでも安全（2 回目は false）", async () => {
    entitlements.revokeByOrderRef.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(revokeEntitlement("o1", "refund")).resolves.toBe(true);
    await expect(revokeEntitlement("o1", "refund")).resolves.toBe(false);
  });
});
