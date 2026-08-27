-- ============================================================
-- Square 決済 + 受講権限 スキーマ（PostgreSQL）
--
--   1. orderRef を自分で先に発行する。Square の payment.id を待たない
--   2. 冪等性はアプリのロジックではなく UNIQUE 制約で担保する
--   3. webhook_events は「受信」と「処理完了」を別の列で持つ
--
-- 再実行できるよう if not exists で書いてある（src/db/migrate.ts が流す）
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- ユーザー
-- ------------------------------------------------------------
create table if not exists users (
  id            uuid        primary key default gen_random_uuid(),
  email         text        not null unique,
  display_name  text        not null,
  -- scrypt(password, salt) を "salt:hash" の形で保存する。外部依存を増やさないため node:crypto を使う
  password_hash text        not null,
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 商品（コース）。価格の唯一の出所
-- ------------------------------------------------------------
create table if not exists courses (
  id                text        primary key,
  title             text        not null,
  description       text        not null default '',
  price_minor_units integer     not null check (price_minor_units >= 0),  -- JPY なら「円」そのもの
  currency          text        not null default 'JPY',
  is_purchasable    boolean     not null default true,
  created_at        timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 注文。決済を Square に依頼する「前」に必ず作る
-- ------------------------------------------------------------
create table if not exists orders (
  order_ref   uuid        primary key,                  -- payments.create の referenceId に渡す
  user_id     uuid        not null references users(id),
  course_id   text        not null references courses(id),
  amount      integer     not null check (amount > 0),   -- 最小単位。リクエストではなく courses から
  currency    text        not null,
  status      text        not null default 'PENDING'
              check (status in ('PENDING','PAID','FAILED','REFUNDED','ABANDONED')),
  -- 冪等性キーの世代。終局的な失敗（カード否認など）の後だけ +1 する。
  -- 通信エラーでは進めない（成功しているかもしれないため、同じキーで再送させる）
  attempt     integer     not null default 1 check (attempt >= 1),
  last_error  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists orders_user_idx   on orders (user_id);
create index if not exists orders_status_idx on orders (status, created_at);

-- ------------------------------------------------------------
-- Square 上の決済。同期経路と Webhook の両方から upsert される
-- ------------------------------------------------------------
create table if not exists payments (
  square_payment_id text        primary key,
  order_ref         uuid        not null references orders(order_ref),
  status            text        not null,               -- APPROVED | COMPLETED | CANCELED | FAILED
  amount            integer     not null,
  currency          text        not null,
  card_brand        text,
  card_last4        text,                                -- 表示用。これ以上のカード情報は保存しない
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists payments_order_idx on payments (order_ref);

-- ------------------------------------------------------------
-- Webhook の受信記録
--
-- ★「受信した」と「処理し終えた」を分けるのが要。
--   受信だけで重複排除すると、処理に失敗したイベントが
--   再送時にスキップされ、二度と処理されなくなる
-- ------------------------------------------------------------
create table if not exists webhook_events (
  event_id     text        primary key,
  type         text        not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,                              -- NULL の間は再処理してよい
  attempts     integer     not null default 0,
  last_error   text,
  payload      jsonb
);

create index if not exists webhook_unprocessed_idx
  on webhook_events (received_at)
  where processed_at is null;

-- ------------------------------------------------------------
-- 受講権限
--
-- ★ 冪等性の実体は unique (user_id, course_id)。
--   同期経路と Webhook が同時に走っても 1 行しかできない
-- ------------------------------------------------------------
create table if not exists entitlements (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references users(id),
  course_id  text        not null references courses(id),
  order_ref  uuid        not null references orders(order_ref),
  status     text        not null default 'ACTIVE' check (status in ('ACTIVE','REVOKED')),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (user_id, course_id)
);

create index if not exists entitlements_user_idx  on entitlements (user_id) where status = 'ACTIVE';
create index if not exists entitlements_order_idx on entitlements (order_ref);
