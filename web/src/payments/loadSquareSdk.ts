/**
 * Square Web Payments SDK の読み込み。
 *
 * npm パッケージは無いので CDN から読む。sandbox と production で URL が違う。
 * index.html に静的な <script> を書く方法もあるが、それだと環境ごとに HTML を
 * 出し分けることになるので、動的読み込みにして設定 1 箇所で切り替える。
 */

const SDK_URLS = {
  sandbox: "https://sandbox.web.squarecdn.com/v1/square.js",
  production: "https://web.squarecdn.com/v1/square.js",
} as const;

export type SquareEnvironment = keyof typeof SDK_URLS;

// ★ モジュールスコープに保持する。
//   React.StrictMode の二重マウントでも script タグは 1 本しか刺さらない
let sdkPromise: Promise<void> | null = null;

export function loadSquareSdk(environment: SquareEnvironment): Promise<void> {
  if (window.Square) return Promise.resolve();
  if (sdkPromise) return sdkPromise;

  const src = SDK_URLS[environment];

  sdkPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Square SDK の読み込みに失敗しました")));
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // 失敗を残すと再試行できなくなる
      sdkPromise = null;
      reject(new Error("Square SDK の読み込みに失敗しました。ネットワークと CSP を確認してください"));
    };
    document.head.appendChild(script);
  });

  return sdkPromise;
}
