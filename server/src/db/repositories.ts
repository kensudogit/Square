import type pg from "pg";
import { pool, type Db } from "./pool.js";

/**
 * DB アクセスをここに集約する。SQL を散らかさないのが目的。
 *
 * 冪等性の要（entitlements の upsert / webhook_events の受信記録）は
 * アプリのロジックではなく SQL の制約で表現している。詳細は schema.sql のコメント。
 */

// ---------------------------------------------------------------- types

export type UserRow = {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
};

export type CourseRow = {
  id: string;
  title: string;
  description: string;
  price_minor_units: number;
  currency: string;
  is_purchasable: boolean;
};

export type OrderStatus = "PENDING" | "PAID" | "FAILED" | "REFUNDED" | "ABANDONED";

export type OrderRow = {
  order_ref: string;
  user_id: string;
  course_id: string;
  amount: number;
  currency: string;
  status: OrderStatus;
  attempt: number;
  last_error: string | null;
  created_at: Date;
};

export type EntitlementRow = {
  id: string;
  user_id: string;
  course_id: string;
  order_ref: string;
  status: "ACTIVE" | "REVOKED";
  granted_at: Date;
  revoked_at: Date | null;
};

export type WebhookEventRow = {
  event_id: string;
  type: string;
  received_at: Date;
  processed_at: Date | null;
  attempts: number;
};

// ---------------------------------------------------------------- users

export const users = {
  async findByEmail(email: string): Promise<UserRow | null> {
    const { rows } = await pool.query<UserRow>(`select * from users where email = $1`, [email]);
    return rows[0] ?? null;
  },

  async findById(id: string): Promise<UserRow | null> {
    const { rows } = await pool.query<UserRow>(`select * from users where id = $1`, [id]);
    return rows[0] ?? null;
  },
};

// ---------------------------------------------------------------- courses

export const courses = {
  async listPurchasable(): Promise<CourseRow[]> {
    const { rows } = await pool.query<CourseRow>(
      `select * from courses where is_purchasable order by price_minor_units`,
    );
    return rows;
  },

  /** 価格の唯一の出所。リクエストの金額は決して使わない */
  async findPurchasable(id: string): Promise<CourseRow | null> {
    const { rows } = await pool.query<CourseRow>(
      `select * from courses where id = $1 and is_purchasable`,
      [id],
    );
    return rows[0] ?? null;
  },
};

// ---------------------------------------------------------------- orders

export const orders = {
  async insert(input: {
    orderRef: string;
    userId: string;
    courseId: string;
    amount: number;
    currency: string;
  }): Promise<void> {
    await pool.query(
      `insert into orders (order_ref, user_id, course_id, amount, currency, status, attempt)
       values ($1, $2, $3, $4, $5, 'PENDING', 1)`,
      [input.orderRef, input.userId, input.courseId, input.amount, input.currency],
    );
  },

  async find(orderRef: string): Promise<OrderRow | null> {
    const { rows } = await pool.query<OrderRow>(`select * from orders where order_ref = $1`, [
      orderRef,
    ]);
    return rows[0] ?? null;
  },

  /**
   * 行ロックを取って読む。
   * 決済の入口で必ずこれを使う。ダブルクリックと Webhook が同時に来ても直列化される。
   */
  async findForUpdate(client: pg.PoolClient, orderRef: string): Promise<OrderRow | null> {
    const { rows } = await client.query<OrderRow>(
      `select * from orders where order_ref = $1 for update`,
      [orderRef],
    );
    return rows[0] ?? null;
  },

  /** 冪等性キーの世代を進める。終局的な失敗の後だけ呼ぶ */
  async bumpAttempt(client: pg.PoolClient, orderRef: string): Promise<number> {
    const { rows } = await client.query<{ attempt: number }>(
      `update orders
          set attempt = attempt + 1, status = 'PENDING', updated_at = now()
        where order_ref = $1
        returning attempt`,
      [orderRef],
    );
    return rows[0]?.attempt ?? 1;
  },

  async setStatus(
    orderRef: string,
    status: OrderStatus,
    lastError: string | null = null,
    db: Db = pool,
  ): Promise<void> {
    await db.query(
      `update orders set status = $2, last_error = $3, updated_at = now() where order_ref = $1`,
      [orderRef, status, lastError],
    );
  },

  /** 照合バッチ用。決済 API のレスポンスも Webhook も来ないまま滞留している注文 */
  async findStalePending(olderThanMinutes: number): Promise<OrderRow[]> {
    const { rows } = await pool.query<OrderRow>(
      `select * from orders
        where status = 'PENDING'
          and created_at < now() - make_interval(mins => $1)
        order by created_at`,
      [olderThanMinutes],
    );
    return rows;
  },
};

// ---------------------------------------------------------------- payments

