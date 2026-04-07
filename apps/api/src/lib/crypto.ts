import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const IV_LEN = 16;
const KEY_LEN = 32;

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
