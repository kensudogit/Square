import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

/**
 * JWT による認証。
 *
 * デモ用の最小実装。既存の認証基盤（Auth0 / Firebase / 自前セッション）がある場合は、
 * この middleware だけを差し替えれば決済側は変更不要。
 * 決済 API に必要なのは「req.auth.userId が信頼できること」だけ。
 */

export type AuthUser = { userId: string; email: string };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthUser;
    }
  }
}

const TOKEN_TTL = "2h";

export function issueToken(user: AuthUser): string {
  return jwt.sign(user, config.jwtSecret, { expiresIn: TOKEN_TTL });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    const payload = jwt.verify(header.slice(7), config.jwtSecret);
    if (typeof payload === "string" || !payload.sub && !("userId" in payload)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const { userId, email } = payload as jwt.JwtPayload & AuthUser;
    if (!userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    req.auth = { userId, email };
    next();
  } catch {
    res.status(401).json({ error: "unauthorized" });
  }
}
