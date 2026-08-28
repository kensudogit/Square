import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeOrder, repositories, squareClient } from "./helpers/mocks.js";

vi.mock("../src/db/repositories.js", async () => (await import("./helpers/mocks.js")).repositories);
vi.mock("../src/db/pool.js", async () => (await import("./helpers/mocks.js")).poolModule);
vi.mock("../src/square/client.js", async () => (await import("./helpers/mocks.js")).squareClient);

const { reconcilePendingOrders } = await import("../src/jobs/reconcile.js");

const { orders, payments, entitlements } = repositories;
const squarePayments = squareClient.square.payments;

/**
 * 照合バッチ。
 *
 * ★ Webhook も同期経路も失敗した注文を拾う最後の網。
 *   ここが検出した件数はゼロであるべきで、ゼロでないなら他が壊れている。
 *   「拾えること」と「拾いすぎないこと（未検出を勝手に ABANDONED にしない）」の両方を見る。
 */

/** Square SDK のページャを模したもの */
type FakePage = {
  data: unknown[];
  hasNextPage: () => boolean;
  getNextPage: () => Promise<FakePage | undefined>;
};

function page(items: unknown[], next?: FakePage): FakePage {
  return {
    data: items,
    hasNextPage: () => next !== undefined,
    getNextPage: async () => next,
  };
}

const STALE_ENOUGH = new Date(Date.now() - 30 * 60_000); // 15 分より古い
const OLDER_THAN_A_DAY = new Date(Date.now() - 30 * 3_600_000);

beforeEach(() => {
  vi.clearAllMocks();
  orders.findStalePending.mockResolvedValue([]);
  orders.setStatus.mockResolvedValue(undefined);
  orders.find.mockResolvedValue(makeOrder({ status: "PENDING" }));
  payments.upsert.mockResolvedValue(undefined);
  entitlements.grant.mockResolvedValue(undefined);
  squarePayments.list.mockResolvedValue(page([]));
});

