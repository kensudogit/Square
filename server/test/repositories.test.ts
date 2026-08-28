import { beforeEach, describe, expect, test, vi } from "vitest";
import { poolModule } from "./helpers/mocks.js";

vi.mock("../src/db/pool.js", async () => (await import("./helpers/mocks.js")).poolModule);

const { users, courses, orders, payments, entitlements, webhookEvents } = await import(
  "../src/db/repositories.js"
);

/**
 * リポジトリ層の検証。
 *
 * ★ 実 DB を使わず「どんな SQL とパラメータを投げているか」を見る。
 *   ここで守りたいのは主に 3 点で、いずれも取り違えると本番でしか壊れない。
 *
 *   - 値は必ずプレースホルダで渡す（文字列連結しない）
 *   - 冪等性はアプリのロジックではなく SQL の制約と on conflict で表現する
 *   - 「価格の出所」「有効な権限」の条件が where から抜けない
 *
 *   SQL が実際に通るかどうかは npm run verify:local（実 DB あり）の担当。
 */

const query = poolModule.pool.query;

/** 直近に発行された SQL を空白を潰した 1 行にして返す */
function lastSql(): string {
  const sql = query.mock.calls.at(-1)?.[0] as string;
  return sql.replace(/\s+/g, " ").trim();
}

function lastParams(): unknown[] {
  return (query.mock.calls.at(-1)?.[1] ?? []) as unknown[];
}

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ---------------------------------------------------------------- users

describe("users", () => {
  test("findByEmail は email をプレースホルダで渡す", async () => {
    query.mockResolvedValue({ rows: [{ id: "u1" }], rowCount: 1 });

    await expect(users.findByEmail("buyer@example.test")).resolves.toMatchObject({ id: "u1" });

    expect(lastSql()).toBe("select * from users where email = $1");
    expect(lastParams()).toEqual(["buyer@example.test"]);
  });

  test("見つからなければ null（undefined を返さない）", async () => {
    await expect(users.findByEmail("nobody@example.test")).resolves.toBeNull();
    await expect(users.findById("u404")).resolves.toBeNull();
  });

  test("findById は id で引く", async () => {
    query.mockResolvedValue({ rows: [{ id: "u1" }], rowCount: 1 });
    await users.findById("u1");
    expect(lastSql()).toBe("select * from users where id = $1");
    expect(lastParams()).toEqual(["u1"]);
  });
});

// ---------------------------------------------------------------- courses

