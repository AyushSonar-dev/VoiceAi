import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { VisionError } from "./errors.js";

/**
 * Root the store-relative image paths are resolved against on disk. The catalog
 * stores public URLs ("/images/products/<slug>.png"), so this is the same
 * directory the static route in index.ts publishes and the browser loads: the
 * bytes the vision model sees are the exact bytes the product page shows.
 */
export const PUBLIC_ASSET_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../public"
);

export interface FetchedImage {
  /** `data:<mime>;base64,…` — what the vision provider expects. */
  dataUrl: string;
  mimeType: string;
  byteLength: number;
  source: "file" | "http";
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function mimeForPath(filePath: string): string {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "image/png";
}

function toDataUrl(mimeType: string, bytes: Buffer): string {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

/**
 * Read a product's image into memory.
 *
 * - a store-relative path ("/images/products/x.png") is read straight off disk
 *   (no HTTP hop, works offline, and immune to which port the server is on);
 * - an absolute http(s) URL is fetched with a timeout and a size cap.
 *
 * Anything else — a missing file, a 404, a non-image response, an oversized or
 * truncated file — raises `image_unavailable` so the caller reports the truth
 * instead of describing something it never saw.
 */
export async function fetchProductImage(imageUrl: string): Promise<FetchedImage> {
  const raw = (imageUrl ?? "").trim();
  if (!raw) throw new VisionError("image_unavailable", "no_image_url");

  if (/^https?:\/\//i.test(raw)) return fetchOverHttp(raw);
  if (raw.startsWith("/")) return readFromDisk(raw);
  throw new VisionError("image_unavailable", "unsupported_image_url");
}

async function readFromDisk(imageUrl: string): Promise<FetchedImage> {
  const relative = imageUrl.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_ASSET_DIR, relative);
  // Traversal guard: the resolved path must stay inside the public asset root.
  if (resolved !== PUBLIC_ASSET_DIR && !resolved.startsWith(PUBLIC_ASSET_DIR + path.sep)) {
    throw new VisionError("image_unavailable", "image_path_rejected");
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(resolved);
  } catch {
    throw new VisionError("image_unavailable", "image_file_missing");
  }
  if (!bytes.length) throw new VisionError("image_unavailable", "image_file_empty");
  if (bytes.length > config.visionImageMaxBytes) {
    throw new VisionError("image_unavailable", "image_too_large");
  }
  const mimeType = mimeForPath(resolved);
  return { dataUrl: toDataUrl(mimeType, bytes), mimeType, byteLength: bytes.length, source: "file" };
}

async function fetchOverHttp(url: string): Promise<FetchedImage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.visionTimeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new VisionError("image_unavailable", `image_http_${res.status}`);
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) {
      // e.g. a dev server answering with index.html for an unknown path
      throw new VisionError("image_unavailable", `image_content_type_${contentType || "unknown"}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) throw new VisionError("image_unavailable", "image_empty_response");
    if (bytes.length > config.visionImageMaxBytes) {
      throw new VisionError("image_unavailable", "image_too_large");
    }
    return { dataUrl: toDataUrl(contentType, bytes), mimeType: contentType, byteLength: bytes.length, source: "http" };
  } catch (err) {
    if (err instanceof VisionError) throw err;
    throw new VisionError("image_unavailable", "image_fetch_failed");
  } finally {
    clearTimeout(timer);
  }
}
