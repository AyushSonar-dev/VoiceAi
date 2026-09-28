/**
 * Removes Next's build cache before the dev server starts.
 *
 * Next's RSC bundler can leave a stale React Client Manifest behind, after which
 * every page request fails with:
 *
 *   Could not find the module "..." in the React Client Manifest.
 *   This is probably a bug in the React Server Components bundler.
 *
 * It happens readily on WSL, where the repository sits on a Windows mount:
 * writes to `.next` are slow and the dev server can be interrupted mid-write,
 * leaving the manifest describing modules that were never emitted. The symptom
 * is a 500 that survives editing files and restarting, and the only cure is to
 * delete the cache.
 *
 * So the dev server starts from an empty cache every time. On this filesystem
 * that costs a slower first compile, which is a fair price for a dev server that
 * reliably serves a page.
 */
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const nextDir = join(frontendRoot, ".next");

try {
  await rm(nextDir, { recursive: true, force: true });
  console.log("[cleanNext] removed .next");
} catch (error) {
  // A cache we could not delete is not a reason to refuse to start: the dev
  // server may well be fine, and a hard failure here would block `npm run dev`
  // for something the next run can recover.
  console.warn("[cleanNext] could not remove .next:", error?.message ?? error);
}
