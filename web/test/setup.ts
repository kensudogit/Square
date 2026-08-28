import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * 全テスト共通のセットアップ。
 *
 * ★ localStorage と window.Square はモジュールスコープの状態に影響するので、
 *   テストごとに必ず初期化する。ここを怠ると「単体では通るのに全体では落ちる」
 *   タイプの不安定なテストになる。
 */
beforeEach(() => {
  localStorage.clear();
  delete window.Square;
  document.head.querySelectorAll("script").forEach((s) => s.remove());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
