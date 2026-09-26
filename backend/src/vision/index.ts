import { config } from "../config.js";
import { VisionError } from "./errors.js";
import { fetchProductImage } from "./imageFetcher.js";
import { OpenAiVisionClient, type VisionClient } from "./openaiVisionClient.js";
import { fallbackDescription, type VisionAnalysis } from "./attributes.js";

export { VisionError } from "./errors.js";
export { PUBLIC_ASSET_DIR } from "./imageFetcher.js";
export {
  getCachedVisual,
  setCachedVisual,
  getCachedAttribute,
  getLastDescribedProductId,
  __clearVisualCache,
} from "./visualCache.js";
export { attributesToText, fallbackDescription, type VisionAnalysis, type VisualAttributes } from "./attributes.js";

let cachedClient: VisionClient | null = null;
let injectedClient: VisionClient | null = null;

/**
 * The configured vision provider. There is exactly one: the same
 * OpenAI-compatible endpoint/key the conversation brain uses, with a
 * vision-capable model. There is deliberately NO placeholder/guessing fallback —
 * when no provider is available the tool reports that it could not analyze the
 * image rather than inventing a description.
 */
export function resolveVisionClient(): VisionClient | null {
  if (injectedClient) return injectedClient;
  if (!config.openaiKey) return null;
  if (!cachedClient) cachedClient = new OpenAiVisionClient();
  return cachedClient;
}

/**
 * Test hook — injects a fake provider (mirrors TurnOptions.llm injection).
 * Passing null also drops the memoized real client so the next call rebuilds it
 * from the current config.
 */
export function __setVisionClientForTests(client: VisionClient | null): void {
  injectedClient = client;
  cachedClient = null;
}

/**
 * Full image-analysis path for one product: locate the photo -> read its bytes
 * -> hand those exact bytes to the vision model -> normalize the answer into
 * spoken text plus only-the-observed attributes.
 *
 * Throws VisionError("image_unavailable") when the photo cannot be read and
 * VisionError("vision_failed") when the model cannot be reached or returns
 * nothing usable. Callers translate those into honest spoken replies.
 */
export async function analyzeProductImage(input: {
  imageUrl: string;
  productId: string;
}): Promise<{ analysis: VisionAnalysis; imageUrl: string; byteLength: number; source: "file" | "http" }> {
  const image = await fetchProductImage(input.imageUrl);

  const client = resolveVisionClient();
  if (!client) throw new VisionError("vision_failed", "no_vision_provider_configured");

  const analysis = await client.analyze({ dataUrl: image.dataUrl, mimeType: image.mimeType });
  if (!analysis.description) {
    analysis.description = fallbackDescription(analysis.attributes);
  }
  if (!analysis.description && !Object.keys(analysis.attributes).length) {
    throw new VisionError("vision_failed", "nothing_observable_in_image");
  }
  return { analysis, imageUrl: input.imageUrl, byteLength: image.byteLength, source: image.source };
}
