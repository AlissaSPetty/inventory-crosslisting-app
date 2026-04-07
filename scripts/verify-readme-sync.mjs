/**
 * Fails if README.md differs from handoff.md (CI + local check).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const handoff = readFileSync(join(root, "handoff.md"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
if (handoff !== readme) {
  console.error("README.md is out of sync with handoff.md. Run: pnpm sync:readme");
  process.exit(1);
}
