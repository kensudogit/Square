import { describe, expect, test, vi } from "vitest";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { config } from "../src/config.js";
import { issueToken, requireAuth } from "../src/middleware/requireAuth.js";

/**
 * 決済側がこの middleware に期待しているのは
 * 「req.auth.userId が信頼できること」だけ。逆に言うと、ここが緩いと
 * 他人の注文で決済できる穴に直結する。
 */

function run(authorization?: string) {
  const req = {
    header: (name: string) =>
      name.toLowerCase() === "authorization" ? authorization : undefined,
  } as unknown as Request;

  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };

  const next = vi.fn() as unknown as NextFunction;
  requireAuth(req, res as unknown as Response, next);
  return { req, res, next };
}

describe("issueToken / requireAuth", () => {
  test("発行したトークンは検証を通り、req.auth が埋まる", () => {
    const token = issueToken({ userId: "u1", email: "buyer@example.test" });
    const { req, res, next } = run(`Bearer ${token}`);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
    expect(req.auth).toEqual({ userId: "u1", email: "buyer@example.test" });
  });

  test("Authorization ヘッダが無ければ 401", () => {
    const { res, next } = run(undefined);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
    expect(next).not.toHaveBeenCalled();
  });

  test("Bearer 以外のスキームは 401", () => {
    expect(run("Basic dXNlcjpwYXNz").res.statusCode).toBe(401);
    expect(run("Token abc").res.statusCode).toBe(401);
  });

  test("壊れたトークンは 401（例外を漏らして 500 にしない）", () => {
    expect(run("Bearer not-a-jwt").res.statusCode).toBe(401);
  });

  // ★ 署名キーを見ずに payload を信じる実装だと、ここが通ってしまう
  test("別の鍵で署名されたトークンは 401", () => {
    const forged = jwt.sign({ userId: "attacker", email: "x@example.test" }, "another-secret");
    expect(run(`Bearer ${forged}`).res.statusCode).toBe(401);
  });

  test("期限切れのトークンは 401", () => {
    const expired = jwt.sign({ userId: "u1", email: "a@example.test" }, config.jwtSecret, {
      expiresIn: "-1s",
    });
    expect(run(`Bearer ${expired}`).res.statusCode).toBe(401);
  });

  test("userId を含まないトークンは 401（誰の注文か決まらない）", () => {
    const noUser = jwt.sign({ sub: "u1", email: "a@example.test" }, config.jwtSecret);
    expect(run(`Bearer ${noUser}`).res.statusCode).toBe(401);
  });

  test("payload がオブジェクトでないトークンは 401", () => {
    const stringPayload = jwt.sign("just-a-string", config.jwtSecret);
    expect(run(`Bearer ${stringPayload}`).res.statusCode).toBe(401);
  });

  test("発行されるトークンには有効期限が入っている", () => {
    const decoded = jwt.decode(issueToken({ userId: "u1", email: "a@example.test" }));
    expect(decoded).toMatchObject({ userId: "u1" });
    expect(typeof (decoded as jwt.JwtPayload).exp).toBe("number");
  });
});
