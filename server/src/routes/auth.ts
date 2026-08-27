import { Router, type Request, type Response } from "express";
import { users } from "../db/repositories.js";
import { verifyPassword } from "../db/password.js";
import { issueToken, requireAuth } from "../middleware/requireAuth.js";
import { rateLimit } from "../middleware/rateLimit.js";

export const authRouter = Router();

/**
 * POST /api/auth/login  { email, password }
 *
 * デモ用の最小実装。既存の認証基盤があるならこのルートごと差し替える。
 * 決済側が必要としているのは requireAuth が req.auth.userId を埋めることだけ。
 */
authRouter.post(
  "/auth/login",
  rateLimit({ windowMs: 60_000, max: 10, keyOf: (req) => req.ip ?? "unknown" }),
  async (req: Request, res: Response) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      res.status(400).json({ error: "email and password are required" });
      return;
    }

    const user = await users.findByEmail(email);
    // ユーザーの存在有無を応答で区別しない
    if (!user || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }

    res.json({
      token: issueToken({ userId: user.id, email: user.email }),
      user: { id: user.id, email: user.email, displayName: user.display_name },
    });
  },
);

authRouter.get("/auth/me", requireAuth, async (req: Request, res: Response) => {
  const user = await users.findById(req.auth!.userId);
  if (!user) {
    res.status(404).json({ error: "user_not_found" });
    return;
  }
  res.json({ id: user.id, email: user.email, displayName: user.display_name });
});
