/**
 * バックエンド API クライアント。
 *
 * ★ 決済リクエストに金額を含めない。サーバーが courseId から金額を引く。
 *   ここに amount を足したくなったら、それは設計が崩れている合図。
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let authToken: string | null = localStorage.getItem("token");

export function setToken(token: string | null): void {
  authToken = token;
  if (token) localStorage.setItem("token", token);
  else localStorage.removeItem("token");
}

export function getToken(): string | null {
  return authToken;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...init?.headers,
      },
    });
  } catch {
    // 通信が届いたかどうか分からない状態。決済では特に重要な区別
    throw new ApiError(0, "network_error", "通信に失敗しました");
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const err = body as { error?: string; code?: string };
    throw new ApiError(response.status, err.code ?? err.error ?? "unknown_error", err.error ?? "エラー");
  }
  return body as T;
}

// ---------------------------------------------------------------- types

export type PublicConfig = {
  squareApplicationId: string;
  squareLocationId: string;
  squareEnvironment: "sandbox" | "production";
  currency: string;
  paymentsEnabled: boolean;
};

export type Course = {
  id: string;
  title: string;
  description: string;
  amount: number;
  amountLabel: string;
  currency: string;
};

export type CheckoutIntent = {
  orderRef: string;
  courseId: string;
  courseTitle: string;
  amount: number;
  amountLabel: string;
  /** verifyBuyer に渡す主単位の文字列。クライアントで単位変換しないための値 */
  verificationAmount: string;
  currency: string;
};

export type PaymentResult = { status: string; orderRef: string };

export type Entitlement = { courseId: string; title: string; grantedAt: string; orderRef: string };

export type LoginResult = {
  token: string;
  user: { id: string; email: string; displayName: string };
};

// ---------------------------------------------------------------- endpoints

export const api = {
  getConfig: () => request<PublicConfig>("/api/config"),

  login: (email: string, password: string) =>
    request<LoginResult>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  me: () => request<{ id: string; email: string; displayName: string }>("/api/auth/me"),

  listCourses: () => request<Course[]>("/api/courses"),

  listEntitlements: () => request<Entitlement[]>("/api/me/entitlements"),

  /** 決済の前にサーバーが金額を確定し、注文レコードを作る */
  createCheckoutIntent: (courseId: string) =>
    request<CheckoutIntent>("/api/checkout/intent", {
      method: "POST",
      body: JSON.stringify({ courseId }),
    }),

  submitPayment: (input: { orderRef: string; sourceId: string; verificationToken?: string }) =>
    request<PaymentResult>("/api/payments", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
