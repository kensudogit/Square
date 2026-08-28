import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * フロントの単体テストとカバレッジ。
 *
 * ★ vite.config.ts とは分けている。テスト時に dev サーバーの proxy 設定を
 *   読み込む必要はなく、設定の意図（開発用 / テスト用）が混ざらないほうがよい。
 *
 * ★ 対象は「決済の実装が壊れると気付けない場所」に絞る。
 *   - api.ts        … 決済リクエストに金額を混ぜていないか / エラーの分類
 *   - loadSquareSdk … StrictMode の二重マウントで script が二重に刺さらないか
 *   - PaymentForm   … トークン化・3DS・二重送信・失敗時のメッセージ
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
    css: false,

    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "text-summary", "html", "lcov", "json-summary"],
      // include に一致するファイルは、テストから触れなくても 0% として数える
      // （vitest 4 の既定。触っていないファイルを集計から外すと実態より高く出る）
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        // ブラウザに root を生やすだけの起動コード。単体テストの対象ではない
        "src/main.tsx",
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
