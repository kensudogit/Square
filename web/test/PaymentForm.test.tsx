import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { PaymentForm } from "../src/payments/PaymentForm.js";
import { api, ApiError, type CheckoutIntent, type PublicConfig } from "../src/api.js";
import type { SquareCard, SquarePayments, TokenizeResult } from "../src/payments/square.js";

vi.mock("../src/payments/loadSquareSdk.js", () => ({
  loadSquareSdk: vi.fn(async () => {}),
}));

/**
 * 決済フォーム。
 *
 * ★ ここで守りたいのは 4 点。どれも「本番でだけ壊れる」種類の不具合につながる。
 *
 *   1. StrictMode の二重マウントで card.attach() が 2 回走らない
 *   2. アンマウントで card.destroy() が呼ばれる（iframe が残ると入力欄が二重になる）
 *   3. 否認後の再試行で orderRef を使い回す（サーバー側の attempt 管理が働く前提）
 *   4. 失敗しても入力欄を作り直さない・二重送信しない
 */

const CONFIG: PublicConfig = {
  squareApplicationId: "sandbox-sq0idb-test",
  squareLocationId: "LTEST",
  squareEnvironment: "sandbox",
  currency: "JPY",
  paymentsEnabled: true,
};

const BUYER = { givenName: "太郎", familyName: "山田", email: "buyer@example.test" };

const INTENT: CheckoutIntent = {
  orderRef: "order-1",
  courseId: "course-basic",
  courseTitle: "はじめての決済実装",
  amount: 12000,
  amountLabel: "¥12,000",
  verificationAmount: "12000",
  currency: "JPY",
};

