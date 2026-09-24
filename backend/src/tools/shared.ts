import { getStore } from "../db/index.js";
import { formatPrice } from "../config.js";
import type { Product, Cart, ConversationSession, Store, ToolResult } from "../types.js";

/** Structured tool error — serialized into result.error for the LLM. */
export class ToolError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface TotalLine {
  productId: string;
  name: string;
  category: string;
  price: number;
  quantity: number;
  lineTotal: number;
  stock: number;
  inStock: boolean;
}

export interface CartSummary {
  isEmpty: boolean;
  itemCount: number;
  lines: TotalLine[];
  linesText: string;
  subtotal: number;
  couponCode: string | null;
  discountPercent: number;
  discount: number;
  total: number;
}

export async function requireSession(sessionId: string): Promise<ConversationSession> {
  if (!sessionId) throw new ToolError("session_required", "A sessionId is required. Ask the user to start a session first.");
  const store = getStore();
  const session = await store.getOrCreateSession(sessionId);
  if (!session) throw new ToolError("session_not_found", `No session found for ${sessionId}.`);
  return session;
}

const MAX_RECENT = 24;

/**
 * Remember product ids for the current turn. Only these are referenceable by
 * the LLM. Most-recent-first, deduped, bounded.
 */
export async function rememberProducts(
  store: Store,
  session: ConversationSession,
  ids: string[]
): Promise<ConversationSession> {
  const fresh: string[] = [];
  for (const id of ids) {
    if (!fresh.includes(id) && !session.recentProductIds.includes(id)) fresh.push(id);
  }
  if (!fresh.length) return session;
  const updated: ConversationSession = {
    ...session,
    recentProductIds: [...fresh, ...session.recentProductIds].slice(0, MAX_RECENT),
  };
  return store.saveSession(updated);
}

export async function recordAction(
  store: Store,
  session: ConversationSession,
  action: Record<string, unknown> & { type: string }
): Promise<ConversationSession> {
  return store.saveSession({ ...session, lastAction: action });
}

/** Structural rule: the model may only ever reference ids it was handed. */
export function assertReferencable(session: ConversationSession, productId: string): void {
  if (!productId) throw new ToolError("invalid_product_reference", "No product id was passed.");
  if (!session.recentProductIds.includes(productId)) {
    throw new ToolError(
      "invalid_product_reference",
      `Product id ${productId} is not part of the current conversation. Only ids returned by a tool this session may be used — search or open the cart to get valid ids.`
    );
  }
}

export async function buildCartSummary(cart: Cart): Promise<CartSummary> {
  const store = getStore();
  const products = await store.getProductsByIds(cart.items.map((i) => i.productId));
  const byId = new Map(products.map((p) => [p.id, p]));

  const lines: TotalLine[] = [];
  for (const item of cart.items) {
    const product = byId.get(item.productId);
    lines.push({
      productId: item.productId,
      name: product?.name ?? "(unknown product)",
      category: product?.category ?? "",
      price: product?.price ?? 0,
      quantity: item.quantity,
      lineTotal: (product?.price ?? 0) * item.quantity,
      stock: product?.stock ?? 0,
      inStock: (product?.stock ?? 0) > 0,
    });
  }

  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const discount = Math.round((subtotal * (cart.discountPercent ?? 0)) / 100);
  const total = Math.max(0, subtotal - discount);
  const itemCount = lines.reduce((sum, l) => sum + l.quantity, 0);

  const linesText =
    lines
      .map((l) => `${l.name} x${l.quantity} — ${formatPrice(l.lineTotal)}`)
      .join(", ") || "nothing";

  return {
    isEmpty: lines.length === 0,
    itemCount,
    lines,
    linesText,
    subtotal,
    couponCode: cart.couponCode,
    discountPercent: cart.discountPercent ?? 0,
    discount,
    total,
  };
}

export function ok(message: string, data?: Record<string, unknown>): ToolResult {
  return { success: true, message, data };
}

export function fail(code: string, message: string, data?: Record<string, unknown>): ToolResult {
  return { success: false, error: code, message, data };
}

/** Voice-UX rule, enforced structurally: out-of-stock => offer a real in-stock
 * alternative from the SAME category (never a refusal with nothing to try). */
export async function inStockAlternative(
  category: string,
  excludeId: string
): Promise<Product | null> {
  const store = getStore();
  const candidates = await store.searchProducts({ category, limit: 4 });
  return candidates.find((p) => p.id !== excludeId && p.stock > 0) ?? null;
}

export function productIntro(p: Product): string {
  const stock = p.stock > 0 ? "in stock" : "out of stock";
  return `${p.name} — ${formatPrice(p.price)} — rated ${p.rating} stars from ${p.reviewCount} reviews — ${stock}. Key specs: ${p.keySpecs.slice(0, 3).join("; ")}.`;
}

export { getStore };