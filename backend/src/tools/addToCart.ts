import {
  ok,
  fail,
  requireSession,
  rememberProducts,
  recordAction,
  assertReferencable,
  inStockAlternative,
  buildCartSummary,
  getStore,
} from "./shared.js";
import { formatPrice } from "../config.js";
import type { ToolResult } from "../types.js";

export interface AddToCartParams {
  sessionId: string;
  productId: string;
  quantity?: number;
}

export async function addToCart(params: AddToCartParams): Promise<ToolResult> {
  const store = getStore();
  let session = await requireSession(params.sessionId);

  assertReferencable(session, params.productId);

  const quantity = Math.max(1, Math.round(params.quantity ?? 1));
  if (!Number.isFinite(quantity) || quantity > 99) {
    return fail("invalid_quantity", "Please give a reasonable quantity between 1 and 99.");
  }

  const product = await store.getProductById(params.productId);
  if (!product) {
    return fail("product_not_found", "That product could not be found.");
  }

  // Structural stock rule: never add more than inventory allows.
  if (product.stock === 0 || product.stock < quantity) {
    if (product.stock > 0) {
      return fail(
        "insufficient_stock",
        `${product.name} only has ${product.stock} in stock right now. Want me to add fewer, or shall I show you something similar?`
      );
    }
    // Voice-UX rule: out of stock => offer a REAL in-stock alternative from the
    // same category (never a plain refusal).
    const alternative = await inStockAlternative(product.category, product.id);
    session = await rememberProducts(store, session, alternative ? [alternative.id] : []);
    await recordAction(store, session, { type: "addToCart_failed", productId: product.id });
    if (alternative) {
      return fail(
        "out_of_stock",
        `${product.name} is out of stock right now. Instead, I can offer ${alternative.name} from the same category — ${formatPrice(alternative.price)}, rated ${alternative.rating} stars from ${alternative.reviewCount} reviews, in stock. Want me to add it?`,
        { productId: product.id, alternative: { id: alternative.id, name: alternative.name, price: alternative.price, rating: alternative.rating, reviewCount: alternative.reviewCount, stock: alternative.stock, keySpecs: alternative.keySpecs } }
      );
    }
    return fail(
      "out_of_stock",
      `${product.name} is out of stock right now, and I don't have another option in that category. Would you like to try Electronics, Jewelry, Men's Clothing, or Women's Clothing instead?`
    );
  }

  const cart = await store.getOrCreateCart(params.sessionId);
  const existing = cart.items.find((i) => i.productId === product.id);

  // Idempotency: an IDENTICAL repeated add right after the same one is a no-op —
  // it must not double-add (protects against accidental re-execution).
  const last = session.lastAction;
  if (
    existing &&
    last &&
    last.type === "addToCart" &&
    last.productId === product.id &&
    last.quantity === quantity
  ) {
    await recordAction(store, session, { type: "addToCart", productId: product.id, quantity, skippedIdempotent: true });
    const summary = await buildCartSummary(cart);
    return ok(
      `${product.name} is already in your cart (${existing.quantity}). Cart total is ${formatPrice(summary.total)}. Nothing was double-added.`,
      { cart: summary, skipped: true }
    );
  }

  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.items.push({ productId: product.id, quantity });
  }

  const saved = await store.saveCart(cart);
  await recordAction(store, session, { type: "addToCart", productId: product.id, quantity });

  const summary = await buildCartSummary(saved);
  const line = summary.lines.find((l) => l.productId === product.id);
  return ok(
    `Done — ${product.name} is now in your cart (quantity ${line?.quantity ?? quantity}). Cart total is ${formatPrice(summary.total)}.`,
    { cart: summary, added: { productId: product.id, quantity: line?.quantity ?? quantity } }
  );
}