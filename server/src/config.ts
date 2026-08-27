import "dotenv/config";

/**
 * 環境変数はここに集約し、プロセス起動時に検証する。
 * 決済で「設定が undefined のまま動き続ける」のは最悪の失敗の仕方で、本番で気付くことになる。
 *
 * ★ 検証は「最初の 1 件で投げる」のではなく、全部集めてから一度に投げる。
 *   コンテナデプロイでは 1 件直すたびに再デプロイが必要になるため、
 *   6 個足りなければ 6 回デプロイし直すことになってしまう。
 */

const problems: string[] = [];

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    problems.push(`${name} が設定されていません`);
    return "";
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

// ---- まず全部読む（足りなくてもここでは投げない） --------------------------

const environment = required("SQUARE_ENVIRONMENT");
const applicationId = required("SQUARE_APPLICATION_ID");
const locationId = required("SQUARE_LOCATION_ID");
const accessToken = required("SQUARE_ACCESS_TOKEN");
const webhookSignatureKey = required("SQUARE_WEBHOOK_SIGNATURE_KEY");
const webhookNotificationUrl = required("SQUARE_WEBHOOK_NOTIFICATION_URL");
const databaseUrl = required("DATABASE_URL");
const jwtSecret = required("JWT_SECRET");

// ---- 値そのものの検証（存在するものだけ） ----------------------------------

if (environment && environment !== "sandbox" && environment !== "production") {
  problems.push(`SQUARE_ENVIRONMENT は sandbox か production。実際の値: "${environment}"`);
}

// sandbox のアプリ ID は "sandbox-" で始まる。環境の取り違えはこれで大半を検出できる
if (environment && applicationId) {
  const looksSandbox = applicationId.startsWith("sandbox-");
  if (looksSandbox !== (environment === "sandbox")) {
    problems.push(
      `SQUARE_ENVIRONMENT=${environment} と SQUARE_APPLICATION_ID の種別が一致しません` +
        "（sandbox と production の認証情報が混ざっています）",
    );
  }
}

if (webhookSignatureKey && webhookSignatureKey === accessToken) {
  problems.push("SQUARE_WEBHOOK_SIGNATURE_KEY と SQUARE_ACCESS_TOKEN が同じ値です（別物です）");
}

// ---- まとめて報告する ------------------------------------------------------

if (problems.length > 0) {
  const lines = [
    "",
    "=".repeat(70),
    ` 起動できません: 設定に ${problems.length} 件の問題があります`,
    "=".repeat(70),
    "",
    ...problems.map((p) => `  - ${p}`),
    "",
    "ローカル開発 : server/.env.example をコピーして server/.env を作り、値を入れる",
    "コンテナ/PaaS: 下記をプラットフォームの環境変数として設定する（.env ファイルは使われない）",
    "",
    "  DATABASE_URL                     PostgreSQL の接続文字列",
    "  JWT_SECRET                       openssl rand -hex 32",
    "  SQUARE_ENVIRONMENT               sandbox | production",
    "  SQUARE_ACCESS_TOKEN              Developer Dashboard > Credentials",
    "  SQUARE_APPLICATION_ID            同上（sandbox は sandbox- で始まる）",
    "  SQUARE_LOCATION_ID               Locations（通貨が JPY のもの）",
    "  SQUARE_WEBHOOK_SIGNATURE_KEY     Webhooks > Subscriptions",
    "  SQUARE_WEBHOOK_NOTIFICATION_URL  デプロイ後の URL + /api/webhooks/square",
    "",
    "任意: PORT / CURRENCY / PAYMENTS_ENABLED / SERVE_STATIC / RUN_MIGRATIONS / CORS_ORIGIN",
    "=".repeat(70),
    "",
  ];
  // 一覧は stderr に直接出す。Error の message に入れるとスタックトレースに
  // 埋もれて読みにくくなるため、投げるのは 1 行だけにする
  console.error(lines.join("\n"));
  throw new Error(`設定に ${problems.length} 件の問題があります（詳細は上のログ）`);
}

export const config = {
  env: optional("NODE_ENV", "development"),
  port: Number(optional("PORT", "3000")),
  databaseUrl,
  jwtSecret,
  corsOrigin: optional("CORS_ORIGIN", "http://localhost:5173"),
  currency: optional("CURRENCY", "JPY"),
  /** 本番障害時に決済受付だけを止めるためのフラグ */
  paymentsEnabled: optional("PAYMENTS_ENABLED", "true") === "true",
  /**
   * ビルド済みフロントを同じプロセスから配信するか。
   * 単一コンテナで動かす構成（Dockerfile）ではこれを使う。
   * フロントを別ホスティングに置くなら SERVE_STATIC=false にして CORS_ORIGIN を設定する。
   */
  serveStatic: optional("SERVE_STATIC", "true") === "true",
  /**
   * 起動時にマイグレーションを流すか。
   * PaaS のリリースコマンドを分けられない場合の逃げ道で、既定は false。
   * 複数インスタンスを同時に立ち上げる構成では、リリース時に一度だけ流すほうが安全。
   */
  runMigrationsOnBoot: optional("RUN_MIGRATIONS", "false") === "true",
  square: {
    environment,
    applicationId,
    locationId,
    accessToken,
    webhookSignatureKey,
    // 署名検証に使う。Dashboard に登録した URL と 1 文字も違ってはいけないので、
    // req から組み立てず必ずこの設定値を使う
    webhookNotificationUrl,
  },
} as const;

export type Config = typeof config;
