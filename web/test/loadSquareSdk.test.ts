import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Square Web Payments SDK の読み込み。
 *
 * ★ React.StrictMode は開発時に effect を 2 回走らせる。素直に書くと script が
 *   2 本刺さり、本番ビルドでは再現しない不具合になる。Promise をモジュールスコープに
 *   持っていることが対策の中核なので、そこを直接検証する。
 *
 * ★ 失敗した Promise を保持し続けると再試行できなくなる。そこも見る。
 */

type Script = HTMLScriptElement;

function pendingScript(): Script {
  const script = document.head.querySelector<Script>("script[src*='squarecdn.com']");
  if (!script) throw new Error("script タグが刺さっていません");
  return script;
}

/** onload / onerror を発火させる */
function fire(script: Script, event: "load" | "error") {
  if (event === "load") script.onload?.(new Event("load"));
  else script.onerror?.(new Event("error"));
  script.dispatchEvent(new Event(event));
}

async function freshModule() {
  vi.resetModules();
  return import("../src/payments/loadSquareSdk.js");
}

beforeEach(() => {
  document.head.querySelectorAll("script").forEach((s) => s.remove());
  delete window.Square;
});

describe("loadSquareSdk", () => {
  test("sandbox では sandbox の CDN を読む", async () => {
    const { loadSquareSdk } = await freshModule();

    void loadSquareSdk("sandbox");

    expect(pendingScript().src).toBe("https://sandbox.web.squarecdn.com/v1/square.js");
    expect(pendingScript().async).toBe(true);
  });

  // ★ ここを取り違えると sandbox のつもりで本番のカード入力欄を出すことになる
  test("production では production の CDN を読む", async () => {
    const { loadSquareSdk } = await freshModule();

    void loadSquareSdk("production");

    expect(pendingScript().src).toBe("https://web.squarecdn.com/v1/square.js");
  });

  test("読み込みが終われば解決する", async () => {
    const { loadSquareSdk } = await freshModule();

    const promise = loadSquareSdk("sandbox");
    fire(pendingScript(), "load");

    await expect(promise).resolves.toBeUndefined();
  });

  // ★ StrictMode の二重マウント対策の中核
  test("2 回呼んでも script は 1 本しか刺さらない", async () => {
    const { loadSquareSdk } = await freshModule();

    const first = loadSquareSdk("sandbox");
    const second = loadSquareSdk("sandbox");

    expect(document.head.querySelectorAll("script").length).toBe(1);
    expect(second).toBe(first); // 同じ Promise を使い回している

    fire(pendingScript(), "load");
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  test("既に SDK が載っていれば何もしない", async () => {
    const { loadSquareSdk } = await freshModule();
    window.Square = { payments: () => ({}) } as unknown as typeof window.Square;

    await expect(loadSquareSdk("sandbox")).resolves.toBeUndefined();
    expect(document.head.querySelectorAll("script").length).toBe(0);
  });

  test("読み込みに失敗したら日本語のエラーで reject する", async () => {
    const { loadSquareSdk } = await freshModule();

    const promise = loadSquareSdk("sandbox");
    fire(pendingScript(), "error");

    await expect(promise).rejects.toThrow(/Square SDK の読み込みに失敗/);
  });

  // ★ 失敗した Promise を保持し続けると、ネットワークが復旧しても
  //   リロードするまで永久に決済フォームが出せなくなる
  test("失敗後はもう一度読み込みを試せる", async () => {
    const { loadSquareSdk } = await freshModule();

    const failed = loadSquareSdk("sandbox");
    fire(pendingScript(), "error");
    await expect(failed).rejects.toThrow();

    document.head.querySelectorAll("script").forEach((s) => s.remove());

    const retried = loadSquareSdk("sandbox");
    expect(retried).not.toBe(failed);
    fire(pendingScript(), "load");
    await expect(retried).resolves.toBeUndefined();
  });

  test("同じ src の script が既にあれば、その完了に相乗りする", async () => {
    const { loadSquareSdk } = await freshModule();

    // index.html に静的に書かれている、といった状況
    const existing = document.createElement("script");
    existing.src = "https://sandbox.web.squarecdn.com/v1/square.js";
    document.head.appendChild(existing);

    const promise = loadSquareSdk("sandbox");

    expect(document.head.querySelectorAll("script").length).toBe(1);
    existing.dispatchEvent(new Event("load"));
    await expect(promise).resolves.toBeUndefined();
  });

  test("相乗り先が失敗した場合も reject する", async () => {
    const { loadSquareSdk } = await freshModule();

    const existing = document.createElement("script");
    existing.src = "https://sandbox.web.squarecdn.com/v1/square.js";
    document.head.appendChild(existing);

    const promise = loadSquareSdk("sandbox");
    existing.dispatchEvent(new Event("error"));

    await expect(promise).rejects.toThrow(/Square SDK の読み込みに失敗/);
  });
});
