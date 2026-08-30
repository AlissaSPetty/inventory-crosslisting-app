import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

const IV_LEN = 16;
const KEY_LEN = 32;

/**
 * SHA-256 hex of `input`. Used to store extension device tokens / pairing codes
 * hashed at rest — these are high-entropy random secrets, so a fast hash is
 * correct here (bcrypt/argon2 are for low-entropy passwords).
 */
export function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Opaque 256-bit random bearer token (base64url), for extension device auth. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Human-pasteable 96-bit pairing code, grouped for readability (e.g. `A1B2-...`). */
export function randomPairingCode(): string {
  const hex = randomBytes(12).toString("hex").toUpperCase();
  return (hex.match(/.{1,4}/g) ?? []).join("-");
}

/** Normalize (strip separators, upper-case) then hash a pairing code — mint and verify must agree. */
export function pairingCodeHash(code: string): string {
  return sha256hex(code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase());
}

function keyFromSecret(secret: string): Buffer {
  return scryptSync(secret, "inv-salt", KEY_LEN);
}

export function encryptString(secret: string, plain: string): string {
  const key = keyFromSecret(secret);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

export function decryptString(secret: string, blob: string): string {
  const raw = Buffer.from(blob, "base64url");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + 16);
  const data = raw.subarray(IV_LEN + 16);
  const key = keyFromSecret(secret);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
