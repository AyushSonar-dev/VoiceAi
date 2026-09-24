import {
  ok,
  fail,
  requireSession,
  assertReferencable,
  recordAction,
  buildCartSummary,
  getStore,
} from "./shared.js";
import { formatPrice } from "../config.js";
import type { ToolResult } from "../types.js";

export interface RemoveFromCartParams {
  sessionId: string;
  /** Referencable id only — the structural rule. */
  productId?: string;
  /** Fallback for spoken names the user gave directly (e.g. "remove the pearl drop earrings"). */
  productName?: string;
  quantity?: number;
}

export async function removeFromCart(params: RemoveFromCartParams): Promise<ToolResult> {
  const store = getStore();
  const session = await requireSession(params.sessionId);

  const cart = await store.getOrCreateCart(params.sessionId);

  // Resolve either an already-handed id or the user's own words.
  let productId: string;
  if (params.productId) {
    assertReferencable(session, params.productId);
    productId = params.productId;
  } else if (params.productName && params.productName.trim()) {
    const products = await store.getProductsByIds(cart.items.map((i) => i.productId));
    const byId = new Map(products.map((p) => [p.id, p]));
    const ignored = /^(the|a|an|from|to|of|my|in|all|just)$/;
    const words = params.productName
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w && !ignored.test(w));
    const matches = cart.items.filter((i) => {
      const name = byId.get(i.productId)?.name.toLowerCase() ?? "";
      return words.length > 0 && words.every((w) => name.includes(w));
    });
    if (matches.length === 0) {
      return fail("not_in_cart", "I don't see that item in your cart. Here are the lines in it right now:", {
        cart: await buildCartSummary(cart),
      });
    }
    if (matches.length > 1) {
      return fail(
        "ambiguous_product",
        "A few cart items match that description. Which option would you like to remove?",
        { matches }
      );
    }
    productId = matches[0].productId;
  } else {
    return fail("invalid_product_reference", "No product was specified to remove.");
  }

  const line = cart.items.find((i) => i.productId === productId);
  if (!line) {
    return fail("not_in_cart", "That product isn't in your cart right now.");
  }

  const all = params.quantity === undefined || params.quantity === null;
  const qty = Math.max(1, Math.round(params.quantity ?? 1));

  if (all || qty >= line.quantity) {
    cart.items = cart.items.filter((i) => i.productId !== productId);
  } else {
    line.quantity -= qty;
  }

  const saved = await store.saveCart(cart);
  await recordAction(store, session, { type: "removeFromCart", productId });

  const summary = await buildCartSummary(saved);
  const didRemove = all || qty >= line.quantity;
  const product = (await store.getProductById(productId))!;
  return ok(
    didRemove
      ? `Removed ${product.name} from your cart. Cart total is ${formatPrice(summary.total)}.`
      : `Reduced ${product.name} to ${line.quantity} in your cart. Cart total is ${formatPrice(summary.total)}.`,
    { cart: summary, removed: { productId, removedLine: didRemove } }
  );
}