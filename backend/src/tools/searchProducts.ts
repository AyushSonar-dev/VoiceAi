import { ALLOWED_CATEGORIES, formatPrice } from "../config.js";
import {
  ok,
  fail,
  requireSession,
  rememberProducts,
  recordAction,
  productIntro,
  getStore,
  ToolError,
} from "./shared.js";
import type { ToolResult } from "../types.js";

export interface SearchProductsParams {
  sessionId: string;
  category?: string;
  maxPrice?: number;
  minRating?: number;
  q?: string;
  purpose?: string;
  maxResults?: number;
}

/**
 * Constraint-based search: budget + category + purpose in one utterance maps
 * to maxPrice/category/q. Returns 1-2 options by default. Every returned id is
 * remembered on the session so the model can only ever reference real ids it
 * was handed.
 */
export async function searchProducts(params: SearchProductsParams): Promise<ToolResult> {
  const store = getStore();
  let session = await requireSession(params.sessionId);

  const category = params.category?.trim() || undefined;
  if (category && !ALLOWED_CATEGORIES.includes(category)) {
    return fail(
      "invalid_category",
      `There is no "${category}" category. Available categories are ${ALLOWED_CATEGORIES.join(", ")}.`
    );
  }

  const maxPrice = typeof params.maxPrice === "number" && Number.isFinite(params.maxPrice) ? params.maxPrice : undefined;
  const minRating =
    typeof params.minRating === "number" && Number.isFinite(params.minRating) ? params.minRating : undefined;
  if (maxPrice !== undefined && maxPrice <= 0) return fail("invalid_constraint", "The maximum price must be a positive amount.");
  if (minRating !== undefined && (minRating < 0 || minRating > 5)) return fail("invalid_constraint", "Ratings range from 0 to 5 stars.");

  const maxResults = Math.max(1, Math.min(4, params.maxResults ?? 2));

  const keywords = [params.q, params.purpose].filter((x): x is string => Boolean(x && x.trim()));
  const q = keywords.join(" ").trim() || undefined;

  const items = await store.searchProducts({ category, maxPrice, minRating, q, limit: maxResults });

  if (!items.length) {
    return fail(
      "no_results",
      "I couldn't find anything matching that yet. Try widening the budget or dropping the category, and I'll search again.",
      { availableCategories: ALLOWED_CATEGORIES, searched: { category, maxPrice, q } }
    );
  }

  session = await rememberProducts(store, session, items.map((p) => p.id));
  await recordAction(store, session, { type: "searchProducts", productIds: items.map((p) => p.id) });

  const listed = items
    .map((p, i) => `Option ${i + 1}: ${productIntro(p)}`)
    .join("\n");

  return ok(
    `Found ${items.length} product${items.length === 1 ? "" : "s"}:\n${listed}\n\nUse the exact "Option N" number or the product id above to refer to them.`,
    {
      items: items.map((p, i) => ({
        index: i + 1,
        id: p.id,
        name: p.name,
        category: p.category,
        price: p.price,
        rating: p.rating,
        reviewCount: p.reviewCount,
        stock: p.stock,
        inStock: p.stock > 0,
        keySpecs: p.keySpecs,
      })),
      searched: { category, maxPrice, minRating },
    }
  );
}