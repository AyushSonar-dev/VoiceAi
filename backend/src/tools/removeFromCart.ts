import {
  ok,
  fail,
  requireSession,
  recordAction,
  buildCartSummary,
  getStore,
} from "./shared.js";
import { formatPrice } from "../config.js";
import type { ToolResult } from "../types.js";

export interface RemoveFromCartParams {
  sessionId: string;
  productId: string;
  quantity?: number;
}

export async function removeFromCart(params: RemoveFromCartParams): Promise<ToolResult> {
  const store = getStore();
  const session = await requireSession(params.sessionId);

  const cart = await store.getOrCreateCart(params.sessionId);
  const line = cart.items.find((i) => i.productId === params.productId);
  if (!line) {
    return fail("not_in_cart", "That product isn't in your cart right now.");
  }

  const all = params.quantity === undefined || params.quantity === null;
  const qty = Math.max(1, Math.round(params.quantity ?? 1));

  if (all || qty >= line.quantity) {
    cart.items = cart.items.filter((i) => i.productId !== params.productId);
  } else {
    line.quantity -= qty;
  }

  const saved = await store.saveCart(cart);
  await recordAction(store, session, { type: "removeFromCart", productId: params.productId });

  const summary = await buildCartSummary(saved);
  const didRemove = all || qty >= line.quantity;
  const product = (await store.getProductById(params.productId))!;
  return ok(
    didRemove
      ? `Removed ${product.name} from your cart. Cart total is ${formatPrice(summary.total)}.`
      : `Reduced ${product.name} to ${line.quantity} in your cart. Cart total is ${formatPrice(summary.total)}.`,
    { cart: summary, removed: { productId: params.productId, removedLine: didRemove } }
  );
}