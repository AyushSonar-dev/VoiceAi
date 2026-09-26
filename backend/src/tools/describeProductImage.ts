import {
  ok,
  fail,
  requireSession,
  assertReferencable,
  getStore,
} from "./shared.js";
import {
  analyzeProductImage,
  getCachedVisual,
  setCachedVisual,
  getLastDescribedProductId,
  VisionError,
  type VisionAnalysis,
} from "../vision/index.js";
import type { Product, ToolResult } from "../types.js";

export interface DescribeProductImageParams {
  sessionId: string;
  productId?: string;
}

/**
 * Spoken replies for the three ways this can legitimately fail. Kept verbatim so
 * the agent never has to invent its own wording — it reads `message` and repeats
 * it. There is no "based on the product name, it is probably..." path.
 */
const SAY = {
  imageUnavailable: "I can't access the image for this product right now.",
  visionFailed:
    "I couldn't analyze the product image right now. You can still ask me about its price, rating, or specifications.",
  uncertainDetail: "I can't reliably determine that detail from the image.",
  ambiguousProduct: "Which product do you mean — the first one or the second one?",
} as const;

export { SAY as VISUAL_REPLIES };

/**
 * Look at one product's photo and report only what is actually visible.
 *
 * Read-only and strictly scoped:
 *  - the id must already be referenceable in this session (never a guessed id),
 *  - the model is sent the image bytes only — no name, category, price or specs,
 *    so the answer cannot be anchored to the catalog text,
 *  - the result is cached per session, so a follow-up ("is it pockets?") is
 *    answered from the same single analysis instead of a second model call.
 */
export async function describeProductImage(params: DescribeProductImageParams): Promise<ToolResult> {
  const store = getStore();
  const session = await requireSession(params.sessionId);

  // "what colour is it?" with a single product already described means that one
  const productId = params.productId || getLastDescribedProductId(params.sessionId);
  if (!productId) {
    return fail("no_product_in_context", SAY.ambiguousProduct, {
      needsClarification: true,
    });
  }

  assertReferencable(session, productId);

  const product = await store.getProductById(productId);
  if (!product) return fail("product_not_found", "That product could not be found.");

  if (!product.imageUrl) {
    return fail("image_unavailable", SAY.imageUnavailable, { productId: product.id });
  }

  // a repeated question ("and the sleeves?") is answered from the cache: the
  // user is asking about the photo we already looked at, not a new one
  const cached = getCachedVisual(params.sessionId, product.id);
  if (cached) {
    return visualResult(product, cached.analysis, true);
  }

  try {
    const { analysis } = await analyzeProductImage({ imageUrl: product.imageUrl, productId: product.id });
    setCachedVisual(params.sessionId, product.id, analysis, product.imageUrl);
    return visualResult(product, analysis, false);
  } catch (err) {
    if (err instanceof VisionError) {
      if (err.code === "image_unavailable") {
        return fail("image_unavailable", SAY.imageUnavailable, { productId: product.id });
      }
      return fail("vision_failed", SAY.visionFailed, { productId: product.id, reason: err.detail });
    }
    console.error("[ECHOLABS] describeProductImage crashed", err);
    return fail("vision_failed", SAY.visionFailed, { productId: product.id });
  }
}

/**
 * `message` is the speakable line; `data` carries the structured facts so the
 * agent can answer a follow-up ("is it sleeveless?") without a second model
 * call, and the UI can show what was actually observed.
 */
function visualResult(product: Product, analysis: VisionAnalysis, fromCache: boolean): ToolResult {
  return ok(analysis.description, {
    productId: product.id,
    name: product.name,
    imageUrl: product.imageUrl,
    description: analysis.description,
    attributes: analysis.attributes,
    notDetermined: analysis.notDetermined,
    fromCache,
  });
}
