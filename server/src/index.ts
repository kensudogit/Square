import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { closePool, pool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { runSeed } from "./db/seed.js";

async function main() {
  // DB に繋がらないまま起動して、決済のときに初めて気付くのを避ける
  await pool.query("select 1");

  // RUN_MIGRATIONS=true のときだけ。リリースコマンドを分けられない PaaS 向けの逃げ道で、
  // 複数インスタンスを同時起動する構成ではリリース時に一度だけ流すほうが安全
  if (config.runMigrationsOnBoot) {
    logger.info({}, "RUN_MIGRATIONS=true のため起動時マイグレーションを実行します");
    await runMigrations();
  }

  // RUN_SEED=true のときだけ。既知のパスワードを持つデモユーザーが作られるので、
  // 投入が済んだら false に戻す
  if (config.runSeedOnBoot) {
    logger.warn({}, "RUN_SEED=true のためデモデータを投入します（投入後は false に戻してください）");
    await runSeed();
  }

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        squareEnvironment: config.square.environment,
        locationId: config.square.locationId,
        currency: config.currency,
        paymentsEnabled: config.paymentsEnabled,
        webhookUrl: config.square.webhookNotificationUrl,
      },
      "server started",
    );
    if (config.square.environment === "sandbox") {
      logger.info({}, "sandbox モードで起動しています。実際の請求は発生しません");
    }
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    // 接続が残っていても一定時間で強制終了する
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  // 設定不足はここで落ちる。決済で「設定が undefined のまま動き続ける」のが最悪なので、
  // 起動時に必ず落とす
  logger.error({ err: e instanceof Error ? e.message : String(e) }, "起動に失敗しました");
  process.exit(1);
});
