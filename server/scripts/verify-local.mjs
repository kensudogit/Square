#!/usr/bin/env node
// @ts-check
/**
 * Square の認証情報なしで検証できる範囲を通しで確認する。
 *
 * Square API を呼ぶのは決済作成だけなので、それ以外の経路
 * ―― Webhook の署名検証・重複排除・権限付与・剥奪・所有者チェック ――
 * は自前で署名を作れば完全に検証できる。CI に載せられるのもここまで。
 *
 * 前提: サーバーが起動していること。
 *
 * ★ 権限付与や返金の検証は DB の状態に依存するので、まっさらな状態から走らせる必要がある。
 *   npm run verify:local は db:reset（テーブル再作成 + シード）を挟むので何度でも実行できる。
 *   このスクリプトを直接叩く場合は、先に npm run db:reset を実行すること。
 *
 *   npm run verify:local
 *   node scripts/verify-local.mjs --base http://localhost:3000   ← 事前に db:reset が必要
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(here, "..", ".env"));

const BASE = argValue("--base") ?? `http://localhost:${process.env.PORT ?? 3000}`;
const SIGNATURE_KEY = must("SQUARE_WEBHOOK_SIGNATURE_KEY");
// シードと同じ既定値。.env の SEED_PASSWORD で上書きされる
const DEMO_PASSWORD = process.env.SEED_PASSWORD?.trim() || "demo-password-1234";
const NOTIFICATION_URL = must("SQUARE_WEBHOOK_NOTIFICATION_URL");

let passed = 0;
let failed = 0;

// --------------------------------------------------------------------------

async function main() {
  const up = await check("サーバーが起動している", async () => {
    const res = await fetch(`${BASE}/healthz`);
    const body = await res.json();
    assert(res.ok && body.ok === true, `healthz が失敗: ${res.status}`);
  });

  if (!up) {
    // ここで続けても全部同じ理由で落ちるだけなので、原因だけ示して打ち切る
    console.log("");
    console.log(`サーバーに接続できません: ${BASE}`);
    console.log("別のターミナルで npm run dev を実行してから、もう一度お試しください。");
    process.exitCode = 1;
    return;
  }

  // ---- 認証 -------------------------------------------------------------
  const taro = await login("taro@example.com", DEMO_PASSWORD);
  const hanako = await login("hanako@example.com", DEMO_PASSWORD);

  await check("誤ったパスワードでログインできない", async () => {
    const res = await post("/api/auth/login", { email: "taro@example.com", password: "wrong" });
    assert(res.status === 401, `401 を期待したが ${res.status}`);
  });

  await check("トークン無しで保護 API を叩くと 401", async () => {
    const res = await fetch(`${BASE}/api/me/entitlements`);
    assert(res.status === 401, `401 を期待したが ${res.status}`);
  });

  // ---- 注文の作成 -------------------------------------------------------
  const courses = await (await fetch(`${BASE}/api/courses`)).json();
  const course = courses.find((c) => c.id === "course-ts-basics");
  assert(course, "seed されたコースが見つかりません");

  let intent;
  await check("checkout/intent が金額を確定して orderRef を返す", async () => {
    const res = await post("/api/checkout/intent", { courseId: course.id }, taro.token);
    intent = await res.json();
    assert(res.ok, `intent が失敗: ${res.status}`);
    assert(intent.orderRef, "orderRef がありません");
    assert(intent.amount === course.amount, `金額が一致しません: ${intent.amount}`);
    assert(
      intent.verificationAmount === String(course.amount),
      `JPY の verifyBuyer 用金額は最小単位と同値のはず: ${intent.verificationAmount}`,
    );
  });

  // ★ 原則1: 金額はクライアントから受け取らない
  await check("リクエストに金額を混ぜても無視される", async () => {
    const res = await post(
      "/api/checkout/intent",
      { courseId: course.id, amount: 1, price: 1, priceMinorUnits: 1 },
      taro.token,
    );
    const body = await res.json();
    assert(body.amount === course.amount, `注入した金額が通ってしまいました: ${body.amount}`);
  });

  // ★ 他人の注文で決済できない
  await check("他ユーザーの orderRef での決済は 403", async () => {
    const res = await post(
      "/api/payments",
      { orderRef: intent.orderRef, sourceId: "cnon:fake-token" },
      hanako.token,
    );
    assert(res.status === 403, `403 を期待したが ${res.status}`);
  });

  await check("存在しない orderRef は 404", async () => {
    const res = await post(
      "/api/payments",
      { orderRef: crypto.randomUUID(), sourceId: "cnon:fake-token" },
      taro.token,
    );
    assert(res.status === 404, `404 を期待したが ${res.status}`);
  });

  // ---- Webhook の署名検証 ----------------------------------------------
  const paymentId = `pay_${crypto.randomUUID().slice(0, 12)}`;

  await check("署名が無い Webhook は 403", async () => {
    const { body } = paymentEvent(intent.orderRef, paymentId, "COMPLETED");
    const res = await fetch(`${BASE}/api/webhooks/square`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert(res.status === 403, `403 を期待したが ${res.status}`);
  });

  await check("改竄されたボディは 403", async () => {
    const { body, signature } = paymentEvent(intent.orderRef, paymentId, "COMPLETED");
    const tampered = body.replace("COMPLETED", "COMPLETEX");
    const res = await sendWebhook(tampered, signature);
    assert(res.status === 403, `403 を期待したが ${res.status}`);
  });

  await check("署名キーが違うと 403（sandbox/production の取り違え相当）", async () => {
    const { body } = paymentEvent(intent.orderRef, paymentId, "COMPLETED");
    const wrong = sign(body, "wrong-signature-key");
    const res = await sendWebhook(body, wrong);
    assert(res.status === 403, `403 を期待したが ${res.status}`);
  });

  // ---- 権限付与 ---------------------------------------------------------
  const completed = paymentEvent(intent.orderRef, paymentId, "COMPLETED");

  await check("正しい署名の payment.updated(COMPLETED) で権限が付与される", async () => {
    const res = await sendWebhook(completed.body, completed.signature);
    assert(res.status === 200, `200 を期待したが ${res.status}`);

    const list = await getJson("/api/me/entitlements", taro.token);
    const hit = list.find((e) => e.courseId === course.id);
    assert(hit, "受講権限が付与されていません");
  });

  const firstGrant = (await getJson("/api/me/entitlements", taro.token)).find(
    (e) => e.courseId === course.id,
  ).grantedAt;

  // ★ Webhook は at-least-once。重複は「起こるかもしれない」ではなく「起こる」
  await check("同じ Webhook を 2 回送っても権限は増えず granted_at も変わらない", async () => {
    const res = await sendWebhook(completed.body, completed.signature);
    assert(res.status === 200, `200 を期待したが ${res.status}`);

    const list = await getJson("/api/me/entitlements", taro.token);
    const hits = list.filter((e) => e.courseId === course.id);
    assert(hits.length === 1, `権限が ${hits.length} 件に増えています`);
    assert(hits[0].grantedAt === firstGrant, "granted_at が再送で書き換わっています");
  });

  await check("event_id が違えば別イベントとして処理される（同じ結果に収束）", async () => {
    const again = paymentEvent(intent.orderRef, paymentId, "COMPLETED");
    const res = await sendWebhook(again.body, again.signature);
    assert(res.status === 200, `200 を期待したが ${res.status}`);
    const list = await getJson("/api/me/entitlements", taro.token);
    assert(list.filter((e) => e.courseId === course.id).length === 1, "権限が重複しました");
  });

  await check("購入済みコースへの intent は 409", async () => {
    const res = await post("/api/checkout/intent", { courseId: course.id }, taro.token);
    assert(res.status === 409, `409 を期待したが ${res.status}`);
  });

  await check("決済済みの注文への再決済は決済せず COMPLETED を返す", async () => {
    const res = await post(
      "/api/payments",
      { orderRef: intent.orderRef, sourceId: "cnon:fake-token" },
      taro.token,
    );
    const body = await res.json();
    assert(res.status === 200 && body.status === "COMPLETED", `想定外: ${res.status} ${JSON.stringify(body)}`);
  });

  // ---- 未知の reference_id -----------------------------------------------
  await check("身に覚えのない reference_id の Webhook は 200 で黙って無視", async () => {
    const unknown = paymentEvent(crypto.randomUUID(), `pay_${crypto.randomUUID().slice(0, 8)}`, "COMPLETED");
    const res = await sendWebhook(unknown.body, unknown.signature);
    assert(res.status === 200, `200 を期待したが ${res.status}`);
  });

  // ---- 返金による剥奪 ---------------------------------------------------
  await check("refund.updated(PENDING) では剥奪しない", async () => {
    const ev = refundEvent(paymentId, "PENDING");
    const res = await sendWebhook(ev.body, ev.signature);
    assert(res.status === 200, `200 を期待したが ${res.status}`);
    const list = await getJson("/api/me/entitlements", taro.token);
    assert(list.some((e) => e.courseId === course.id), "未確定の返金で剥奪されました");
  });

  await check("refund.updated(COMPLETED) で権限が剥奪される", async () => {
    const ev = refundEvent(paymentId, "COMPLETED");
    const res = await sendWebhook(ev.body, ev.signature);
    assert(res.status === 200, `200 を期待したが ${res.status}`);
    const list = await getJson("/api/me/entitlements", taro.token);
    assert(!list.some((e) => e.courseId === course.id), "権限が剥奪されていません");
  });

  // ---- 返金後の再購入 ---------------------------------------------------
  await check("返金後は再購入でき、権限が ACTIVE に戻る", async () => {
    const res = await post("/api/checkout/intent", { courseId: course.id }, taro.token);
    assert(res.ok, `再購入の intent が失敗: ${res.status}`);
    const second = await res.json();

    const ev = paymentEvent(second.orderRef, `pay_${crypto.randomUUID().slice(0, 8)}`, "COMPLETED");
    const hook = await sendWebhook(ev.body, ev.signature);
    assert(hook.status === 200, `200 を期待したが ${hook.status}`);

    const list = await getJson("/api/me/entitlements", taro.token);
    assert(list.some((e) => e.courseId === course.id), "再購入で権限が復活していません");
  });

  // ---- まとめ -----------------------------------------------------------
  console.log("");
  console.log("=".repeat(60));
  console.log(` 成功 ${passed} / 失敗 ${failed}`);
  console.log("=".repeat(60));
  if (failed === 0) {
    console.log("Square 認証情報なしで検証できる範囲はすべて通りました。");
    console.log("残りはサンドボックスでの実決済（references/testing.md のチェックリスト）です。");
  }
  // fetch の直後に process.exit() を呼ぶと Windows の Node で
  // libuv のアサーションに当たるため、exitCode を立てて自然に終了させる
  process.exitCode = failed > 0 ? 1 : 0;
}

// --------------------------------------------------------------------------
// helpers

function sign(body, key = SIGNATURE_KEY) {
  return crypto.createHmac("sha256", key).update(NOTIFICATION_URL).update(Buffer.from(body, "utf8")).digest("base64");
}

function envelope(type, object) {
  const body = JSON.stringify({
    merchant_id: "MERCHANT_TEST",
    type,
    event_id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    data: { type: type.split(".")[0], id: crypto.randomUUID(), object },
  });
  return { body, signature: sign(body) };
}

function paymentEvent(orderRef, paymentId, status) {
  return envelope("payment.updated", {
    payment: {
      id: paymentId,
      status,
      reference_id: orderRef,
      location_id: "L_TEST",
      amount_money: { amount: 12000, currency: "JPY" }, // Webhook は number（SDK は bigint）
      card_details: { card: { card_brand: "VISA", last_4: "1111" } },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

function refundEvent(paymentId, status) {
  return envelope("refund.updated", {
    refund: {
      id: `ref_${crypto.randomUUID().slice(0, 8)}`,
      status,
      payment_id: paymentId,
      amount_money: { amount: 12000, currency: "JPY" },
      reason: "動作確認",
    },
  });
}

function sendWebhook(body, signature) {
  return fetch(`${BASE}/api/webhooks/square`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(signature ? { "x-square-hmacsha256-signature": signature } : {}),
    },
    body,
  });
}

function post(pathname, body, token) {
  return fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function getJson(pathname, token) {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`GET ${pathname} が ${res.status}`);
  return res.json();
}

async function login(email, password) {
  const res = await post("/api/auth/login", { email, password });
  if (!res.ok) throw new Error(`ログイン失敗 (${email}): ${res.status}`);
  return res.json();
}

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [OK]  ${name}`);
    return true;
  } catch (e) {
    failed++;
    console.log(`  [NG]  ${name}`);
    console.log(`        ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function must(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`環境変数 ${name} が必要です（server/.env を確認してください）`);
    process.exit(1);
  }
  return v.trim();
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    if (process.env[k] === undefined) process.env[k] = t.slice(eq + 1).trim();
  }
}

main().catch((e) => {
  console.error("検証スクリプトが異常終了しました:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
