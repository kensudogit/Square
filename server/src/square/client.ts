import { SquareClient, SquareEnvironment } from "square";
import { config } from "../config.js";

/**
 * Square SDK クライアント（square v45 系＝新世代 SDK）。
 *
 * 旧 SDK（v3x / squareup パッケージ）とは API 名が違う。混在させない。
 *   新: client.payments.create({...})  /  Money.amount は bigint
 *   旧: client.paymentsApi.createPayment({...})
 */
export const square = new SquareClient({
  token: config.square.accessToken,
  environment:
    config.square.environment === "production"
      ? SquareEnvironment.Production
      : SquareEnvironment.Sandbox,
});

export const SQUARE_LOCATION_ID = config.square.locationId;
