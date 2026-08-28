import { afterEach, beforeEach } from "vitest";

/**
 * 全テスト共通のセットアップ。
 *
 * logger は console に JSON を書き出すので、そのままだとテスト出力が
 * ログで埋まって失敗箇所が読めなくなる。既定では黙らせておく。
 *
 * ★ vi.spyOn ではなく直接差し替えているのは、テスト側が
 *   vi.spyOn(console, "error") でログ内容を検証できるようにするため。
 *   spy はこの no-op の上に重なり、afterEach の代入で丸ごと元に戻る。
 */
const original = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};

const noop = () => {};

beforeEach(() => {
  console.log = noop;
  console.warn = noop;
  console.error = noop;
  console.debug = noop;
});

afterEach(() => {
  Object.assign(console, original);
});
