import pg from "pg";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * PostgreSQL の接続プール。
 *
 * 金額は integer で持つ（JPY の最小単位＝円）。pg は int8/numeric を文字列で返すため、
 * 金額に bigint 系の型を使わないことで境界の型変換を減らしている。
 */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  logger.error({ err: String(err) }, "database pool error");
});

export type Db = pg.PoolClient | pg.Pool;

/**
 * トランザクション。
 *
 * 決済の入口では SELECT ... FOR UPDATE で注文行をロックする。
 * ダブルクリックや再送が同時に来ても 1 つずつ処理させるため。
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    try {
      await client.query("rollback");
    } catch (rollbackError) {
      logger.error({ err: String(rollbackError) }, "rollback に失敗しました");
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
