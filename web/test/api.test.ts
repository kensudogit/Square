import { beforeEach, describe, expect, test, vi } from "vitest";
import { api, ApiError, getToken, setToken } from "../src/api.js";

/**
 * API クライアント。
 *
 * ★ ここで守りたいのは「決済リクエストに金額を混ぜない」こと。
 *   amount を送る実装は curl 一発で ¥1 決済を通される穴に直結する。
 *   もう 1 つは「通信が届いたか分からない失敗」を他のエラーと混ぜないこと。
 */

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 直近の fetch 呼び出し */
function lastCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls.at(-1);
  return [call?.[0] as string, (call?.[1] ?? {}) as RequestInit];
}

beforeEach(() => {
  setToken(null);
  // ★ Response は一度しか読めないので、呼び出しごとに新しく作る
  fetchMock = vi.fn().mockImplementation(async () => jsonResponse({}));
  vi.stubGlobal("fetch", fetchMock);
});

// ---------------------------------------------------------------- token

describe("トークンの保持", () => {
  test("setToken で localStorage に保存され、getToken で読める", () => {
    setToken("tok_1");
    expect(getToken()).toBe("tok_1");
    expect(localStorage.getItem("token")).toBe("tok_1");
  });

  test("null を渡すと保存も消える（ログアウト）", () => {
    setToken("tok_1");
    setToken(null);
    expect(getToken()).toBeNull();
    expect(localStorage.getItem("token")).toBeNull();
  });

  test("トークンがあれば Authorization ヘッダが付く", async () => {
    setToken("tok_1");
    await api.me();
    expect((lastCall()[1].headers as Record<string, string>).Authorization).toBe("Bearer tok_1");
  });

  test("トークンが無ければ Authorization ヘッダは付かない", async () => {
    await api.listCourses();
    expect(lastCall()[1].headers).not.toHaveProperty("Authorization");
  });

  test("リロード時は localStorage のトークンから復帰する", async () => {
    localStorage.setItem("token", "tok_from_storage");
    vi.resetModules();

    const fresh = await import("../src/api.js");

    expect(fresh.getToken()).toBe("tok_from_storage");
  });
});

// ---------------------------------------------------------------- エンドポイント

describe("エンドポイント", () => {
  test("getConfig は GET /api/config", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ squareApplicationId: "sandbox-x" }));

    await expect(api.getConfig()).resolves.toMatchObject({ squareApplicationId: "sandbox-x" });
    expect(lastCall()[0]).toBe("/api/config");
  });

  test("login は email と password を送る", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ token: "t", user: { id: "u1" } }));

    await api.login("buyer@example.test", "pw");

    const [url, init] = lastCall();
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      email: "buyer@example.test",
      password: "pw",
    });
  });

  test("createCheckoutIntent は courseId だけを送る", async () => {
    await api.createCheckoutIntent("course-basic");

    const [url, init] = lastCall();
    expect(url).toBe("/api/checkout/intent");
    // ★ 金額を送らない。価格の出所はサーバーの DB だけ
    expect(JSON.parse(init.body as string)).toEqual({ courseId: "course-basic" });
  });

  // ★ 最重要。ここに amount が入ったら設計が崩れている合図
  test("submitPayment は金額を送らない", async () => {
    await api.submitPayment({
      orderRef: "o1",
      sourceId: "cnon:card-nonce-ok",
      verificationToken: "verf_1",
    });

    const body = JSON.parse(lastCall()[1].body as string);
    expect(body).toEqual({
      orderRef: "o1",
      sourceId: "cnon:card-nonce-ok",
      verificationToken: "verf_1",
    });
    expect(body).not.toHaveProperty("amount");
  });

  test("listCourses / listEntitlements / me はそれぞれのパスを叩く", async () => {
    fetchMock.mockImplementation(async () => jsonResponse([]));

    await api.listCourses();
    expect(lastCall()[0]).toBe("/api/courses");

    await api.listEntitlements();
    expect(lastCall()[0]).toBe("/api/me/entitlements");

    fetchMock.mockImplementation(async () => jsonResponse({ id: "u1" }));
    await api.me();
    expect(lastCall()[0]).toBe("/api/auth/me");
  });

  test("Content-Type は常に JSON", async () => {
    await api.listCourses();
    expect((lastCall()[1].headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });
});

// ---------------------------------------------------------------- エラー

describe("エラーの扱い", () => {
  test("204 は本文なしとして扱う（JSON.parse で落ちない）", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.listCourses()).resolves.toBeUndefined();
  });

  test("本文が空の 200 でも落ちない", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    await expect(api.listCourses()).resolves.toEqual({});
  });

  // ★ 「通信が届いたか分からない」失敗。決済ではこの区別が最も重要
  test("通信自体が失敗したら network_error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await api.submitPayment({ orderRef: "o1", sourceId: "x" }).catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.code).toBe("network_error");
  });

  test("エラー応答の code を優先して拾う（カード否認コードを画面で使う）", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "payment_declined", code: "INSUFFICIENT_FUNDS" }, 402),
    );

    const error = await api.submitPayment({ orderRef: "o1", sourceId: "x" }).catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(402);
    expect(error.code).toBe("INSUFFICIENT_FUNDS");
  });

  test("code が無ければ error を code として使う", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "already_enrolled" }, 409));

    const error = await api.createCheckoutIntent("c1").catch((e) => e);

    expect(error.status).toBe(409);
    expect(error.code).toBe("already_enrolled");
  });

  test("error も code も無ければ unknown_error", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));

    const error = await api.listCourses().catch((e) => e);

    expect(error.code).toBe("unknown_error");
    expect(error.message).toBe("エラー");
  });

  test("ApiError は name と status を持つ（画面側の分岐に使う）", () => {
    const error = new ApiError(402, "CARD_DECLINED", "カードが承認されませんでした");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiError");
    expect(error.status).toBe(402);
  });
});
