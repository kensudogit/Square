import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, closePool } from "./pool.js";

/**
 * schema.sql を流す。何度実行してもよい（すべて if not exists）。
 *   npm run db:migrate
 *   npm run db:migrate -- --drop   ← テーブルを作り直す（開発用）
 */

const here = path.dirname(fileURLToPath(import.meta.url));

function findSchema(): string {
  const candidates = [
    path.join(here, "schema.sql"),               // tsx 実行時 / dist に同梱した場合
    path.join(here, "..", "..", "src", "db", "schema.sql"), // dist から src を見る場合
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`schema.sql が見つかりません。探した場所: ${candidates.join(", ")}`);
}

const DROP = `
drop table if exists entitlements cascade;
drop table if exists webhook_events cascade;
drop table if exists payments cascade;
drop table if exists orders cascade;
drop table if exists courses cascade;
drop table if exists users cascade;
`;

async function main() {
  const drop = process.argv.includes("--drop");
  if (drop) {
    // --drop はローカルの検証用 DB を作り直すためのもの。本番で誤爆させない
    if (process.env.NODE_ENV === "production") {
      throw new Error("NODE_ENV=production では --drop を実行できません");
    }
    console.log("既存テーブルを削除します（--drop）");
    await pool.query(DROP);
  }

  const schemaPath = findSchema();
  const sql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(sql);

  const { rows } = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`,
  );
  console.log(`マイグレーション完了 (${schemaPath})`);
  console.log("テーブル:", rows.map((r) => r.table_name).join(", "));
}

main()
  .catch((e) => {
    console.error("マイグレーションに失敗しました:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closePool);
