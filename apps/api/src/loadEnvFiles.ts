import { config } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root when running from apps/api/src */
const repoRoot = resolve(here, "../../..");
const apiEnv = resolve(here, "../.env");

// Monorepo: optional root .env, then apps/api/.env wins for overlapping keys
for (const p of [resolve(repoRoot, ".env"), apiEnv]) {
  if (existsSync(p)) {
    config({ path: p, override: true });
  }
}