let card: SquareCard & { attach: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
let payments: SquarePayments & { verifyBuyer: ReturnType<typeof vi.fn> };
let cardFactory: ReturnType<typeof vi.fn>;

function tokenizeOk(token = "cnon:card-nonce-ok"): TokenizeResult {
  return { status: "OK", token };
}

beforeEach(() => {
  card = {
    attach: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    tokenize: vi.fn(async () => tokenizeOk()),
  } as unknown as typeof card;

  payments = {
    card: vi.fn(async () => card),
    verifyBuyer: vi.fn(async () => ({ token: "verf_1", userChallenged: false })),
  } as unknown as typeof payments;

  cardFactory = payments.card as ReturnType<typeof vi.fn>;

  window.Square = { payments: vi.fn(() => payments) } as unknown as typeof window.Square;

  vi.spyOn(api, "createCheckoutIntent").mockResolvedValue(INTENT);
  vi.spyOn(api, "submitPayment").mockResolvedValue({ status: "COMPLETED", orderRef: "order-1" });
});

function renderForm(overrides: Partial<Parameters<typeof PaymentForm>[0]> = {}) {
  const props = {
    config: CONFIG,
    courseId: "course-basic",
    buyer: BUYER,
    onSuccess: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  return { ...render(<PaymentForm {...props} />), props };
}

/** 送信ボタンが有効になる（＝カード入力欄の準備が終わる）まで待つ */
async function waitForReady() {
  const button = await screen.findByRole("button", { name: "この内容で支払う" });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

// ---------------------------------------------------------------- 初期化

describe("カード入力欄の初期化", () => {
  test("SDK を読み込んでカード入力欄を差し込む", async () => {
    renderForm();
    await waitForReady();

    expect(window.Square!.payments).toHaveBeenCalledWith("sandbox-sq0idb-test", "LTEST");
    expect(card.attach).toHaveBeenCalledTimes(1);
  });

  // ★ 16px 未満だと iOS Safari が入力時に勝手にズームする
  test("入力欄のフォントサイズは 16px", async () => {
    renderForm();
    await waitForReady();

    expect(cardFactory).toHaveBeenCalledWith(
      expect.objectContaining({ style: { input: { fontSize: "16px" } } }),
    );
  });

  // ★ StrictMode の二重マウント。本番ビルドでは再現しないので、
  //   ここで押さえておかないと開発中しか気付けない
  test("StrictMode で二重マウントされても attach は 1 回", async () => {
    render(
      <StrictMode>
        <PaymentForm
          config={CONFIG}
          courseId="course-basic"
          buyer={BUYER}
          onSuccess={vi.fn()}
          onCancel={vi.fn()}
        />
      </StrictMode>,
    );

    await waitForReady();
    expect(card.attach).toHaveBeenCalledTimes(1);
  });

  // ★ destroy を呼ばないと iframe が残り、再マウントで入力欄が二重になる
  test("アンマウントで card.destroy() が呼ばれる", async () => {
    const { unmount } = renderForm();
    await waitForReady();

    unmount();

    await waitFor(() => expect(card.destroy).toHaveBeenCalled());
  });

  test("準備できるまで送信ボタンは押せない", () => {
    renderForm();
    expect(screen.getByRole("button", { name: "この内容で支払う" })).toBeDisabled();
    expect(screen.getByText("決済フォームを読み込んでいます…")).toBeInTheDocument();
  });

  // ★ SDK の生の英語メッセージを画面に出さない。ログには残す
  test("初期化に失敗したら日本語の案内を出し、詳細はコンソールに残す", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    cardFactory.mockRejectedValue(new Error("Square SDK internal failure"));

    renderForm();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("決済フォームを表示できませんでした");
    expect(alert.textContent).not.toContain("Square SDK internal failure");
    expect(consoleError).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- 決済

describe("決済の実行", () => {
  test("注文作成 → トークン化 → 3DS → 決済 の順に進み、成功を伝える", async () => {
    const { props } = renderForm();
    await userEvent.click(await waitForReady());

    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledWith("order-1"));

    expect(api.createCheckoutIntent).toHaveBeenCalledWith("course-basic");
    expect(card.tokenize).toHaveBeenCalledTimes(1);
    expect(api.submitPayment).toHaveBeenCalledWith({
      orderRef: "order-1",
      sourceId: "cnon:card-nonce-ok",
      verificationToken: "verf_1",
    });
  });

  // ★ 金額はサーバーが作った主単位の文字列をそのまま渡す。
  //   クライアントで最小単位から割ると、多通貨対応したときに 100 倍/百分の一になる
  test("verifyBuyer にはサーバーが用意した金額文字列をそのまま渡す", async () => {
    renderForm();
    await userEvent.click(await waitForReady());

    await waitFor(() => expect(payments.verifyBuyer).toHaveBeenCalled());
    expect(payments.verifyBuyer).toHaveBeenCalledWith("cnon:card-nonce-ok", {
      amount: "12000",
      currencyCode: "JPY",
      intent: "CHARGE",
      billingContact: {
        givenName: "太郎",
        familyName: "山田",
        email: "buyer@example.test",
        countryCode: "JP",
      },
    });
  });

  test("3DS のトークンが返らなければ送らない", async () => {
    payments.verifyBuyer.mockResolvedValue(undefined);

    renderForm();
    await userEvent.click(await waitForReady());

    await waitFor(() => expect(api.submitPayment).toHaveBeenCalled());
    expect(api.submitPayment).toHaveBeenCalledWith({
      orderRef: "order-1",
      sourceId: "cnon:card-nonce-ok",
    });
  });

  // ★ APPROVED で「完了しました」と出すと、実際には確定していないのに受講できると誤解される
  test("COMPLETED 以外は成功にせず、確定待ちであることを伝える", async () => {
    vi.mocked(api.submitPayment).mockResolvedValue({ status: "APPROVED", orderRef: "order-1" });

    const { props } = renderForm();
    await userEvent.click(await waitForReady());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("決済の確定を待っています");
    expect(props.onSuccess).not.toHaveBeenCalled();
  });

  test("戻るボタンで onCancel が呼ばれる", async () => {
    const { props } = renderForm();
    await userEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- 再試行

describe("再試行", () => {
  // ★ submit のたびに intent を取り直すと、失敗のたびに PENDING の注文行が増え、
  //   サーバー側の attempt（冪等性キーの世代）管理も働かなくなる
  test("否認されたら同じ orderRef で再試行する", async () => {
    vi.mocked(api.submitPayment).mockRejectedValueOnce(
      new ApiError(402, "CARD_DECLINED", "payment_declined"),
    );

    renderForm();
    const button = await waitForReady();

    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("カードが承認されませんでした");

    vi.mocked(api.submitPayment).mockResolvedValue({ status: "COMPLETED", orderRef: "order-1" });
    await userEvent.click(button);

    await waitFor(() => expect(api.submitPayment).toHaveBeenCalledTimes(2));
    // 注文は 1 回しか作らない
    expect(api.createCheckoutIntent).toHaveBeenCalledTimes(1);
  });

  // ★ 注文そのものが使えなくなった場合は掴み直す
  test.each([
    [409, "order_refunded"],
    [404, "order_not_found"],
    [403, "forbidden"],
  ])("%i が返ったら次回は注文を作り直す", async (status, code) => {
    vi.mocked(api.submitPayment).mockRejectedValueOnce(new ApiError(status, code, code));

    renderForm();
    const button = await waitForReady();

    await userEvent.click(button);
    await screen.findByRole("alert");

    vi.mocked(api.submitPayment).mockResolvedValue({ status: "COMPLETED", orderRef: "order-2" });
    await userEvent.click(button);

    await waitFor(() => expect(api.createCheckoutIntent).toHaveBeenCalledTimes(2));
  });

  // ★ カード番号の打ち直しは離脱の主因。同じ card 要素で tokenize を呼び直せる
  test("失敗しても入力欄は作り直さない", async () => {
    vi.mocked(api.submitPayment).mockRejectedValueOnce(
      new ApiError(402, "CARD_DECLINED", "payment_declined"),
    );

    renderForm();
    const button = await waitForReady();
    await userEvent.click(button);
    await screen.findByRole("alert");

    expect(card.attach).toHaveBeenCalledTimes(1);
    expect(card.destroy).not.toHaveBeenCalled();
  });

  test("成功した注文は次の購入に持ち越さない", async () => {
    renderForm();
    const button = await waitForReady();

    await userEvent.click(button);
    await waitFor(() => expect(api.submitPayment).toHaveBeenCalledTimes(1));

    await userEvent.click(button);
    await waitFor(() => expect(api.createCheckoutIntent).toHaveBeenCalledTimes(2));
  });
});

// ---------------------------------------------------------------- 二重送信

describe("二重送信の防止", () => {
  test("処理中は送信ボタンが押せない", async () => {
    let release: (result: { status: string; orderRef: string }) => void = () => {};
    vi.mocked(api.submitPayment).mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );

    renderForm();
    const button = await waitForReady();

    await userEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent("処理中…");

    // 押せない状態でも念のためもう一度叩く
    await userEvent.click(button);
    expect(api.submitPayment).toHaveBeenCalledTimes(1);

    release({ status: "COMPLETED", orderRef: "order-1" });
  });

  test("準備できていない状態では送信されない", async () => {
    cardFactory.mockImplementation(() => new Promise(() => {})); // 永久に準備中

    renderForm();
    const form = document.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(api.createCheckoutIntent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- エラーメッセージ

describe("エラーメッセージの出し分け", () => {
  /**
   * ★ 全部を「エラーが発生しました」にすると、ユーザーが直せるのに離脱する。
   *   直せるもの（CVV・郵便番号・有効期限・残高）は具体的に伝える。
   */
  test.each([
    [{ code: "CVV_FAILURE" }, "セキュリティコード"],
    [{ code: "ADDRESS_VERIFICATION_FAILURE" }, "郵便番号"],
    [{ code: "INVALID_EXPIRATION" }, "有効期限"],
    [{ code: "SOMETHING_ELSE" }, "カード情報をご確認ください"],
  ])("トークン化エラー %o は具体的な案内になる", async (fieldError, expected) => {
    card.tokenize = vi.fn(async () => ({ status: "INVALID", errors: [fieldError] })) as never;

    renderForm();
    await userEvent.click(await waitForReady());

    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
    expect(api.submitPayment).not.toHaveBeenCalled();
  });

  test("ABORT でも決済に進まない", async () => {
    card.tokenize = vi.fn(async () => ({ status: "ABORT" })) as never;

    renderForm();
    await userEvent.click(await waitForReady());

    await screen.findByRole("alert");
    expect(api.submitPayment).not.toHaveBeenCalled();
  });

  test.each([
    ["already_enrolled", "すでに受講権限をお持ちです"],
    ["payment_declined", "カードが承認されませんでした"],
    ["GENERIC_DECLINE", "カードが承認されませんでした"],
    ["INSUFFICIENT_FUNDS", "残高または利用限度額が不足しています"],
    ["CVV_FAILURE", "セキュリティコードが一致しませんでした"],
    ["CARD_EXPIRED", "カードの有効期限が切れています"],
    ["too_many_requests", "操作が集中しています"],
    ["payments_disabled", "現在お支払いを受け付けておりません"],
    ["some_unknown_code", "決済を完了できませんでした"],
  ])("API エラー %s は専用の案内になる", async (code, expected) => {
    vi.mocked(api.submitPayment).mockRejectedValue(new ApiError(400, code, code));

    renderForm();
    await userEvent.click(await waitForReady());

    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
  });

  // ★ Webhook 経路で権限が付く設計なので、この文言は嘘ではない
  test("通信断は「二重に請求されない」ことを明示する", async () => {
    vi.mocked(api.submitPayment).mockRejectedValue(
      new ApiError(0, "network_error", "通信に失敗しました"),
    );

    renderForm();
    await userEvent.click(await waitForReady());

    expect(await screen.findByRole("alert")).toHaveTextContent("二重に請求されることはありません");
  });

  test("想定外の例外でも汎用の案内を出す", async () => {
    vi.mocked(api.createCheckoutIntent).mockRejectedValue(new Error("boom"));

    renderForm();
    await userEvent.click(await waitForReady());

    expect(await screen.findByRole("alert")).toHaveTextContent("決済を完了できませんでした");
  });
});
