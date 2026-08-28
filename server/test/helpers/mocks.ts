import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import type { CourseRow, OrderRow, OrderStatus, UserRow } from "../../src/db/repositories.js";

/**
 * ルート/ハンドラのテスト用モジュールモック。
 *
 * ★ 実 DB と Square に触らずに、決済の分岐（他人の注文・二重購入・否認・返金）を
 *   全部通せるようにするのが目的。DB を立てないと 1 行も通らないテストは、
 *   結局ローカルで動かされなくなる。
 *
 * vitest は既定でファイルごとにモジュールレジストリを分けるので、
 * このモジュールを import した各テストファイルは自分専用のモックを受け取る。
 */

// ---------------------------------------------------------------- repositories

export const repositories = {
  users: {
    findByEmail: vi.fn(),
    findById: vi.fn(),
  },
  courses: {
    listPurchasable: vi.fn(),
    findPurchasable: vi.fn(),
  },
  orders: {
    insert: vi.fn(),
    find: vi.fn(),
    findForUpdate: vi.fn(),
    bumpAttempt: vi.fn(),
    setStatus: vi.fn(),
    findStalePending: vi.fn(),
  },
  payments: {
    upsert: vi.fn(),
    findByOrderRef: vi.fn(),
    findOrderRefByPaymentId: vi.fn(),
  },
  entitlements: {
    exists: vi.fn(),
    grant: vi.fn(),
    revokeByOrderRef: vi.fn(),
    listActive: vi.fn(),
    findByOrderRef: vi.fn(),
  },
  webhookEvents: {
    upsertReceived: vi.fn(),
    markProcessed: vi.fn(),
    markError: vi.fn(),
    countUnprocessedOlderThan: vi.fn(),
  },
};

// ---------------------------------------------------------------- pool

/** withTransaction に渡される擬似 PoolClient */
export const fakeClient = { query: vi.fn(), release: vi.fn() };

export const poolModule = {
  pool: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), connect: vi.fn(), on: vi.fn() },
  withTransaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(fakeClient)),
  closePool: vi.fn(),
};

// ---------------------------------------------------------------- square client

export const squareClient = {
  square: {
    payments: {
      create: vi.fn(),
      list: vi.fn(),
    },
  },
  SQUARE_LOCATION_ID: "LTESTLOCATION",
};

// ---------------------------------------------------------------- rate limit

/**
 * テストごとにレート制限の窓を空ける。
 *
 * ★ rateLimit のカウンタは Router を作るとき、つまりモジュールが読み込まれた瞬間に
 *   1 つだけ作られる。createApp() を呼び直しても同じものが使われるので、
 *   テストを 10 個も書くと 11 個目が 429 になって「なぜか落ちる」状態になる。
 *   Date.now を進めて窓ごと期限切れにするのが一番副作用が少ない
 *   （偽タイマーに切り替えると supertest の HTTP が止まる）。
 */
export function useFreshRateLimitWindow(stepMs = 61_000): void {
  const realNow = Date.now.bind(Date);
  let offset = 0;

  beforeAll(() => {
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  });

  beforeEach(() => {
    offset += stepMs;
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });
}

// ---------------------------------------------------------------- factories

export function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    email: "buyer@example.test",
    display_name: "テスト太郎",
    password_hash: "salt:hash",
    ...overrides,
  };
}

export function makeCourse(overrides: Partial<CourseRow> = {}): CourseRow {
  return {
    id: "course-basic",
    title: "はじめての決済実装",
    description: "Square で決済を組む",
    price_minor_units: 12000,
    currency: "JPY",
    is_purchasable: true,
    ...overrides,
  };
}

export function makeOrder(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    order_ref: "22222222-2222-4222-8222-222222222222",
    user_id: "11111111-1111-4111-8111-111111111111",
    course_id: "course-basic",
    amount: 12000,
    currency: "JPY",
    status: "PENDING" as OrderStatus,
    attempt: 1,
    last_error: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** Square SDK が返す payment（camelCase / amount は bigint） */
export function makeSquarePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "sqpay_completed_1",
    status: "COMPLETED",
    amountMoney: { amount: 12000n, currency: "JPY" },
    cardDetails: { card: { cardBrand: "VISA", last4: "1111" } },
    ...overrides,
  };
}
