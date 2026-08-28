import { defineConfig } from "vitest/config";

/**
 * 単体テストとカバレッジの設定。
 *
 * ★ カバレッジは v8 プロバイダを使う。TypeScript を istanbul で計測しようとすると
 *   計測用の変換が別途必要になるが、v8 は Node のカバレッジをそのまま使い、
 *   vite が出力するソースマップで .ts の行に戻す。追加の変換が要らない。
 *
 * ★ env をここで与えているのは config.ts が「起動時に環境変数を検証して落ちる」
 *   実装だから。テストでも同じ検証が走るので、値が無いと config を import する
 *   モジュール（routes / app / webhookHandler）を一切テストできなくなる。
 *   dotenv は既存の process.env を上書きしないので、この値が常に勝つ。
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // ★ restoreMocks / clearMocks はあえて有効にしない。
    //   これらはテスト前後で「全ての」モックを触るので、モジュールモック
    //   （test/helpers/mocks.ts）の実装まで巻き添えで消える。
    //   後片付けは各テストファイルが自分の beforeEach で行う。

    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      JWT_SECRET: "test-jwt-secret-do-not-use-outside-tests",
      SQUARE_ENVIRONMENT: "sandbox",
      SQUARE_APPLICATION_ID: "sandbox-sq0idb-test-application-id",
      SQUARE_LOCATION_ID: "LTESTLOCATION",
      SQUARE_ACCESS_TOKEN: "EAAAETEST_access_token",
      SQUARE_WEBHOOK_SIGNATURE_KEY: "test-webhook-signature-key",
      SQUARE_WEBHOOK_NOTIFICATION_URL: "https://example.test/api/webhooks/square",
      CORS_ORIGIN: "http://localhost:5173",
      CURRENCY: "JPY",
      PAYMENTS_ENABLED: "true",
      // 静的配信はテストでは邪魔になる（dist/public の有無で 404 の挙動が変わる）
      SERVE_STATIC: "false",
    },

    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      // text: 端末で読む / html: 行単位で見る / lcov: CI や IDE 拡張 / json-summary: 閾値の確認
      reporter: ["text", "text-summary", "html", "lcov", "json-summary"],
      // ★ include に一致するファイルは、テストから import されなくても 0% として
      //   集計する（vitest 4 の既定）。触っていないファイルを集計から外すと、
      //   カバレッジが実態より高く出る
      include: ["src/**/*.ts"],
      exclude: [
        // プロセス起動そのもの（listen / シグナル処理）。単体テストの対象ではない
        "src/index.ts",
        // 実 DB に対して DDL / DML を流す運用スクリプト。単体テストではなく
        // verify:local（実 DB あり）で検証する
        "src/db/migrate.ts",
        "src/db/seed.ts",
        "src/**/*.d.ts",
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});