describe("courses", () => {
  test("一覧は購入可能なものだけ、価格順", async () => {
    query.mockResolvedValue({ rows: [{ id: "c1" }], rowCount: 1 });

    await expect(courses.listPurchasable()).resolves.toEqual([{ id: "c1" }]);

    expect(lastSql()).toContain("where is_purchasable");
    expect(lastSql()).toContain("order by price_minor_units");
  });

  // ★ ここが価格の唯一の出所。is_purchasable を落とすと販売停止中のコースが買える
  test("findPurchasable は購入可能フラグを条件に含める", async () => {
    await courses.findPurchasable("c1");

    expect(lastSql()).toBe("select * from courses where id = $1 and is_purchasable");
    expect(lastParams()).toEqual(["c1"]);
  });

  test("購入できないコースは null", async () => {
    await expect(courses.findPurchasable("c-stopped")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------- orders

describe("orders", () => {
  test("insert は PENDING / attempt=1 で作る", async () => {
    await orders.insert({
      orderRef: "o1",
      userId: "u1",
      courseId: "c1",
      amount: 12000,
      currency: "JPY",
    });

    expect(lastSql()).toContain("'PENDING', 1");
    expect(lastParams()).toEqual(["o1", "u1", "c1", 12000, "JPY"]);
  });

  test("find は order_ref で引き、無ければ null", async () => {
    query.mockResolvedValue({ rows: [{ order_ref: "o1" }], rowCount: 1 });
    await expect(orders.find("o1")).resolves.toMatchObject({ order_ref: "o1" });
    expect(lastSql()).toBe("select * from orders where order_ref = $1");
    expect(lastParams()).toEqual(["o1"]);

    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(orders.find("o404")).resolves.toBeNull();
  });

  // ★ 決済の入口。for update を落とすと、ダブルクリックと Webhook が
  //   同時に走って二重課金の窓ができる
  test("findForUpdate は行ロックを取る", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ order_ref: "o1" }], rowCount: 1 }) };

    await expect(
      orders.findForUpdate(client as never, "o1"),
    ).resolves.toMatchObject({ order_ref: "o1" });

    const sql = (client.query.mock.calls[0]?.[0] as string).replace(/\s+/g, " ").trim();
    expect(sql).toBe("select * from orders where order_ref = $1 for update");
    // プールではなくトランザクション内のクライアントを使っていること
    expect(query).not.toHaveBeenCalled();
  });

  test("findForUpdate は見つからなければ null", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    await expect(orders.findForUpdate(client as never, "o404")).resolves.toBeNull();
  });

  test("bumpAttempt は世代を進めて PENDING に戻し、新しい世代を返す", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ attempt: 3 }], rowCount: 1 }) };

    await expect(orders.bumpAttempt(client as never, "o1")).resolves.toBe(3);

    const sql = (client.query.mock.calls[0]?.[0] as string).replace(/\s+/g, " ");
    expect(sql).toContain("attempt = attempt + 1");
    expect(sql).toContain("status = 'PENDING'");
  });

  test("bumpAttempt は行が無ければ 1 を返す（呼び出し側で NaN にしない）", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    await expect(orders.bumpAttempt(client as never, "o404")).resolves.toBe(1);
  });

  test("setStatus は lastError を省略できる", async () => {
    await orders.setStatus("o1", "PAID");
    expect(lastParams()).toEqual(["o1", "PAID", null]);
  });

  test("setStatus は理由を残せる", async () => {
    await orders.setStatus("o1", "FAILED", "CARD_DECLINED");
    expect(lastParams()).toEqual(["o1", "FAILED", "CARD_DECLINED"]);
  });

  test("setStatus はトランザクション内のクライアントも使える", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };

    await orders.setStatus("o1", "PAID", null, client as never);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  test("findStalePending は経過分数で絞る", async () => {
    await orders.findStalePending(15);

    expect(lastSql()).toContain("status = 'PENDING'");
    expect(lastSql()).toContain("make_interval(mins => $1)");
    expect(lastParams()).toEqual([15]);
  });
});

// ---------------------------------------------------------------- payments

describe("payments", () => {
  test("upsert は square_payment_id 衝突で status を更新する", async () => {
    await payments.upsert({
      squarePaymentId: "sqpay_1",
      orderRef: "o1",
      status: "COMPLETED",
      amount: 12000,
      currency: "JPY",
      cardBrand: "VISA",
      cardLast4: "1111",
    });

    expect(lastSql()).toContain("on conflict (square_payment_id)");
    expect(lastSql()).toContain("do update set status = excluded.status");
    expect(lastParams()).toEqual(["sqpay_1", "o1", "COMPLETED", 12000, "JPY", "VISA", "1111"]);
  });

  test("カード情報は省略できる（Webhook 経由では入っていないことがある）", async () => {
    await payments.upsert({
      squarePaymentId: "sqpay_2",
      orderRef: "o1",
      status: "APPROVED",
      amount: 12000,
      currency: "JPY",
    });

    expect(lastParams().slice(5)).toEqual([null, null]);
  });

  test("findOrderRefByPaymentId は見つからなければ null（返金の突き合わせ用）", async () => {
    await expect(payments.findOrderRefByPaymentId("sqpay_404")).resolves.toBeNull();

    query.mockResolvedValue({ rows: [{ order_ref: "o1" }], rowCount: 1 });
    await expect(payments.findOrderRefByPaymentId("sqpay_1")).resolves.toBe("o1");
  });

  test("findByOrderRef は作成順に返す", async () => {
    query.mockResolvedValue({ rows: [{ square_payment_id: "sqpay_1", status: "COMPLETED" }], rowCount: 1 });

    await expect(payments.findByOrderRef("o1")).resolves.toHaveLength(1);
    expect(lastSql()).toContain("order by created_at");
  });
});

// ---------------------------------------------------------------- entitlements

