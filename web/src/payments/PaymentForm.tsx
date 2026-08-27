import { useEffect, useRef, useState } from "react";
import { loadSquareSdk } from "./loadSquareSdk.js";
import type { SquareCard, SquarePayments, SquareFieldError } from "./square.js";
import { api, ApiError, type CheckoutIntent, type PublicConfig } from "../api.js";

type Props = {
  config: PublicConfig;
  courseId: string;
  buyer: { givenName: string; familyName: string; email: string };
  onSuccess: (orderRef: string) => void;
  onCancel: () => void;
};

export function PaymentForm({ config, courseId, buyer, onSuccess, onCancel }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<SquareCard | null>(null);
  const paymentsRef = useRef<SquarePayments | null>(null);
  // 再試行で使い回す注文。成功したら破棄する
  const intentRef = useRef<CheckoutIntent | null>(null);

  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ------------------------------------------------------------------
  // カード入力欄の生成
  //
  // ★ React.StrictMode は開発時に effect を 2 回走らせる。素直に書くと
  //   card.attach() が 2 回呼ばれ、入力欄が二重になるか例外で止まる。
  //   本番ビルドでは再現しないので原因を探しづらい。
  //   対策は (1) cancelled フラグ (2) cleanup で destroy (3) SDK ロードの
  //   Promise をモジュールスコープに持つ、の 3 点セット。
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let card: SquareCard | null = null;

    (async () => {
      await loadSquareSdk(config.squareEnvironment);
      if (cancelled) return;

      const payments = window.Square!.payments(config.squareApplicationId, config.squareLocationId);
      card = await payments.card({
        style: {
          input: { fontSize: "16px" }, // 16px 未満だと iOS Safari が勝手にズームする
        },
      });
      if (cancelled) return;

      await card.attach(containerRef.current!);
      if (cancelled) return;

      paymentsRef.current = payments;
      cardRef.current = card;
      setReady(true);
    })().catch((e: unknown) => {
      if (cancelled) return;
      // 生の英語メッセージは画面に出さない。ログには残して調査できるようにする
      console.error("[square] 決済フォームの初期化に失敗しました", e);
      setError(
        "決済フォームを表示できませんでした。ページを再読み込みしてもう一度お試しください。",
      );
    });

    return () => {
      cancelled = true;
      void card?.destroy();
      cardRef.current = null;
      paymentsRef.current = null;
    };
  }, [config.squareApplicationId, config.squareLocationId, config.squareEnvironment]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || submitting) return; // 二重送信を止める最後の砦
    setSubmitting(true);
    setError(null);

    try {
      // 1. 金額はサーバーが決める。送るのは courseId だけ。
      //
      //    ★ 否認後の再試行では orderRef を使い回す。
      //      submit のたびに新しい intent を取ると、失敗のたびに PENDING の注文行が増えて
      //      集計が汚れるうえ、冪等性キーの世代管理（サーバー側の attempt）が働かない。
      setStatus("注文を準備しています…");
      const reusable = intentRef.current?.courseId === courseId ? intentRef.current : null;
      const intent = reusable ?? (await api.createCheckoutIntent(courseId));
      intentRef.current = intent;

      // 2. カード情報をトークンに変換する。カード番号はこの関数の外に出ない
      setStatus("カード情報を確認しています…");
      const tokenResult = await cardRef.current!.tokenize();
      if (tokenResult.status !== "OK") {
        throw new TokenizeError(tokenResult.status === "INVALID" ? tokenResult.errors : []);
      }

      // 3. 3D セキュア。amount はサーバーが用意した主単位の文字列をそのまま渡す
      setStatus("カード会社の認証を行っています…");
      const verification = await paymentsRef.current!.verifyBuyer(tokenResult.token, {
        amount: intent.verificationAmount,
        currencyCode: intent.currency,
        intent: "CHARGE",
        billingContact: {
          givenName: buyer.givenName,
          familyName: buyer.familyName,
          email: buyer.email,
          countryCode: "JP",
        },
      });

      // 4. サーバーで決済作成。金額は送らない
      setStatus("決済を実行しています…");
      const result = await api.submitPayment({
        orderRef: intent.orderRef,
        sourceId: tokenResult.token,
        ...(verification?.token ? { verificationToken: verification.token } : {}),
      });

      if (result.status === "COMPLETED") {
        intentRef.current = null; // 使い切った注文を次の購入に持ち越さない
        onSuccess(intent.orderRef);
        return;
      }
      // APPROVED など。Webhook 経路で確定するので、その旨を正しく伝える
      setStatus(null);
      setError("決済の確定を待っています。しばらくしてから受講状況をご確認ください。");
    } catch (e) {
      // 注文そのものが使えなくなったケースは掴み直す。
      // カード否認（402）は同じ注文で再試行してよいので保持する
      if (e instanceof ApiError && (e.status === 409 || e.status === 404 || e.status === 403)) {
        intentRef.current = null;
      }
      setStatus(null);
      setError(messageFor(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="payment-form" noValidate>
      <h2>お支払い情報</h2>

      {/* Square の iframe がここに入る。中の値は読めないし、読もうとしてはいけない */}
      <div ref={containerRef} className="card-container" />

      {!ready && !error && <p className="muted">決済フォームを読み込んでいます…</p>}
      {status && <p className="muted" role="status">{status}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="actions">
        <button type="button" onClick={onCancel} disabled={submitting} className="secondary">
          戻る
        </button>
        <button type="submit" disabled={!ready || submitting}>
          {submitting ? "処理中…" : "この内容で支払う"}
        </button>
      </div>

      <p className="note">
        テスト環境では実際の請求は発生しません。カード番号 4111 1111 1111 1111 /
        有効期限は未来の日付 / CVV は任意の 3 桁でお試しいただけます。
      </p>
    </form>
  );
}

// ---------------------------------------------------------------- errors

class TokenizeError extends Error {
  constructor(readonly errors: SquareFieldError[]) {
    super(errors[0]?.message ?? "カード情報を確認できませんでした");
    this.name = "TokenizeError";
  }
}

/**
 * エラーは「ユーザーが直せるもの」と「直せないもの」で扱いを分ける。
 * 全部を「エラーが発生しました」にすると、直せるのに離脱する。
 *
 * ★ 失敗してもフォームは初期化しない（カード番号の打ち直しは離脱の主因）。
 *   同じ card 要素で tokenize() を呼び直せるので、作り直す必要はない。
 */
function messageFor(e: unknown): string {
  if (e instanceof TokenizeError) {
    const code = e.errors[0]?.code ?? "";
    if (code.includes("CVV")) return "セキュリティコードをご確認ください。";
    if (code.includes("POSTAL") || code.includes("ADDRESS")) return "郵便番号をご確認ください。";
    if (code.includes("EXPIRATION")) return "有効期限をご確認ください。";
    return "カード情報をご確認ください。";
  }

  if (e instanceof ApiError) {
    switch (e.code) {
      case "already_enrolled":
        return "このコースはすでに受講権限をお持ちです。";
      case "payment_declined":
      case "CARD_DECLINED":
      case "GENERIC_DECLINE":
        return "カードが承認されませんでした。別のカードをお試しください。";
      case "INSUFFICIENT_FUNDS":
        return "残高または利用限度額が不足しています。別のカードをお試しください。";
      case "CVV_FAILURE":
        return "セキュリティコードが一致しませんでした。ご確認のうえ、もう一度お試しください。";
      case "CARD_EXPIRED":
        return "カードの有効期限が切れています。別のカードをお試しください。";
      case "too_many_requests":
        return "操作が集中しています。少し時間をおいてからお試しください。";
      case "payments_disabled":
        return "現在お支払いを受け付けておりません。時間をおいてお試しください。";
      case "network_error":
        // Webhook 経路で権限が付く設計なので、この文言は嘘ではない
        return "通信が中断されました。二重に請求されることはありません。しばらくしてからもう一度お試しください。";
      default:
        return "決済を完了できませんでした。しばらくしてからもう一度お試しください。";
    }
  }

  return "決済を完了できませんでした。しばらくしてからもう一度お試しください。";
}
