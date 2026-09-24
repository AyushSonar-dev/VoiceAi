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

export interface ApplyCouponParams {
  sessionId: string;
  code: string;
}

export async function applyCoupon(params: ApplyCouponParams): Promise<ToolResult> {
  const store = getStore();
  const session = await requireSession(params.sessionId);

  const code = String(params.code ?? "").toUpperCase().trim();
  if (!code) return fail("invalid_coupon", "Which coupon code would you like to apply?");

  const cart = await store.getOrCreateCart(params.sessionId);
  const summaryBefore = await buildCartSummary(cart);
  if (summaryBefore.isEmpty) {
    return fail("empty_cart", "Your cart is empty, so there's nothing to apply a coupon to yet.");
  }

  const coupon = await store.findCouponByCode(code);
  if (!coupon || !coupon.active) {
    const suggested = await currentCodes(store);
    return fail(
      "invalid_coupon",
      `"${code}" isn't a valid coupon right now. Ask me for a current promo, or try one like ${suggested.map((c) => c.code).join(" or ")}.`,
      { suggestions: suggested, tried: code }
    );
  }

  if (cart.couponCode === coupon.code) {
    await recordAction(store, session, { type: "applyCoupon", code: coupon.code });
    const summary = await buildCartSummary(cart);
    return ok(
      `You already have ${coupon.code} applied — ${coupon.discountPercent}% off, saving you ${formatPrice(summary.discount)}. Total is ${formatPrice(summary.total)}.`,
      { cart: summary, skipped: true }
    );
  }

  cart.couponCode = coupon.code;
  cart.discountPercent = coupon.discountPercent;
  const saved = await store.saveCart(cart);
  await recordAction(store, session, { type: "applyCoupon", code: coupon.code });

  const summary = await buildCartSummary(saved);
  return ok(
    `Applied ${coupon.code} — ${coupon.discountPercent}% off, saving you ${formatPrice(summary.discount)}. Your new total is ${formatPrice(summary.total)}.`,
    { cart: summary, coupon: { code: coupon.code, discountPercent: coupon.discountPercent } }
  );
}

async function currentCodes(store: ReturnType<typeof getStore>) {
  const candidates = ["WELCOME15", "SAVE10", "VIP20", "FLASH25"];
  const out: { code: string; discountPercent: number }[] = [];
  for (const code of candidates) {
    const c = await store.findCouponByCode(code);
    if (c && c.active) out.push({ code: c.code, discountPercent: c.discountPercent });
  }
  return out;
}