describe("entitlements", () => {
  test("exists は ACTIVE のものだけ数える", async () => {
    query.mockResolvedValue({ rows: [{ "?column?": 1 }], rowCount: 1 });

    await expect(entitlements.exists("u1", "c1")).resolves.toBe(true);

    expect(lastSql()).toContain("status = 'ACTIVE'");
    expect(lastParams()).toEqual(["u1", "c1"]);
  });

  test("exists は rowCount が null でも false を返す", async () => {
    query.mockResolvedValue({ rows: [], rowCount: null });
    await expect(entitlements.exists("u1", "c1")).resolves.toBe(false);
  });

  // ★ 冪等性の実体。同期経路と Webhook が同時に走っても 1 行しかできない
  test("grant は unique(user_id, course_id) の衝突を on conflict で吸収する", async () => {
    await entitlements.grant({ userId: "u1", courseId: "c1", orderRef: "o1" });

    const sql = lastSql();
    expect(sql).toContain("on conflict (user_id, course_id)");
    // REVOKED からの再購入だけ復活させる。ACTIVE の granted_at は書き換えない
    expect(sql).toContain("where entitlements.status = 'REVOKED'");
    expect(lastParams()).toEqual(["u1", "c1", "o1"]);
  });

  test("grant はトランザクション内のクライアントも使える", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };

    await entitlements.grant({ userId: "u1", courseId: "c1", orderRef: "o1" }, client as never);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  test("revokeByOrderRef は ACTIVE のものだけ落とし、件数を返す", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 1 });

    await expect(entitlements.revokeByOrderRef("o1")).resolves.toBe(1);

    expect(lastSql()).toContain("status = 'REVOKED'");
    expect(lastSql()).toContain("and status = 'ACTIVE'");
  });

  test("revokeByOrderRef は 2 回目に 0 を返す（冪等）", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(entitlements.revokeByOrderRef("o1")).resolves.toBe(0);
  });

  test("revokeByOrderRef は rowCount が null でも 0 を返す", async () => {
    query.mockResolvedValue({ rows: [], rowCount: null });
    await expect(entitlements.revokeByOrderRef("o1")).resolves.toBe(0);
  });

  test("listActive はコース名を結合して新しい順に返す", async () => {
    query.mockResolvedValue({ rows: [{ course_id: "c1", title: "t" }], rowCount: 1 });

    await expect(entitlements.listActive("u1")).resolves.toHaveLength(1);

    expect(lastSql()).toContain("join courses c on c.id = e.course_id");
    expect(lastSql()).toContain("e.status = 'ACTIVE'");
  });

  test("findByOrderRef は無ければ null", async () => {
    await expect(entitlements.findByOrderRef("o404")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------- webhook events

describe("webhookEvents", () => {
  // ★「受信した」と「処理し終えた」を分けているのがこのテーブルの肝。
  //   受信だけで重複排除すると、失敗したイベントが再送時にスキップされ二度と処理されない
  test("upsertReceived は再送で attempts を増やし、処理状態を返す", async () => {
    query.mockResolvedValue({
      rows: [{ event_id: "evt_1", type: "payment.updated", processed_at: null, attempts: 2 }],
      rowCount: 1,
    });

    const row = await webhookEvents.upsertReceived("evt_1", "payment.updated", { a: 1 });

    expect(row.attempts).toBe(2);
    expect(lastSql()).toContain("on conflict (event_id)");
    expect(lastSql()).toContain("attempts = webhook_events.attempts + 1");
    // ペイロードは JSON 文字列にして渡す
    expect(lastParams()).toEqual(["evt_1", "payment.updated", '{"a":1}']);
  });

  test("markProcessed は処理時刻を入れて直前のエラーを消す", async () => {
    await webhookEvents.markProcessed("evt_1");

    expect(lastSql()).toContain("processed_at = now()");
    expect(lastSql()).toContain("last_error = null");
    expect(lastParams()).toEqual(["evt_1"]);
  });

  // ★ 例外メッセージには際限がない。列に収まらず INSERT ごと失敗するのを防ぐ
  test("markError は長すぎるメッセージを切り詰める", async () => {
    await webhookEvents.markError("evt_1", "x".repeat(5000));

    expect(String(lastParams()[1])).toHaveLength(2000);
  });

  test("countUnprocessedOlderThan は数値で返す（pg の count は文字列）", async () => {
    query.mockResolvedValue({ rows: [{ count: "7" }], rowCount: 1 });

    await expect(webhookEvents.countUnprocessedOlderThan(10)).resolves.toBe(7);
    expect(lastParams()).toEqual([10]);
  });

  test("行が無ければ 0", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(webhookEvents.countUnprocessedOlderThan(10)).resolves.toBe(0);
  });
});
