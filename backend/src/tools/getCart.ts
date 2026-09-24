import {
  ok,
  requireSession,
  rememberProducts,
  recordAction,
  buildCartSummary,
  getStore,
} from "./shared.js";
import { formatPrice } from "../config.js";
import type { ToolResult } from "../types.js";

export interface GetCartParams {
  sessionId: string;
}

export async function getCart(params: GetCartParams): Promise<ToolResult> {
  const store = getStore();
  const session = await requireSession(params.sessionId);

  const cart = await store.getOrCreateCart(params.sessionId);
  const summary = await buildCartSummary(cart);

  // Model may reference items that are already in the cart, so make them valid.
  await rememberProducts(store, session, summary.lines.map((l) => l.productId));

  if (summary.isEmpty) {
    return ok("Your cart is empty at the moment.", { cart: summary });
  }

  const couponPart =
    summary.couponCode && summary.discountPercent > 0
      ? ` — coupon ${summary.couponCode} gives you ${summary.discountPercent}% off`
      : "";

  return ok(
    `Your cart:\n${summary.linesText}.\nSubtotal ${formatPrice(summary.subtotal)}.${couponPart}\nTotal ${formatPrice(summary.total)}.`,
    { cart: summary }
  );
}