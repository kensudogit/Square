import "dotenv/config";

/**
 * 環境変数はここに集約し、プロセス起動時に検証する。
 * 決済で「設定が undefined のまま動き続ける」のは最悪の失敗の仕方で、本番で気付くことになる。
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`環境変数 ${name} が設定されていません。server/.env.example を参照してください`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

const environment = required("SQUARE_ENVIRONMENT");
if (environment !== "sandbox" && environment !== "production") {
  throw new Error(`SQUARE_ENVIRONMENT は sandbox か production。実際の値: "${environment}"`);
}

const applicationId = required("SQUARE_APPLICATION_ID");

// sandbox のアプリ ID は "sandbox-" で始まる。環境の取り違えはこれで大半を検出できる
const looksSandbox = applicationId.startsWith("sandbox-");
if (looksSandbox !== (environment === "sandbox")) {
  throw new Error(
    `SQUARE_ENVIRONMENT=${environment} と SQUARE_APPLICATION_ID の種別が一致しません。` +
      "sandbox と production の認証情報が混ざっています",
  );
}

const webhookSignatureKey = required("SQUARE_WEBHOOK_SIGNATURE_KEY");
if (webhookSignatureKey === process.env.SQUARE_ACCESS_TOKEN?.trim()) {
  throw new Error("SQUARE_WEBHOOK_SIGNATURE_KEY と SQUARE_ACCESS_TOKEN に同じ値が入っています。別物です");
}

export const config = {
  env: optional("NODE_ENV", "development"),
  port: Number(optional("PORT", "3000")),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
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
    locationId: required("SQUARE_LOCATION_ID"),
    accessToken: required("SQUARE_ACCESS_TOKEN"),
    webhookSignatureKey,
    // 署名検証に使う。Dashboard に登録した URL と 1 文字も違ってはいけないので、
    // req から組み立てず必ずこの設定値を使う
    webhookNotificationUrl: required("SQUARE_WEBHOOK_NOTIFICATION_URL"),
  },
} as const;

export type Config = typeof config;
