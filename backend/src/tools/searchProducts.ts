import { ALLOWED_CATEGORIES, formatPrice } from "../config.js";
import {
  ok,
  fail,
  requireSession,
  rememberProducts,
  recordAction,
  productIntro,
  appearanceGlance,
  getStore,
  ToolError,
} from "./shared.js";
import type { Product, ToolResult } from "../types.js";

export interface SearchProductsParams {
  sessionId: string;
  category?: string;
  maxPrice?: number;
  minRating?: number;
  q?: string;
  purpose?: string;
  maxResults?: number;
  /** Cursor for pagination - the productId to start after */
  cursor?: string;
}

/**
 * Constraint-based search: budget + category + purpose in one utterance maps
 * to maxPrice/category/q. Returns 1-2 options by default. Every returned id is
 * remembered on the session so the model can only ever reference real ids it
 * was handed.
 * Supports cursor-based pagination via the `cursor` parameter.
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

  // Use cursor-based pagination: fetch maxResults + 1 to determine hasMore
  const fetchLimit = maxResults + 1;
  const items = await store.searchProducts({ category, maxPrice, minRating, q, limit: fetchLimit, cursor: params.cursor });

  if (!items.length) {
    return fail(
      "no_results",
      "I couldn't find anything matching that yet. Try widening the budget or dropping the category, and I'll search again.",
      { availableCategories: ALLOWED_CATEGORIES, searched: { category, maxPrice, q } }
    );
  }

  // Check if there are more results
  const hasMore = items.length > maxResults;
  const pageItems = hasMore ? items.slice(0, maxResults) : items;
  const nextCursor = hasMore ? items[maxResults - 1].id : undefined;

  session = await rememberProducts(store, session, pageItems.map((p) => p.id), "searchProducts");
  // Update extended memory with search context
  session = await store.saveSession({
    ...session,
    recentSearchQuery: params.q || params.purpose || null,
    recentCategory: category || null,
    recentIntent: "search",
  });
  await recordAction(store, session, { type: "searchProducts", productIds: pageItems.map((p) => p.id) });

  const listed = pageItems
    .map((p, i) => {
      const glance = appearanceGlance(p.appearance);
      return `Option ${i + 1}: ${productIntro(p)}${glance ? ` Looks ${appearanceGlanceText(p.appearance!)}.` : ""}`;
    })
    .join("\n");

  return ok(
    `Found ${pageItems.length} product${pageItems.length === 1 ? "" : "s"}:${hasMore ? " (more available)" : ""}\n${listed}\n\nUse the exact "Option N" number or the product id above to refer to them. Call get_product on an option to get its full visual description before describing how it looks in detail.`,
    {
      items: pageItems.map((p, i) => ({
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
        // Visual anchor only. The full, trustworthy description of how this
        // product looks comes from get_product — a search hit is a name on a
        // list, and this must never be presented as the full answer.
        appearance: appearanceGlance(p.appearance),
      })),
      searched: { category, maxPrice, minRating },
      pageInfo: {
        hasMore,
        nextCursor,
      },
    }
  );
}

/** One short visual anchor for a listed product, e.g. "cream, in small florals". */
function appearanceGlanceText(appearance: NonNullable<Product["appearance"]>): string {
  const bits: string[] = [];
  if (appearance.primaryColor) bits.push(appearance.primaryColor);
  if (appearance.pattern) bits.push(`in ${appearance.pattern}`);
  else if (appearance.secondaryColors?.length) bits.push(`with ${appearance.secondaryColors.join(" and ")}`);
  return bits.join(", ");
}