describe("reconcilePendingOrders", () => {
  test("滞留がなければ Square に問い合わせない", async () => {
    await expect(reconcilePendingOrders()).resolves.toEqual({ checked: 0, recovered: 0 });
    expect(squarePayments.list).not.toHaveBeenCalled();
  });

  // ★ 本来ゼロであるべき経路。ここが動くのは同期経路と Webhook の両方が失敗したとき
  test("Square 側で COMPLETED になっていた注文を回収して権限を付与する", async () => {
    orders.findStalePending.mockResolvedValue([makeOrder({ created_at: STALE_ENOUGH })]);
    squarePayments.list.mockResolvedValue(
      page([
        { id: "sqpay_other", referenceId: "別の注文", status: "COMPLETED" },
        {
          id: "sqpay_1",
          referenceId: "22222222-2222-4222-8222-222222222222",
          status: "COMPLETED",
          amountMoney: { amount: 12000n, currency: "JPY" },
        },
      ]),
    );

    await expect(reconcilePendingOrders()).resolves.toEqual({ checked: 1, recovered: 1 });

    expect(payments.upsert).toHaveBeenCalledWith({
      squarePaymentId: "sqpay_1",
      orderRef: "22222222-2222-4222-8222-222222222222",
      status: "COMPLETED",
      amount: 12000, // bigint を落としている
      currency: "JPY",
    });
    expect(entitlements.grant).toHaveBeenCalledTimes(1);
  });

  test("金額情報が無くても回収できる", async () => {
    orders.findStalePending.mockResolvedValue([makeOrder({ created_at: STALE_ENOUGH })]);
    squarePayments.list.mockResolvedValue(
      page([
        {
          id: "sqpay_1",
          referenceId: "22222222-2222-4222-8222-222222222222",
          status: "COMPLETED",
        },
      ]),
    );

    await reconcilePendingOrders();

    expect(payments.upsert).toHaveBeenCalledWith(expect.objectContaining({ amount: 0, currency: "JPY" }));
  });

  test("次ページまで辿って探す", async () => {
    orders.findStalePending.mockResolvedValue([makeOrder({ created_at: STALE_ENOUGH })]);
    squarePayments.list.mockResolvedValue(
      page(
        [{ id: "sqpay_other", referenceId: "x", status: "COMPLETED" }],
        page([
          {
            id: "sqpay_1",
            referenceId: "22222222-2222-4222-8222-222222222222",
            status: "COMPLETED",
            amountMoney: { amount: 12000n, currency: "JPY" },
          },
        ]),
      ),
    );

    await expect(reconcilePendingOrders()).resolves.toEqual({ checked: 1, recovered: 1 });
  });

  test("APPROVED 止まりの決済では権限を付与しない", async () => {
    orders.findStalePending.mockResolvedValue([makeOrder({ created_at: STALE_ENOUGH })]);
    squarePayments.list.mockResolvedValue(
      page([
        {
          id: "sqpay_1",
          referenceId: "22222222-2222-4222-8222-222222222222",
          status: "APPROVED",
        },
      ]),
    );

    await expect(reconcilePendingOrders()).resolves.toEqual({ checked: 1, recovered: 0 });
    expect(entitlements.grant).not.toHaveBeenCalled();
  });

  // ★ まだ決済中かもしれない注文を早々に ABANDONED にすると、
  //   後から届いた Webhook との整合が取れなくなる
  test("見つからなくても 24 時間以内なら放棄扱いにしない", async () => {
    orders.findStalePending.mockResolvedValue([makeOrder({ created_at: STALE_ENOUGH })]);

    await expect(reconcilePendingOrders()).resolves.toEqual({ checked: 1, recovered: 0 });
    expect(orders.setStatus).not.toHaveBeenCalled();
  });

  test("24 時間を超えて見つからない注文は ABANDONED にする", async () => {
    orders.findStalePending.mockResolvedValue([makeOrder({ created_at: OLDER_THAN_A_DAY })]);

    await reconcilePendingOrders();

    expect(orders.setStatus).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      "ABANDONED",
      expect.stringContaining("reconcile"),
    );
  });

  test("Square への問い合わせが失敗しても次の注文へ進む", async () => {
    orders.findStalePending.mockResolvedValue([
      makeOrder({ order_ref: "o-fails", created_at: STALE_ENOUGH }),
      makeOrder({ order_ref: "o-ok", created_at: STALE_ENOUGH }),
    ]);
    squarePayments.list
      .mockRejectedValueOnce(new Error("503 from Square"))
      .mockResolvedValueOnce(
        page([{ id: "sqpay_1", referenceId: "o-ok", status: "COMPLETED" }]),
      );

    await expect(reconcilePendingOrders()).resolves.toEqual({ checked: 2, recovered: 1 });
    // 失敗した注文は状態を変えない（次回のバッチでもう一度見る）
    expect(orders.setStatus).not.toHaveBeenCalledWith("o-fails", expect.anything(), expect.anything());
  });

  test("問い合わせは注文の作成時刻の少し前から、ロケーションを絞って行う", async () => {
    const createdAt = STALE_ENOUGH;
    orders.findStalePending.mockResolvedValue([makeOrder({ created_at: createdAt })]);

    await reconcilePendingOrders();

    expect(squarePayments.list).toHaveBeenCalledWith({
      locationId: "LTESTLOCATION",
      beginTime: new Date(createdAt.getTime() - 60_000).toISOString(),
      limit: 100,
    });
  });

  test("ページを辿りすぎない（滞留が多いときに Square を叩き潰さない）", async () => {
    orders.findStalePending.mockResolvedValue([makeOrder({ created_at: STALE_ENOUGH })]);

    // 常に次ページがあると言い張るページャ
    const endless: { data: unknown[]; hasNextPage: () => boolean; getNextPage: () => Promise<unknown> } = {
      data: [],
      hasNextPage: () => true,
      getNextPage: async () => endless,
    };
    squarePayments.list.mockResolvedValue(endless);

    await expect(reconcilePendingOrders()).resolves.toEqual({ checked: 1, recovered: 0 });
  });
});
