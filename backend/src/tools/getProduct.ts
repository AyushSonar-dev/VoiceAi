import {
  ok,
  fail,
  requireSession,
  rememberProducts,
  recordAction,
  productIntro,
  appearanceSentence,
  assertReferencable,
  getStore,
} from "./shared.js";
import { formatPrice } from "../config.js";
import type { ToolResult } from "../types.js";
import { getCachedProduct } from "./productCache.js";

export interface GetProductParams {
  sessionId: string;
  productId: string;
}

export async function getProduct(params: GetProductParams): Promise<ToolResult> {
  const store = getStore();
  let session = await requireSession(params.sessionId);

  assertReferencable(session, params.productId);

  // Use cache (with stampede protection) — avoids a DB round-trip for the
  // same product being described multiple times in one conversation.
  const product = await getCachedProduct(params.productId);
  if (!product) {
    return fail("product_not_found", "That product could not be found.");
  }

  session = await rememberProducts(store, session, [product.id], "getProduct");
  // Update extended memory - this product is now the focus
  session = await store.saveSession({
    ...session,
    currentProductId: product.id,
    recentIntent: "getProduct",
  });
  await recordAction(store, session, { type: "getProduct", productId: product.id });

  // The full trusted visual description travels in the result, so the agent can
  // answer any follow-up ("and the sleeves?") from this one call instead of
  // asking the catalog again. When it is absent we say so explicitly — an
  // unstated detail must never become a guess.
  const looks = appearanceSentence(product.appearance);
  const appearanceLine = looks
    ? `How it looks: ${looks}`
    : `How it looks: the catalog has no visual description for this item, so do not describe its appearance.`;

  return ok(
    `${productIntro(product)}\nMore detail: ${product.description}\nFull list of key specs: ${product.keySpecs.join("; ")}.\n${appearanceLine}`,
    {
      product: {
        ...product,
        inStock: product.stock > 0,
        priceLabel: formatPrice(product.price),
        appearanceSpecified: Boolean(product.appearance),
      },
    }
  );
}