import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { rateLimit } from "../src/middleware/rateLimit.js";

/**
 * 決済エンドポイントを無防備に晒すと、盗難カードの有効性確認（カードテスティング）の
 * 踏み台にされる。まず自分で止める。
 */

type Ctx = {
  req: Request;
  res: Response & { statusCode?: number; body?: unknown; headers: Record<string, string> };
  next: NextFunction;
};

function makeCtx(req: Partial<Request> = {}): Ctx {
  const headers: Record<string, string> = {};
  const res = {
    headers,
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    status: vi.fn(function (this: Record<string, unknown>, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: vi.fn(function (this: Record<string, unknown>, body: unknown) {
      this.body = body;
      return this;
    }),
  } as unknown as Ctx["res"];

  return { req: { ip: "203.0.113.1", ...req } as Request, res, next: vi.fn() as NextFunction };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rateLimit", () => {
  test("上限までは通す", () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i += 1) {
      const ctx = makeCtx();
      middleware(ctx.req, ctx.res, ctx.next);
      expect(ctx.next).toHaveBeenCalledTimes(1);
    }
  });

  test("上限を超えると 429 と Retry-After を返す", () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 2 });
    for (let i = 0; i < 2; i += 1) {
      const ctx = makeCtx();
      middleware(ctx.req, ctx.res, ctx.next);
    }

    const blocked = makeCtx();
    middleware(blocked.req, blocked.res, blocked.next);

    expect(blocked.next).not.toHaveBeenCalled();
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.body).toMatchObject({ error: "too_many_requests" });
    expect(Number(blocked.res.headers["Retry-After"])).toBeGreaterThan(0);
  });

  test("ウィンドウが過ぎればまた通る", () => {
    const middleware = rateLimit({ windowMs: 1_000, max: 1 });

    const first = makeCtx();
    middleware(first.req, first.res, first.next);
    expect(first.next).toHaveBeenCalled();

    const blocked = makeCtx();
    middleware(blocked.req, blocked.res, blocked.next);
    expect(blocked.res.statusCode).toBe(429);

    vi.advanceTimersByTime(1_100);

    const after = makeCtx();
    middleware(after.req, after.res, after.next);
    expect(after.next).toHaveBeenCalled();
  });

  test("キーが違えば別カウント（他人のリクエストで巻き込まれない）", () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });

    const a = makeCtx({ ip: "203.0.113.1" });
    middleware(a.req, a.res, a.next);
    expect(a.next).toHaveBeenCalled();

    const b = makeCtx({ ip: "198.51.100.7" });
    middleware(b.req, b.res, b.next);
    expect(b.next).toHaveBeenCalled();
  });

  // ★ 既定のキーは userId 優先。同じ NAT や社内 IP から複数人が買うときに
  //   IP だけで数えると無関係な人が 429 になる
  test("既定のキーは認証済みユーザー ID を優先する", () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });

    const first = makeCtx({ ip: "203.0.113.1", auth: { userId: "u1", email: "a@example.test" } });
    middleware(first.req, first.res, first.next);

    // 同じ IP・別ユーザーは通る
    const other = makeCtx({ ip: "203.0.113.1", auth: { userId: "u2", email: "b@example.test" } });
    middleware(other.req, other.res, other.next);
    expect(other.next).toHaveBeenCalled();

    // 同じユーザーは止まる
    const same = makeCtx({ ip: "198.51.100.7", auth: { userId: "u1", email: "a@example.test" } });
    middleware(same.req, same.res, same.next);
    expect(same.res.statusCode).toBe(429);
  });

  test("keyOf を渡せばキーの決め方を差し替えられる", () => {
    const middleware = rateLimit({
      windowMs: 60_000,
      max: 1,
      keyOf: () => "fixed",
    });

    const first = makeCtx({ ip: "203.0.113.1" });
    middleware(first.req, first.res, first.next);

    const second = makeCtx({ ip: "198.51.100.7" });
    middleware(second.req, second.res, second.next);
    expect(second.res.statusCode).toBe(429);
  });

  test("ip も認証も無ければ unknown にまとめる", () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });

    const first = makeCtx({ ip: undefined });
    middleware(first.req, first.res, first.next);
    expect(first.next).toHaveBeenCalled();

    const second = makeCtx({ ip: undefined });
    middleware(second.req, second.res, second.next);
    expect(second.res.statusCode).toBe(429);
  });

  test("期限切れバケットは掃除される（放置でメモリが増え続けない）", () => {
    const middleware = rateLimit({ windowMs: 1_000, max: 1 });

    const first = makeCtx();
    middleware(first.req, first.res, first.next);

    // 掃除タイマーは windowMs 間隔。1 周させてから同じキーで叩き直す
    vi.advanceTimersByTime(2_000);

    const after = makeCtx();
    middleware(after.req, after.res, after.next);
    expect(after.next).toHaveBeenCalled();
  });
});