export const payments = {
  /**
   * 同期経路（SDK・camelCase・bigint）と Webhook 経路（snake_case・number）の
   * 両方から呼ばれる。呼び出し側で正規化してからここに渡すこと。
   */
  async upsert(
    input: {
      squarePaymentId: string;
      orderRef: string;
      status: string;
      amount: number;
      currency: string;
      cardBrand?: string | null;
      cardLast4?: string | null;
    },
    db: Db = pool,
  ): Promise<void> {
    await db.query(
      `insert into payments
         (square_payment_id, order_ref, status, amount, currency, card_brand, card_last4)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (square_payment_id)
       do update set status = excluded.status, updated_at = now()`,
      [
        input.squarePaymentId,
        input.orderRef,
        input.status,
        input.amount,
        input.currency,
        input.cardBrand ?? null,
        input.cardLast4 ?? null,
      ],
    );
  },

  async findByOrderRef(orderRef: string): Promise<{ square_payment_id: string; status: string }[]> {
    const { rows } = await pool.query<{ square_payment_id: string; status: string }>(
      `select square_payment_id, status from payments where order_ref = $1 order by created_at`,
      [orderRef],
    );
    return rows;
  },

  async findOrderRefByPaymentId(squarePaymentId: string): Promise<string | null> {
    const { rows } = await pool.query<{ order_ref: string }>(
      `select order_ref from payments where square_payment_id = $1`,
      [squarePaymentId],
    );
    return rows[0]?.order_ref ?? null;
  },
};

// ---------------------------------------------------------------- entitlements

export const entitlements = {
  async exists(userId: string, courseId: string): Promise<boolean> {
    const { rowCount } = await pool.query(
      `select 1 from entitlements where user_id = $1 and course_id = $2 and status = 'ACTIVE'`,
      [userId, courseId],
    );
    return (rowCount ?? 0) > 0;
  },

  /**
   * 冪等な付与。同期経路と Webhook が同時に走っても 1 行しかできない。
   *
   * ・既に ACTIVE なら何も変えない（Webhook 再送で granted_at を書き換えない）
   * ・REVOKED からの再購入では復活させる
   */
  async grant(
    input: { userId: string; courseId: string; orderRef: string },
    db: Db = pool,
  ): Promise<void> {
    await db.query(
      `insert into entitlements (user_id, course_id, order_ref, status)
       values ($1, $2, $3, 'ACTIVE')
       on conflict (user_id, course_id)
       do update set status = 'ACTIVE', revoked_at = null, order_ref = excluded.order_ref,
                     granted_at = now()
       where entitlements.status = 'REVOKED'`,
      [input.userId, input.courseId, input.orderRef],
    );
  },

  /** 冪等な剥奪。二回目は 0 行更新になる */
  async revokeByOrderRef(orderRef: string, db: Db = pool): Promise<number> {
    const { rowCount } = await db.query(
      `update entitlements
          set status = 'REVOKED', revoked_at = now()
        where order_ref = $1 and status = 'ACTIVE'`,
      [orderRef],
    );
    return rowCount ?? 0;
  },

  async listActive(userId: string): Promise<(EntitlementRow & { title: string })[]> {
    const { rows } = await pool.query<EntitlementRow & { title: string }>(
      `select e.*, c.title
         from entitlements e join courses c on c.id = e.course_id
        where e.user_id = $1 and e.status = 'ACTIVE'
        order by e.granted_at desc`,
      [userId],
    );
    return rows;
  },

  async findByOrderRef(orderRef: string): Promise<EntitlementRow | null> {
    const { rows } = await pool.query<EntitlementRow>(
      `select * from entitlements where order_ref = $1`,
      [orderRef],
    );
    return rows[0] ?? null;
  },
};

// ---------------------------------------------------------------- webhook events

export const webhookEvents = {
  /**
   * 受信を記録して現在の状態を返す。
   *
   * ★「受信した」と「処理し終えた」を分けているのが要。
   *   受信だけで重複排除すると、処理に失敗したイベントが再送時にスキップされ、
   *   二度と処理されなくなる。
   */
  async upsertReceived(
    eventId: string,
    type: string,
    payload: unknown,
  ): Promise<WebhookEventRow> {
    const { rows } = await pool.query<WebhookEventRow>(
      `insert into webhook_events (event_id, type, attempts, payload)
       values ($1, $2, 1, $3)
       on conflict (event_id)
       do update set attempts = webhook_events.attempts + 1
       returning event_id, type, received_at, processed_at, attempts`,
      [eventId, type, JSON.stringify(payload)],
    );
    return rows[0]!;
  },

  async markProcessed(eventId: string): Promise<void> {
    await pool.query(
      `update webhook_events set processed_at = now(), last_error = null where event_id = $1`,
      [eventId],
    );
  },

  async markError(eventId: string, error: string): Promise<void> {
    await pool.query(`update webhook_events set last_error = $2 where event_id = $1`, [
      eventId,
      error.slice(0, 2000),
    ]);
  },

  /** 監視用。処理が詰まっているイベント */
  async countUnprocessedOlderThan(minutes: number): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from webhook_events
        where processed_at is null and received_at < now() - make_interval(mins => $1)`,
      [minutes],
    );
    return Number(rows[0]?.count ?? 0);
  },
};
