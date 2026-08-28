import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App.js";
import { api, ApiError, getToken, setToken, type Course, type PublicConfig } from "../src/api.js";

// 決済フォームそのものは PaymentForm.test.tsx で見る。
// ここでは「どんな props で開かれるか」と画面遷移だけを確かめる
vi.mock("../src/payments/PaymentForm.js", () => ({
  PaymentForm: (props: {
    courseId: string;
    buyer: { givenName: string; familyName: string; email: string };
    onSuccess: (orderRef: string) => void;
    onCancel: () => void;
  }) => (
    <div data-testid="payment-form" data-course={props.courseId} data-buyer={JSON.stringify(props.buyer)}>
      <button onClick={() => props.onSuccess("order-1")}>支払い成功（テスト用）</button>
      <button onClick={props.onCancel}>支払いをやめる（テスト用）</button>
    </div>
  ),
}));

const CONFIG: PublicConfig = {
  squareApplicationId: "sandbox-sq0idb-test",
  squareLocationId: "LTEST",
  squareEnvironment: "sandbox",
  currency: "JPY",
  paymentsEnabled: true,
};

const COURSES: Course[] = [
  {
    id: "course-basic",
    title: "はじめての決済実装",
    description: "Square で決済を組む",
    amount: 12000,
    amountLabel: "¥12,000",
    currency: "JPY",
  },
  {
    id: "course-advanced",
    title: "決済の運用",
    description: "照合と返金",
    amount: 24000,
    amountLabel: "¥24,000",
    currency: "JPY",
  },
];

const USER = { id: "u1", email: "buyer@example.test", displayName: "山田 太郎" };

beforeEach(() => {
  setToken(null);
  vi.spyOn(api, "getConfig").mockResolvedValue(CONFIG);
  vi.spyOn(api, "listCourses").mockResolvedValue(COURSES);
  vi.spyOn(api, "listEntitlements").mockResolvedValue([]);
  vi.spyOn(api, "me").mockResolvedValue(USER);
  vi.spyOn(api, "login").mockResolvedValue({ token: "tok_1", user: USER });
});

/** ログイン済みの状態で開く */
async function renderLoggedIn() {
  setToken("tok_1");
  render(<App />);
  await screen.findByText("コース一覧");
}

// ---------------------------------------------------------------- 起動

describe("起動", () => {
  test("設定を取れるまでは読み込み中を出す", () => {
    render(<App />);
    expect(screen.getByText("読み込み中…")).toBeInTheDocument();
  });

  // ★ 「決済フォームが出ない」ではなく「サーバーが落ちている」と伝える
  test("設定を取れなければ原因の手掛かりを出す", async () => {
    vi.mocked(api.getConfig).mockRejectedValue(new ApiError(0, "network_error", "x"));

    render(<App />);

    expect(await screen.findByText(/サーバーに接続できません/)).toBeInTheDocument();
  });

  // ★ 本番の application ID を貼ったまま気付かない事故を、画面上でも見えるようにする
  test("sandbox のときはバッジを出す", async () => {
    render(<App />);
    expect(await screen.findByText(/SANDBOX/)).toBeInTheDocument();
  });

  test("production ではバッジを出さない", async () => {
    vi.mocked(api.getConfig).mockResolvedValue({ ...CONFIG, squareEnvironment: "production" });

    render(<App />);
    await screen.findByRole("heading", { name: "ログイン" });

    expect(screen.queryByText(/SANDBOX/)).not.toBeInTheDocument();
  });

  test("トークンが無ければ me を叩かない", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "ログイン" });
    expect(api.me).not.toHaveBeenCalled();
  });

  test("トークンがあれば自動でログイン状態になる", async () => {
    await renderLoggedIn();
    expect(screen.getByText("山田 太郎")).toBeInTheDocument();
  });

  // ★ 期限切れトークンを持ったまま操作すると、全部 401 になって理由が分からなくなる
  test("トークンが無効ならログアウト状態に戻す", async () => {
    setToken("expired");
    vi.mocked(api.me).mockRejectedValue(new ApiError(401, "unauthorized", "x"));

    render(<App />);

    await screen.findByRole("heading", { name: "ログイン" });
    await waitFor(() => expect(getToken()).toBeNull());
  });
});

// ---------------------------------------------------------------- ログイン

