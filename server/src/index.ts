import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { closePool, pool } from "./db/pool.js";

async function main() {
  // DB に繋がらないまま起動して、決済のときに初めて気付くのを避ける
  await pool.query("select 1");

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
