import { pool, closePool } from "./pool.js";
import { hashPassword } from "./password.js";

/**
 * 動作確認用のデモデータ。
 *   npm run db:seed
 *
 * 本番では実行しない。パスワードが固定なので、seed 済みの DB を公開しないこと。
 */

// パスワードはソースに固定しない。.env の SEED_PASSWORD で上書きできる。
// 実際に使っているパスワードをリポジトリへ残さないための逃げ道。
const DEMO_PASSWORD = process.env.SEED_PASSWORD?.trim() || "demo-password-1234";

const USERS = [
  { email: "taro@example.com", displayName: "山田 太郎" },
  { email: "hanako@example.com", displayName: "鈴木 花子" },
  { email: "kensudo1203@gmail.com", displayName: "テスト ユーザー" },
];

// price_minor_units は JPY の最小単位＝円そのもの（¥12,000 -> 12000）
const COURSES = [
  {
    id: "course-ts-basics",
    title: "TypeScript 入門",
    description: "型システムの基礎から実践的な設計まで。全 12 回。",
    price: 12000,
  },
  {
    id: "course-payments",
    title: "決済システム設計",
    description: "冪等性・Webhook・整合性の取り方を実装しながら学ぶ。全 8 回。",
    price: 24800,
  },
  {
    id: "course-sql",
    title: "実務のための SQL",
    description: "インデックス設計とクエリチューニング。全 10 回。",
    price: 9800,
  },
];

async function main() {
  const passwordHash = hashPassword(DEMO_PASSWORD);

  for (const u of USERS) {
    await pool.query(
      `insert into users (email, display_name, password_hash)
       values ($1, $2, $3)
       on conflict (email) do update
         set display_name = excluded.display_name,
             password_hash = excluded.password_hash`,
      [u.email, u.displayName, passwordHash],
    );
  }

  for (const c of COURSES) {
    await pool.query(
      `insert into courses (id, title, description, price_minor_units, currency, is_purchasable)
       values ($1, $2, $3, $4, 'JPY', true)
       on conflict (id) do update
         set title = excluded.title,
             description = excluded.description,
             price_minor_units = excluded.price_minor_units`,
      [c.id, c.title, c.description, c.price],
    );
  }

  console.log("シード完了");
  console.log("");
  console.log("  デモユーザー:");
  for (const u of USERS) console.log(`    ${u.email} / ${DEMO_PASSWORD}`);
  console.log("");
  console.log("  コース:");
  for (const c of COURSES) console.log(`    ${c.id.padEnd(20)} ¥${c.price.toLocaleString()}  ${c.title}`);
}

main()
  .catch((e) => {
    console.error("シードに失敗しました:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closePool);
