import type { VisualAttributeKey, VisionAnalysis } from "./attributes.js";

/**
 * A deliberately small, in-memory, per-session cache of visual analyses.
 *
 * Why it exists: follow-up questions ("does it have long sleeves?", "is the
 * pattern floral?") must not re-send the same image to the vision model — the
 * facts are already known. It is deliberately NOT in MongoDB: it is derived,
 * disposable, expires on its own, and must never become a second source of
 * truth for product data.
 */
const TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_SESSIONS = 200;
const MAX_PRODUCTS_PER_SESSION = 8;

interface CacheEntry {
  analysis: VisionAnalysis;
  imageUrl: string;
  analyzedAt: number;
}

const bySession = new Map<string, Map<string, CacheEntry>>();
const lastDescribed = new Map<string, string>();
const bucketLastTouched = new Map<string, Date>();

function sessionBucket(sessionId: string): Map<string, CacheEntry> | null {
  const bucket = bySession.get(sessionId);
  if (!bucket) return null;
  const touched = bucketLastTouched.get(sessionId);
  if (touched && Date.now() - touched.getTime() > TTL_MS) {
    bySession.delete(sessionId);
    lastDescribed.delete(sessionId);
    bucketLastTouched.delete(sessionId);
    return null;
  }
  return bucket;
}

export function getCachedVisual(
  sessionId: string,
  productId: string
): { analysis: VisionAnalysis; imageUrl: string; analyzedAt: number } | null {
  const bucket = sessionBucket(sessionId);
  if (!bucket) return null;
  const entry = bucket.get(productId);
  if (!entry) return null;
  if (Date.now() - entry.analyzedAt > TTL_MS) {
    bucket.delete(productId);
    return null;
  }
  return entry;
}

export function setCachedVisual(
  sessionId: string,
  productId: string,
  analysis: VisionAnalysis,
  imageUrl: string
): void {
  const bucket = bySession.get(sessionId) ?? new Map<string, CacheEntry>();
  bucket.delete(productId);
  bucket.set(productId, { analysis, imageUrl, analyzedAt: Date.now() });
  while (bucket.size > MAX_PRODUCTS_PER_SESSION) {
    const oldest = bucket.keys().next();
    if (oldest.done) break;
    bucket.delete(oldest.value);
  }
  bySession.set(sessionId, bucket);
  bucketLastTouched.set(sessionId, new Date());
  lastDescribed.set(sessionId, productId);

  while (bySession.size > MAX_SESSIONS) {
    const oldest = bySession.keys().next();
    if (oldest.done) break;
    bySession.delete(oldest.value);
    bucketLastTouched.delete(oldest.value);
    lastDescribed.delete(oldest.value);
  }
}

/**
 * Which product's photo was described most recently in this session. Lets the
 * agent resolve "this one" / "it" for a follow-up visual question, since the
 * per-turn tool loop starts from a fresh message list every time.
 */
export function getLastDescribedProductId(sessionId: string): string | null {
  sessionBucket(sessionId);
  return lastDescribed.get(sessionId) ?? null;
}

/** Attributes for a follow-up answer, or null when nothing is cached. */
export function getCachedAttribute(
  sessionId: string,
  productId: string,
  key: VisualAttributeKey
): string | null {
  return getCachedVisual(sessionId, productId)?.analysis.attributes[key] ?? null;
}

// Test hook (matches the existing __resetStoreForTests / __resetLlmForTests
// convention).
export function __clearVisualCache(): void {
  bySession.clear();
  bucketLastTouched.clear();
  lastDescribed.clear();
}
