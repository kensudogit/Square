/**
 * 最小限の構造化ログ。
 *
 * 決済まわりでログに出してはいけないもの（トークン類・カード情報）を
 * 機械的に落とす。うっかり丸ごと渡しても漏れないようにするのが目的で、
 * これがあるから何を渡してもよい、という意味ではない。
 */

const REDACT_KEYS = new Set([
  "sourceId", "source_id",
  "verificationToken", "verification_token",
  "accessToken", "access_token",
  "webhookSignatureKey", "signature",
  "password", "passwordHash", "password_hash",
  "token", "jwt", "authorization",
  "cardNumber", "card_number", "cvv", "cvc", "pan",
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.has(k) ? "[REDACTED]" : redact(v, depth + 1);
  }
  return out;
}

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, context: unknown, message: string) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(context && typeof context === "object" ? (redact(context) as object) : {}),
  };
  const text = JSON.stringify(line, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

function make(level: Level) {
  return (contextOrMessage: unknown, maybeMessage?: string) => {
    if (typeof contextOrMessage === "string") emit(level, {}, contextOrMessage);
    else emit(level, contextOrMessage, maybeMessage ?? "");
  };
}

export const logger = {
  debug: make("debug"),
  info: make("info"),
  warn: make("warn"),
  error: make("error"),
};
