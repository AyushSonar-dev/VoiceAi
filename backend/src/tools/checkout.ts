import {
  ok,
  fail,
  requireSession,
  recordAction,
  buildCartSummary,
  inStockAlternative,
  rememberProducts,
  getStore,
} from "./shared.js";
import { formatPrice } from "../config.js";
import type { ToolResult, Store, Cart } from "../types.js";

export interface CheckoutParams {
  sessionId: string;
  /** Must be boolean true to actually create the order. */
  confirm?: boolean;
}

/**
 * EXPLICIT confirmation step before a mock order is created:
 *  - confirm !== true  -> returns a full preview only, NEVER creates an order.
 *  - confirm === true  -> re-validates everything (stock, coupon, cart) and
 *    only then persists the order + decrements stock.
 */
export async function checkout(params: CheckoutParams): Promise<ToolResult> {
  const store = getStore();
  const session = await requireSession(params.sessionId);

  const cart = await store.getOrCreateCart(params.sessionId);
  const summary = await buildCartSummary(cart);

  if (summary.isEmpty) {
    return fail("empty_cart", "Your cart is empty, so there's nothing to check out yet.");
  }

  const couponValid = await validateAppliedCoupon(store, cart);
  const lines = summary.lines;

  // Re-validate each line BEFORE touching data (products may have gone out of
  // stock, or vanished, since the item was added).
  for (const line of lines) {
    if (!line.inStock || line.stock < line.quantity) {
      const alternative = await inStockAlternative(line.category, line.productId);
      if (alternative) {
        await rememberProducts(store, session, [alternative.id]);
        return fail(
          "stock_changed",
          `${line.name} is no longer available in the quantity you have. As an in-stock alternative from the same category I have ${alternative.name} — ${formatPrice(alternative.price)}, rated ${alternative.rating} stars. Want me to swap it in and check out again?`,
          { productId: line.productId, alternative: { id: alternative.id, name: alternative.name, price: alternative.price, rating: alternative.rating, reviewCount: alternative.reviewCount, stock: alternative.stock } }
        );
      }
      return fail(
        "stock_changed",
        `${line.name} is no longer available. It's been kept in your cart — would you like to remove it and try a different category?`
      );
    }
  }

  // ---------------- preview (no side effects) ----------------
  if (params.confirm !== true) {
    await recordAction(store, session, { type: "checkout_preview", itemCount: summary.itemCount, total: summary.total });

    const couponLine =
      summary.couponCode && summary.discountPercent > 0
        ? `with coupon ${summary.couponCode} (${summary.discountPercent}% off, saving ${formatPrice(summary.discount)})`
        : "with no coupon applied";

    return ok(
      `Here's your order summary:\n${summary.linesText}.\nSubtotal ${formatPrice(summary.subtotal)}, ${couponLine}.\nTotal to pay: ${formatPrice(summary.total)}.\n\nShall I place this order? Say yes to confirm.`,
      {
        confirmRequired: true,
        preview: {
          items: lines.map((l) => ({ productId: l.productId, name: l.name, quantity: l.quantity, priceAtOrder: l.price, lineTotal: l.lineTotal })),
          subtotal: summary.subtotal,
          couponCode: summary.couponCode,
          discountPercent: summary.discountPercent,
          discount: summary.discount,
          total: summary.total,
        },
      }
    );
  }

  // ---------------- confirmed: the backend NOW makes it happen ----------------
  const order = await store.createOrder({
    sessionId: params.sessionId,
    items: lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      priceAtOrder: l.price,
    })),
    couponApplied:
      couponValid && summary.couponCode
        ? { code: summary.couponCode, discountPercent: summary.discountPercent }
        : null,
    total: summary.total,
    status: "confirmed",
  });

  const stockResults = await store.decrementStock(
    lines.map((l) => ({ productId: l.productId, delta: l.quantity }))
  );

  const saved = await store.saveCart({ ...cart, items: [], couponCode: null, discountPercent: 0 });
  await buildCartSummary(saved);
  await recordAction(store, session, { type: "checkout_confirmed", orderId: order.id, total: order.total });

  const couponPart = order.couponApplied?.discountPercent ? ` with ${order.couponApplied.code}` : "";
  const failedStock = stockResults.filter((s) => !s.ok);

  if (failedStock.length) {
    // Extremely unlikely (we validated first), but never claim success if false.
    return fail(
      "stock_changed_during_checkout",
      `Almost there — ${failedStock.length} item went out of stock as I was confirming. Nothing has been charged. Let me review your cart again.`
    );
  }

  return ok(
    `Order confirmed! ${summary.itemCount} item${summary.itemCount === 1 ? "" : "s"} (${summary.linesText})${couponPart} — total ${formatPrice(order.total)}. It's marked as confirmed. Would you like anything else?`,
    {
      orderConfirmed: true,
      order: {
        orderId: order.id,
        items: order.items,
        couponApplied: order.couponApplied,
        total: order.total,
        status: order.status,
        createdAt: order.createdAt,
      },
      cart: { isEmpty: true, itemCount: 0 },
    }
  );
}

async function validateAppliedCoupon(
  store: Store,
  cart: Cart
): Promise<boolean> {
  if (!cart.couponCode) return true;
  const coupon = await store.findCouponByCode(cart.couponCode);
  if (!coupon || !coupon.active) return false;
  return true;
}