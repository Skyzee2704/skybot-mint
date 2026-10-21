/**
 * Tiny logger with secret redaction. Never log keys/passwords: anything that looks like a
 * 32-byte hex private key is masked, and known secret fields are dropped.
 */
const SECRET_FIELDS = new Set(["password", "privateKey", "privateKeys", "key", "keys", "masterPassword", "mnemonic", "token", "apiKey"]);
const HEX64 = /\b(0x)?[0-9a-fA-F]{64}\b/g;

/** Mask 32-byte hex (private keys) and URL paths/queries (RPC API keys). Tx hashes are also 32 bytes,
 *  so only strings outside known-safe contexts get masked; callers pass hashes as structured fields. */
export function redactString(v: string): string {
  return v
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
    for (const [k, val] of Object.entries(v)) out[k] = SECRET_FIELDS.has(k) ? "[REDACTED]" : redact(val, depth + 1);
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
