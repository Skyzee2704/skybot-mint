/**
 * Tiny logger with secret redaction. Never log keys/passwords/tokens.
 */
const SECRET_FIELDS = new Set([
  "password", "privateKey", "privateKeys", "private_key", "key", "keys", "masterPassword",
  "mnemonic", "seed", "token", "accessToken", "access_token", "idToken", "refreshToken",
  "apiKey", "api_key", "authorization", "authorization_private_keys", "secret", "appSecret",
  "privyAppSecret", "webhookSecret", "initData",
]);
const HEX64 = /\b(0x)?[0-9a-fA-F]{64}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const PEM = /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g;

export function redactString(v: string): string {
  return v
    .replace(PEM, "[REDACTED_PEM]")
    .replace(JWT, "[REDACTED_JWT]")
    .replace(/(https?:\/\/[^\s/"'?]+)[^\s"']*/gi, (_m, host) => `${host}/***`)
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_BOT_TOKEN]")
    .replace(HEX64, "[REDACTED_HEX64]");
}

export function redact(v: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof v === "string") return redactString(v);
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") {
    if (v instanceof Error) return { name: v.name, message: redact(v.message) };
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      const lk = k.toLowerCase();
      out[k] = SECRET_FIELDS.has(k) || SECRET_FIELDS.has(lk) || /secret|password|private|mnemonic|token|authorization/i.test(k)
        ? "[REDACTED]"
        : redact(val, depth + 1);
    }
    return out;
  }
  return v;
}

function emit(level: string, msg: string, extra?: unknown) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${redact(msg)}`;
  if (extra !== undefined) console.log(line, JSON.stringify(redact(extra)));
  else console.log(line);
}
export const log = {
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};
