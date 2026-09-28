import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256-bit random tokens, base64url (43 characters). Only their SHA-256 is ever stored. */
export const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function newId(): string {
  return randomBytes(12).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

/** Constant-time comparison of a presented secret with a stored hash. */
export function matchesHash(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(secret), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
