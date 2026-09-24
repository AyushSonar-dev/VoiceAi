import type { ProductDoc } from "../models/Product.js";

export function productShape(doc: ProductDoc): Product {
  return {
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
        const haystack = [p.name, p.category, p.description, ...(p.keySpecs || [])
          .join(" ")]
          .join(" ")
          .toLowerCase();
        const words = haystack.split(/[^a-z0-9]+/).filter(Boolean);
        return terms.every((t) => {
          if (haystack.includes(t)) return true;
          const stem = t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t;
          if (stem.length >= 3 && haystack.includes(stem)) return true;
          return words.some((w) => w === stem || (stem.length >= 3 && (w.startsWith(stem) || stem.startsWith(w))));
        });
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