import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { courses, entitlements } from "../db/repositories.js";
import { formatAmount } from "../domain/money.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const coursesRouter = Router();

/** GET /api/courses — 一覧。ログイン済みなら購入済みフラグも返す */
coursesRouter.get("/courses", async (req: Request, res: Response) => {
  const list = await courses.listPurchasable();
  res.json(
    list.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      amount: c.price_minor_units,
      amountLabel: formatAmount(c.price_minor_units, c.currency),
      currency: c.currency,
    })),
  );
});

/** GET /api/me/entitlements — 自分の受講権限 */
coursesRouter.get("/me/entitlements", requireAuth, async (req: Request, res: Response) => {
  const list = await entitlements.listActive(req.auth!.userId);
  res.json(
    list.map((e) => ({
      courseId: e.course_id,
      title: e.title,
      grantedAt: e.granted_at,
      orderRef: e.order_ref,
    })),
  );
});

/** GET /api/config — フロントに渡してよい値だけ返す（access token は絶対に含めない） */
coursesRouter.get("/config", (_req: Request, res: Response) => {
  res.json({
    squareApplicationId: config.square.applicationId,
    squareLocationId: config.square.locationId,
    squareEnvironment: config.square.environment,
    currency: config.currency,
    paymentsEnabled: config.paymentsEnabled,
  });
});
