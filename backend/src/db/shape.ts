import type { ProductAppearance } from "../types.js";
import type { ProductDoc } from "../models/Product.js";

/**
 * Normalize a stored appearance blob into a complete object. Every field is
 * copied across only when the catalog actually stated it, so a missing field
 * stays missing — which is what lets the agent say "I don't have that detail"
 * instead of filling it in. Unknown/absent sub-documents return `undefined`
 * rather than an empty object, so callers can tell "not described" from
 * "described with nothing to say".
 */
export function appearanceShape(raw: unknown): ProductAppearance | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const src = raw as Record<string, unknown>;

  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : undefined;
  const one = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim().length > 0 ? v : undefined;

  const appearance: ProductAppearance = {};
  const primaryColor = one(src.primaryColor);
  if (primaryColor) appearance.primaryColor = primaryColor;
  const secondaryColors = strings(src.secondaryColors);
  if (secondaryColors?.length) appearance.secondaryColors = secondaryColors;
  const pattern = one(src.pattern);
  if (pattern) appearance.pattern = pattern;
  const details = strings(src.details);
  if (details?.length) appearance.details = details;
  const texture = one(src.texture);
  if (texture) appearance.texture = texture;
  const styleImpression = one(src.styleImpression);
  if (styleImpression) appearance.styleImpression = styleImpression;
  const summary = one(src.summary);
  if (summary) appearance.summary = summary;

  return Object.keys(appearance).length ? appearance : undefined;
}

export function productShape(doc: ProductDoc): Product {
  const product: Product = {
    id: String(doc._id),
    name: doc.name,
    category: doc.category,
    price: doc.price,
    stock: doc.stock,
    rating: doc.rating,
    reviewCount: doc.reviewCount,
    keySpecs: Array.isArray(doc.keySpecs) ? doc.keySpecs : [],
    description: doc.description,
  };
  const appearance = appearanceShape((doc as { appearance?: unknown }).appearance);
  if (appearance) product.appearance = appearance;
  return product;
}

export function cartShape(doc: any): Cart {
  return {
    id: String(doc._id),
    sessionId: doc.sessionId,
    items: (doc.items || []).map((i: any) => ({
      productId: String(i.productId),
      quantity: (i as { quantity: number }).quantity,
    })),
    couponCode: doc.couponCode ?? null,
    discountPercent: doc.discountPercent ?? 0,
  };
}

export function couponShape(doc: any): Coupon {
  return {
    id: String(doc._id),
    code: doc.code,
    discountPercent: doc.discountPercent,
    active: doc.active,
  };
}

export function orderShape(doc: any): Order {
  return {
    id: String(doc._id),
    sessionId: doc.sessionId,
    items: (doc.items || []).map((i: any) => ({
      productId: String(i.productId),
      quantity: (i as { quantity: number }).quantity,
      priceAtOrder: (i as { priceAtOrder: number }).priceAtOrder,
    })),
    couponApplied: doc.couponApplied ?? null,
    total: doc.total,
    status: doc.status,
    createdAt: doc.createdAt?.toISOString?.() ?? null,
  };
}

export function sessionShape(doc: any): ConversationSession {
  return {
    id: String(doc._id),
    sessionId: doc.sessionId,
    recentProductIds: (doc.recentProductIds || []).map((x: unknown) => String(x)),
    lastAction: doc.lastAction ?? null,
  };
}

/**
 * Flatten an appearance blob into searchable prose. Lets a shopper find things
 * the way they'd actually ask for them ("something striped", "a dark blue
 * dress") instead of needing to know the product name first.
 */
export function appearanceSearchText(appearance: ProductAppearance | undefined): string {
  if (!appearance) return "";
  return [
    appearance.summary,
    appearance.primaryColor,
    ...(appearance.secondaryColors ?? []),
    appearance.pattern,
    ...(appearance.details ?? []),
    appearance.texture,
    appearance.styleImpression,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Crude but useful suffix stems. Search has to connect "dresses" with
 * "sundress" and "striped" with "stripes", which a single trailing-"s" rule
 * cannot do. Anything shorter than three characters is discarded, so a stem can
 * never degenerate into a letter that would match everything.
 */
function stemsOf(term: string): string[] {
  const out = new Set<string>([term]);
  for (const suffix of ["es", "s", "ed", "ing", "d"]) {
    if (term.length > 3 && term.endsWith(suffix)) out.add(term.slice(0, -suffix.length));
  }
  return [...out].filter((s) => s.length >= 3);
}

function matchesTerm(haystack: string, words: string[], term: string): boolean {
  if (haystack.includes(term)) return true;
  for (const stem of stemsOf(term)) {
    if (haystack.includes(stem)) return true;
    if (words.some((w) => w === stem || w.startsWith(stem) || w.endsWith(stem))) return true;
  }
  return false;
}

// Search/filter semantics shared by both stores (identical behavior for the
// LLM regardless of backend).
export function applyProductFilters(products: Product[], filter: ProductFilter = {}): Product[] {
  const { category, maxPrice, minRating, q, limit } = filter;

  let out = products;

  if (category) out = out.filter((p) => p.category === category);
  if (typeof maxPrice === "number" && Number.isFinite(maxPrice)) out = out.filter((p) => p.price <= maxPrice!);
  if (typeof minRating === "number" && Number.isFinite(minRating)) out = out.filter((p) => p.rating >= minRating!);
  if (typeof q === "string" && q.trim()) {
    const terms = q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t.replace(/[^a-z0-9]+/g, ""))
      .filter((t) => t.length);
    if (terms.length) {
      out = out.filter((p) => {
        // keySpecs is spread as a list (joining first and then spreading would
        // spread the joined string's individual characters into the haystack).
        const haystack = [p.name, p.category, p.description, ...(p.keySpecs || []), appearanceSearchText(p.appearance)]
          .join(" ")
          .toLowerCase();
        const words = haystack.split(/[^a-z0-9]+/).filter(Boolean);
        return terms.every((t) => matchesTerm(haystack, words, t));
      });
    }
  }

  out = [...out].sort(
    (a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount || a.price - b.price
  );

  if (typeof limit === "number") out = out.slice(0, limit);
  return out;
}

import type { Cart, Coupon, Order, ConversationSession, Product, ProductFilter } from "../types.js";