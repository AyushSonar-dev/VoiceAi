import {
  ok,
  fail,
  requireSession,
  rememberProducts,
  recordAction,
  productIntro,
  assertReferencable,
  getStore,
} from "./shared.js";
import { formatPrice } from "../config.js";
import type { ToolResult } from "../types.js";

export interface GetProductParams {
  sessionId: string;
  productId: string;
}

export async function getProduct(params: GetProductParams): Promise<ToolResult> {
  const store = getStore();
  let session = await requireSession(params.sessionId);

  assertReferencable(session, params.productId);

  const product = await store.getProductById(params.productId);
  if (!product) {
    return fail("product_not_found", "That product could not be found.");
  }

  session = await rememberProducts(store, session, [product.id]);
  await recordAction(store, session, { type: "getProduct", productId: product.id });

  return ok(
    `${productIntro(product)}\nMore detail: ${product.description}\nFull list of key specs: ${product.keySpecs.join("; ")}.`,
    {
      product: {
        ...product,
        inStock: product.stock > 0,
        priceLabel: formatPrice(product.price),
      },
    }
  );
}