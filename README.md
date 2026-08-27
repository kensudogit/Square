# Square 決済 + 受講権限付与

React/TypeScript + Node.js/Express/TypeScript + PostgreSQL。
Square Web Payments SDK でカード決済を行い、決済完了をトリガーに受講権限を付与する。

決済コードは「動いた」と「正しい」の距離が遠い。この実装は、サンドボックスでは通るのに本番で壊れる典型
—— 金額の改竄、Webhook の署名不一致、二重課金、入金されたのに権限が付かない —— を、
テストではなく**構造**で潰すことを優先している。

---

## 目次

1. [動かす](#動かす)
2. [Square の認証情報を設定する](#square-の認証情報を設定する)
3. [ローカルで Webhook を受け取る](#ローカルで-webhook-を受け取る)
4. [検証コマンド](#検証コマンド)
5. [設計 — 崩してはいけない 5 点](#設計--崩してはいけない-5-点)
6. [ディレクトリ構成](#ディレクトリ構成)
7. [API](#api)
8. [本番移行](#本番移行)

---

## 動かす

必要なもの: Node.js 20+ / Docker（PostgreSQL 用）

```bash
docker compose up -d db
```

```bash
cd server && npm install && cp .env.example .env
```

`.env` の `JWT_SECRET` を埋める（`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`）。
Square の値は後で入れるので、この時点ではプレースホルダのままでよい。

```bash
cd server && npm run db:migrate && npm run db:seed
```

```bash
cd server && npm run dev
```

別のターミナルで:

```bash
cd web && npm install && npm run dev
```

http://localhost:5173 を開く。デモユーザー `taro@example.com` / `demo-password-1234` が
ログインフォームに入力済みになっている。

**この時点でカード入力欄は表示されない。** Square の application ID がプレースホルダのため。
次節で実際の認証情報を入れると表示される。それ以外（ログイン、コース一覧、注文作成、
Webhook 受信、権限付与）は認証情報なしで全部動く。

---

## Square の認証情報を設定する

1. https://developer.squareup.com/apps でアプリケーションを作成する
2. **Sandbox** の Credentials から次を控える
   - Application ID（`sandbox-sq0idb-` で始まる）
   - Access token
   - Location ID（Locations タブ。**通貨が JPY のもの**を選ぶ）
3. Webhooks > Subscriptions で sandbox 用のサブスクリプションを作る
   - 通知 URL は次節のトンネル URL
   - イベントは `payment.created` / `payment.updated` / `refund.created` / `refund.updated`
   - 表示される **Signature key** を控える（access token とは別物）
4. `server/.env` に転記する
5. 疎通を確認する

```bash
cd server && npm run preflight
```

トークンの有効性、location の存在と通貨、sandbox/production の整合、Webhook 設定の形式を
実際に Square API に問い合わせて確認する。**環境変数の綴り間違いと sandbox/production の
取り違えはここで全部出る。**

`web/.env` は通常不要。フロントは起動時に `GET /api/config` から application ID と
location ID を取得する（access token は含まれない）。

---

## ローカルで Webhook を受け取る

Square にはローカル転送用の CLI が無いのでトンネルを張る。

```bash
cloudflared tunnel --url http://localhost:3000
```

払い出された HTTPS URL を **2 箇所**に設定する。片方だけだと署名が一致しない。

- Square Dashboard の Webhook subscription の通知 URL
- `server/.env` の `SQUARE_WEBHOOK_NOTIFICATION_URL`

どちらも `https://xxxx.trycloudflare.com/api/webhooks/square` の形。
**末尾スラッシュの有無まで一致させる**（署名は URL の文字列そのものを含めて計算される）。

署名が合わないときは切り分けツールがある。

```bash
node ../.claude/skills/square-payments-integration/scripts/verify-signature.mjs \
  --body ./captured-body.json --signature "<ヘッダ値>" \
  --key "$SQUARE_WEBHOOK_SIGNATURE_KEY" --url "https://xxxx.trycloudflare.com/api/webhooks/square"
```

URL の揺れ（末尾スラッシュ、プロトコル、www）を総当たりして、どれなら一致するかを教えてくれる。

---

## 検証コマンド

```bash
cd server && npm test
```

ユニットテスト 32 件。署名検証（改竄・URL 相違・署名なし・マルチバイト）、通貨変換、
冪等性キーの世代規則、終局的エラーコードの分類。**Square にも DB にも接続しない**ので CI に載る。

```bash
cd server && npm run verify:local
```

サーバーを起動した状態で実行する通し検証 19 件。Square API を呼ぶのは決済作成だけなので、
それ以外の経路は自前で署名を作れば完全に検証できる。

権限付与や返金の検証は DB の状態に依存するため、このコマンドは実行前に
`db:reset`（テーブル再作成 + シード）を行う。**ローカルの検証用 DB のデータは消える。**
`NODE_ENV=production` では `--drop` を拒否するようにしてあるが、`DATABASE_URL` の向き先は
実行前に確認すること。

```
[OK]  リクエストに金額を混ぜても無視される
[OK]  他ユーザーの orderRef での決済は 403
[OK]  署名が無い Webhook は 403
[OK]  改竄されたボディは 403
[OK]  正しい署名の payment.updated(COMPLETED) で権限が付与される
[OK]  同じ Webhook を 2 回送っても権限は増えず granted_at も変わらない
[OK]  refund.updated(COMPLETED) で権限が剥奪される
[OK]  返金後は再購入でき、権限が ACTIVE に戻る
...
```

```bash
cd server && npm run reconcile
```

照合バッチ。PENDING のまま滞留している注文を Square に問い合わせて突き合わせる。
**検出件数は 0 が正常**で、1 件でも出たら Webhook か同期経路が壊れている。
本番では 1 時間おきに回し、件数をメトリクスとして出す。

サンドボックスでの実決済チェックリストは
`.claude/skills/square-payments-integration/references/testing.md` にある。

---

## 設計 — 崩してはいけない 5 点

### 1. 金額はクライアントから受け取らない

リクエストに乗るのは `courseId` だけ。金額は `courses` テーブルが唯一の出所。

`POST /api/checkout/intent` がサーバー側で金額を確定し、`orderRef`（UUID v4）を発行して
注文レコードを作る。`POST /api/payments` は `orderRef` から DB を引き直す。
リクエストボディの `amount` は**どこからも読まれない**。

> [server/src/routes/checkout.ts](server/src/routes/checkout.ts) /
> [server/src/routes/payments.ts](server/src/routes/payments.ts)

### 2. カード番号はサーバーに触れさせない

入力欄は Square の iframe。`card.tokenize()` が返すトークンだけがサーバーに来る。
DOM から値を読まない、state に持たない、ログに出さない。

ログ出力は [server/src/logger.ts](server/src/logger.ts) が `sourceId` / `verificationToken` /
`password` などのキーを機械的に `[REDACTED]` に落とす。

### 3. Webhook は生ボディで検証する

```ts
// server/src/app.ts — この 3 行の位置を動かさない
app.post("/api/webhooks/square", express.raw({ type: "application/json" }), squareWebhookHandler);
app.use(express.json());   // ★ 必ず raw ルートの後
```

`express.json()` を先に置くと `req.body` がパース済みオブジェクトになり、
再シリアライズしても署名は一致しない。**Webhook が全件 403 になる原因の第 1 位。**

署名検証は SDK のヘルパーではなく [自前で実装している](server/src/square/verifySignature.ts)。
アルゴリズム（HMAC-SHA256 で `通知URL + 生ボディ`）は固定で変わらない一方、
ヘルパーの名前と引数は SDK のメジャーバージョンで変わってきた。
セキュリティの中心をバージョン差分の影響下に置かない。

### 4. 権限付与は冪等な関数ひとつに集約する

```
決済 API のレスポンス ──┐
                        ├──► grantEntitlement(orderRef)  ← 同じ関数
Webhook payment.updated ┘
```

同期経路は速いがネットワークで切れる。Webhook は確実だが遅い。両方走らせて、
冪等性で衝突を吸収する。冪等性の実体はアプリのロジックではなく
`entitlements` の `unique (user_id, course_id)` 制約。

`ON CONFLICT DO UPDATE ... WHERE status = 'REVOKED'` にしているのは、
返金後の再購入で復活させつつ、既に ACTIVE のものには触らないため。
単純な `DO NOTHING` だと再購入で権限が戻らず、無条件の `DO UPDATE` だと
Webhook 再送のたびに `granted_at` が書き換わる。

`webhook_events` は「受信した」と「処理し終えた」を別の列で持つ。
受信だけで重複排除すると、**処理に失敗したイベントが再送時にスキップされ二度と処理されない。**

> [server/src/domain/entitlement.ts](server/src/domain/entitlement.ts) /
> [server/src/db/schema.sql](server/src/db/schema.sql)

### 5. 冪等性キーの世代管理

`idempotencyKey = ${orderRef}:${attempt}`

| 状況 | キー | 理由 |
|---|---|---|
| ダブルクリック・タイムアウト後の再送 | 同じ | Square が前回の結果を返す。二重課金しない |
| カード否認のあと別カードで再試行 | 新しい | 同じキーだと「否認」が返り続け、永久に買えない |

`attempt` を進めるのは**サーバーが終局的な失敗（カード側の理由）と判定したときだけ**。
通信エラーや Square 側の障害では進めない —— 成功しているかもしれないため。
判断に迷ったら `PENDING` 側に倒す。二重課金より、購入できない時間が延びるほうが回復しやすい。

> [server/src/domain/idempotency.ts](server/src/domain/idempotency.ts) /
> [server/src/square/errors.ts](server/src/square/errors.ts)

### そのほかの実装上の注意

**JPY はゼロ小数通貨** — `Money.amount` は最小単位の整数で、JPY は円そのもの（¥1,000 → `1000`）。
一方 `verifyBuyer()` は**主単位の文字列**（`"1000"`）を取る。JPY では数値が偶然一致するが単位は別物で、
USD では 100 倍ずれる。変換は [server/src/domain/money.ts](server/src/domain/money.ts) に閉じ込め、
サーバーが両方の表現を返してクライアントには一切変換させない。

**BigInt** — SDK の `Money.amount` は `bigint`。`JSON.stringify` は BigInt で例外を投げるので、
レスポンスやログに載せる前に境界で `Number` に落とす。

**Webhook は snake_case、SDK は camelCase** — 同じ payment を扱うのに表記が違い、
`amount_money.amount` は Webhook では `number`、SDK 経由では `bigint`。
型を [webhookTypes.ts](server/src/square/webhookTypes.ts) で分けてある。

**React StrictMode の二重マウント** — 開発時に effect が 2 回走り、`card.attach()` が
2 回呼ばれて入力欄が二重になる。本番ビルドでは再現しないので原因を探しづらい。
`cancelled` フラグ + cleanup での `destroy()` + SDK ロード Promise のモジュールスコープ保持、
の 3 点で対処している。StrictMode を外して隠さないこと。

---

## ディレクトリ構成

```
Square/
├── docker-compose.yml          検証用 PostgreSQL（ホスト 5433）
├── server/
│   ├── .env.example
│   ├── scripts/verify-local.mjs    Square 認証情報なしの通し検証
│   ├── src/
│   │   ├── config.ts               環境変数の一元管理と起動時検証
│   │   ├── logger.ts               トークン類を落とす構造化ログ
│   │   ├── app.ts                  ★ raw webhook ルートの位置
│   │   ├── index.ts
│   │   ├── db/
│   │   │   ├── schema.sql          冪等性を担う制約の定義
│   │   │   ├── migrate.ts / seed.ts / password.ts
│   │   │   ├── pool.ts             withTransaction / FOR UPDATE
│   │   │   └── repositories.ts
│   │   ├── domain/
│   │   │   ├── money.ts            ゼロ小数通貨と単位変換
│   │   │   ├── idempotency.ts      冪等性キーの世代規則
│   │   │   └── entitlement.ts      ★ 付与・剥奪（両経路から呼ばれる）
│   │   ├── square/
│   │   │   ├── client.ts
│   │   │   ├── verifySignature.ts  ★ 自前の HMAC 検証
│   │   │   ├── errors.ts           終局的失敗の判定
│   │   │   ├── webhookTypes.ts     snake_case 側の型
│   │   │   └── webhookHandler.ts
│   │   ├── middleware/             requireAuth / rateLimit
│   │   ├── routes/                 auth / courses / checkout / payments
│   │   └── jobs/reconcile.ts       照合バッチ
│   └── test/                       署名・通貨・冪等性のユニットテスト
└── web/
    └── src/
        ├── api.ts                  金額を送らない API クライアント
        ├── App.tsx
        └── payments/
            ├── loadSquareSdk.ts    環境別 CDN URL
            ├── square.d.ts         Web SDK の型
            └── PaymentForm.tsx     ★ tokenize → verifyBuyer → 決済
```

---

## API

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| GET | `/healthz` | — | DB 接続を含むヘルスチェック |
| GET | `/api/config` | — | フロントに渡してよい設定のみ |
| POST | `/api/auth/login` | — | JWT を発行 |
| GET | `/api/auth/me` | 要 | 自分の情報 |
| GET | `/api/courses` | — | コース一覧 |
| GET | `/api/me/entitlements` | 要 | 受講中のコース |
| POST | `/api/checkout/intent` | 要 | 金額を確定し `orderRef` を発行 |
| POST | `/api/payments` | 要 | 決済を作成し、完了なら権限を付与 |
| POST | `/api/webhooks/square` | 署名 | Square からの通知 |

認証は `Authorization: Bearer <JWT>`。
[server/src/middleware/requireAuth.ts](server/src/middleware/requireAuth.ts) はデモ用の最小実装で、
既存の認証基盤があればこの middleware だけ差し替えれば決済側は変更不要。

---

## 本番移行

手順とチェックリストは
`.claude/skills/square-payments-integration/references/testing.md` の
「本番移行の手順」に従う。要点だけ:

- 本番の application ID / access token / location ID / **webhook signature key** はすべて別物
- Webhook subscription は **production 側でも別途登録**が必要
- フロントは `VITE_SQUARE_ENVIRONMENT=production` でビルドし直す（SDK の CDN URL が切り替わる）
- 公開前に**実カードで 1 件決済し、権限付与を確認し、返金して剥奪を確認する**
- `PAYMENTS_ENABLED=false` で決済受付だけを止められる（障害時にアプリ全体を巻き戻さずに済む）
- 特定商取引法に基づく表記と返金・キャンセルポリシーの掲示

監視は「沈黙の検出」を入れる。決済は静かに壊れる —— エラーが画面に出ないまま売上だけ落ちる。
エラー率だけ見ていると、リクエストが 0 になった障害を見逃す。
