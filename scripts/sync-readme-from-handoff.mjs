/**
 * Copies handoff.md → README.md so GitHub shows the same project doc.
 * Run after editing handoff.md: `pnpm sync:readme`
 */
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
copyFileSync(join(root, "handoff.md"), join(root, "README.md"));