describe("ログイン", () => {
  test("成功するとトークンを保存してコース一覧を出す", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "ログイン" });

    await userEvent.type(screen.getByLabelText("パスワード"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "ログイン" }));

    await screen.findByText("コース一覧");
    expect(getToken()).toBe("tok_1");
    expect(api.login).toHaveBeenCalledWith("taro@example.com", "pw");
  });

  test("資格情報が違えば専用の案内を出す", async () => {
    vi.mocked(api.login).mockRejectedValue(new ApiError(401, "invalid_credentials", "x"));

    render(<App />);
    await screen.findByRole("heading", { name: "ログイン" });
    await userEvent.click(screen.getByRole("button", { name: "ログイン" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "メールアドレスまたはパスワードが正しくありません",
    );
  });

  test("それ以外の失敗は汎用の案内", async () => {
    vi.mocked(api.login).mockRejectedValue(new ApiError(500, "internal_error", "x"));

    render(<App />);
    await screen.findByRole("heading", { name: "ログイン" });
    await userEvent.click(screen.getByRole("button", { name: "ログイン" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("ログインできませんでした");
  });

  test("メールアドレスは編集できる", async () => {
    render(<App />);
    const input = await screen.findByLabelText("メールアドレス");

    await userEvent.clear(input);
    await userEvent.type(input, "other@example.test");

    expect(input).toHaveValue("other@example.test");
  });

  test("ログアウトするとトークンを捨ててログイン画面に戻る", async () => {
    await renderLoggedIn();

    await userEvent.click(screen.getByRole("button", { name: "ログアウト" }));

    expect(getToken()).toBeNull();
    expect(await screen.findByRole("heading", { name: "ログイン" })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- コース一覧

describe("コース一覧", () => {
  test("価格はサーバーが整形した文字列をそのまま出す", async () => {
    await renderLoggedIn();

    expect(screen.getByText("¥12,000")).toBeInTheDocument();
    expect(screen.getByText("¥24,000")).toBeInTheDocument();
  });

  test("購入済みのコースは申し込みボタンを出さない", async () => {
    vi.mocked(api.listEntitlements).mockResolvedValue([
      {
        courseId: "course-basic",
        title: "はじめての決済実装",
        grantedAt: "2026-01-02T03:04:05.000Z",
        orderRef: "order-1",
      },
    ]);

    await renderLoggedIn();

    // コース名は「受講中のコース」欄にも出るので、一覧の中に絞って探す
    const courseList = document.querySelector<HTMLElement>("section.courses")!;
    const owned = within(courseList).getByText("はじめての決済実装").closest("li")!;
    expect(within(owned).getByText("受講中")).toBeInTheDocument();
    expect(within(owned).queryByRole("button", { name: "申し込む" })).not.toBeInTheDocument();
  });

  // ★ サーバー側で決済を止めたとき、画面も追随しないと 503 を見てから気付くことになる
  test("決済停止中は理由を出し、申し込みボタンを押せなくする", async () => {
    vi.mocked(api.getConfig).mockResolvedValue({ ...CONFIG, paymentsEnabled: false });

    await renderLoggedIn();

    expect(screen.getByText(/現在お支払いを停止しています/)).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "申し込む" })) {
      expect(button).toBeDisabled();
    }
  });

  test("受講権限の取得に失敗しても一覧は表示する", async () => {
    vi.mocked(api.listEntitlements).mockRejectedValue(new ApiError(500, "internal_error", "x"));

    await renderLoggedIn();

    const courseList = document.querySelector<HTMLElement>("section.courses")!;
    expect(within(courseList).getByText("はじめての決済実装")).toBeInTheDocument();
    expect(screen.queryByText("受講中のコース")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- 購入の流れ

describe("購入の流れ", () => {
  test("申し込むと決済フォームに切り替わる", async () => {
    await renderLoggedIn();

    await userEvent.click(screen.getAllByRole("button", { name: "申し込む" })[0]!);

    const form = await screen.findByTestId("payment-form");
    expect(form).toHaveAttribute("data-course", "course-basic");
  });

  // ★ 姓名を 1 つの文字列で持っている場合の分割。billingContact に必要
  test("表示名を姓と名に分けて渡す", async () => {
    await renderLoggedIn();
    await userEvent.click(screen.getAllByRole("button", { name: "申し込む" })[0]!);

    const form = await screen.findByTestId("payment-form");
    expect(JSON.parse(form.getAttribute("data-buyer")!)).toEqual({
      familyName: "山田",
      givenName: "太郎",
      email: "buyer@example.test",
    });
  });

  test("戻ると一覧に返る", async () => {
    await renderLoggedIn();
    await userEvent.click(screen.getAllByRole("button", { name: "申し込む" })[0]!);
    await screen.findByTestId("payment-form");

    await userEvent.click(screen.getByRole("button", { name: "支払いをやめる（テスト用）" }));

    expect(await screen.findByText("コース一覧")).toBeInTheDocument();
  });

  test("成功すると完了画面を出し、受講中のコースを取り直す", async () => {
    await renderLoggedIn();
    await userEvent.click(screen.getAllByRole("button", { name: "申し込む" })[0]!);
    await screen.findByTestId("payment-form");

    vi.mocked(api.listEntitlements).mockResolvedValue([
      {
        courseId: "course-basic",
        title: "はじめての決済実装",
        grantedAt: "2026-01-02T03:04:05.000Z",
        orderRef: "order-1",
      },
    ]);

    await userEvent.click(screen.getByRole("button", { name: "支払い成功（テスト用）" }));

    expect(await screen.findByText("お申し込みが完了しました")).toBeInTheDocument();
    expect(await screen.findByText("受講中のコース")).toBeInTheDocument();
  });

  test("完了画面から一覧に戻れる", async () => {
    await renderLoggedIn();
    await userEvent.click(screen.getAllByRole("button", { name: "申し込む" })[0]!);
    await screen.findByTestId("payment-form");
    await userEvent.click(screen.getByRole("button", { name: "支払い成功（テスト用）" }));
    await screen.findByText("お申し込みが完了しました");

    await userEvent.click(screen.getByRole("button", { name: "コース一覧へ戻る" }));

    expect(await screen.findByText("コース一覧")).toBeInTheDocument();
  });
});
