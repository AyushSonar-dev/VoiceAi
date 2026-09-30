"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { ProductAppearance, RecentProduct } from "@/types";
import { formatMoney } from "@/lib/money";

interface CardProps {
  product: RecentProduct;
  onSelect: (product: RecentProduct) => void;
  onAdd: (product: RecentProduct) => void;
  onFocus: (product: RecentProduct) => void;
  onWishlist?: (product: RecentProduct) => void;
  wishlisted?: boolean;
  spotlight: boolean;
  reducedMotion: boolean;
  currency: string;
}

/**
 * Product card for EchoMart.
 *
 * Visual hierarchy: swatch header (color preview) → category badge → name →
 * price + stars → appearance description → key specs → actions.
 *
 * The swatch is driven by `appearance.primaryColor` so the card shows a real
 * visual impression of the item without requiring a photograph — important for
 * catalog items described by voice, and fully equivalent for screen-reader users
 * who receive the same appearance description as text.
 */
export function ProductCard({
  product,
  onSelect,
  onAdd,
  onFocus,
  onWishlist,
  wishlisted = false,
  spotlight,
  reducedMotion,
  currency,
}: CardProps) {
  const libReduced = useReducedMotion();
  const still = reducedMotion || libReduced === true;
  const price = formatMoney(product.price, currency);
  const soldOut = !product.inStock || product.stock <= 0;
  const appearance = describeAppearance(product.appearance);
  const swatchBg = swatchBackground(product.appearance);
  const swatchDots = swatchDotColors(product.appearance);
  const imageUrl = productImageUrl(product.name);

  return (
    <motion.article
      className="product"
      data-spotlight={spotlight || undefined}
      layout={!still}
      transition={{ layout: { duration: still ? 0 : 0.4, ease: [0.22, 1, 0.36, 1] } }}
      onMouseEnter={() => onFocus(product)}
    >
      {/* Product image header */}
      <div
        className="product__swatch"
        style={{ background: swatchBg }}
        aria-hidden="true"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt=""
          className="product__img"
          loading="lazy"
          decoding="async"
          aria-hidden="true"
        />
        {swatchDots.length > 0 && (
          <div className="product__swatch-dots">
            {swatchDots.map((color, i) => (
              <span
                key={i}
                className="product__swatch-dot"
                style={{ background: color }}
                title={color}
              />
            ))}
          </div>
        )}
        {soldOut && (
          <span className="product__flag product__flag--oos">Out of stock</span>
        )}
        {onWishlist && (
          <button
            type="button"
            className={`product__wish${wishlisted ? " product__wish--active" : ""}`}
            onClick={(e) => { e.stopPropagation(); onWishlist(product); }}
            aria-label={wishlisted ? `Remove ${product.name} from wishlist` : `Save ${product.name} to wishlist`}
            aria-pressed={wishlisted}
          >
            {wishlisted ? "♥" : "♡"}
          </button>
        )}
      </div>

      <div className="product__body">
        {/* Category */}
        <p className="product__category">{product.category}</p>

        {/* Name */}
        <h4 className="product__name">{product.name}</h4>

        {/* Price + rating on the same row */}
        <div className="product__price-row">
          <p className="product__price">{price}</p>
          <div className="product__rating" aria-label={`Rated ${product.rating} out of 5 from ${product.reviewCount} reviews`}>
            <StarRating rating={product.rating} />
            <span className="product__review-count">({product.reviewCount})</span>
          </div>
        </div>

        {/* Appearance — same words the voice agent speaks */}
        {appearance ? (
          <p className="product__desc">{appearance}</p>
        ) : (
          <p className="product__desc product__desc--none">
            No visual description available.
          </p>
        )}

        {/* Key specs as chips */}
        {product.keySpecs && product.keySpecs.length > 0 && (
          <ul className="product__specs" aria-label="Key specs">
            {product.keySpecs.slice(0, 3).map((spec) => (
              <li key={spec} className="product__spec">{spec}</li>
            ))}
          </ul>
        )}

        {/* Actions */}
        <div className="product__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => onSelect(product)}
            onFocus={() => onFocus(product)}
            aria-label={`View details for ${product.name}`}
          >
            Details
          </button>
          <button
            type="button"
            className="btn btn--solid"
            onClick={() => onAdd(product)}
            onFocus={() => onFocus(product)}
            disabled={soldOut}
            aria-label={soldOut ? `${product.name} is out of stock` : `Add ${product.name} to cart, ${price}`}
          >
            {soldOut ? "Sold Out" : "Add to Cart"}
          </button>
        </div>
      </div>
    </motion.article>
  );
}

/* ----------------------------------------------------------------- helpers */

/** Render ★★★☆☆ stars, half-star aware to the nearest 0.5. */
function StarRating({ rating }: { rating: number }) {
  const full  = Math.floor(rating);
  const half  = rating - full >= 0.3 && rating - full < 0.8 ? 1 : 0;
  const empty = 5 - full - half;

  return (
    <span className="stars" aria-hidden="true">
      {"★".repeat(full)}
      {half ? "⯨" : ""}
      <span className="stars__empty">{"☆".repeat(empty)}</span>
    </span>
  );
}

/**
 * One sentence about how the product looks, using the stored appearance fields.
 * Returns `null` when the catalog described nothing.
 */
function describeAppearance(appearance: ProductAppearance | undefined): string | null {
  if (!appearance) return null;
  if (appearance.summary) return appearance.summary;

  const parts: string[] = [];
  if (appearance.primaryColor) parts.push(appearance.primaryColor);
  if (appearance.secondaryColors?.length)
    parts.push(`with ${appearance.secondaryColors.join(" and ")}`);
  if (appearance.pattern) parts.push(appearance.pattern);
  if (appearance.details?.length) parts.push(appearance.details.join(", "));
  if (appearance.texture) parts.push(appearance.texture);
  if (appearance.styleImpression) parts.push(appearance.styleImpression);
  if (!parts.length) return null;
  return parts.join(", ") + ".";
}

/**
 * Derive a CSS gradient for the swatch header from appearance.primaryColor.
 * Falls back to a neutral surface-2 when no color is available.
 */
function swatchBackground(appearance: ProductAppearance | undefined): string {
  const primary = appearance?.primaryColor;
  const secondary = appearance?.secondaryColors?.[0];

  if (!primary) return "var(--surface-2)";

  const base = cssColor(primary);
  if (secondary) {
    const sec = cssColor(secondary);
    return `linear-gradient(135deg, ${base} 0%, ${sec} 100%)`;
  }
  return `linear-gradient(145deg, ${base} 0%, color-mix(in srgb, ${base} 70%, white) 100%)`;
}

/**
 * Up to three color dots for the swatch header (primary + secondary colors).
 * The dots give a quick multi-color preview when the product has several colors.
 */
function swatchDotColors(appearance: ProductAppearance | undefined): string[] {
  if (!appearance) return [];
  const all: string[] = [];
  if (appearance.primaryColor) all.push(cssColor(appearance.primaryColor));
  if (appearance.secondaryColors) {
    all.push(...appearance.secondaryColors.slice(0, 2).map(cssColor));
  }
  return all.slice(0, 3);
}

/**
 * Produce a deterministic, product-appropriate image URL.
 * Uses Lorem Picsum seeded with the product name — consistent across renders
 * and reloads, no API key needed.
 */
function productImageUrl(name: string): string {
  const seed = encodeURIComponent(name.toLowerCase().replace(/\s+/g, "-"));
  return `https://picsum.photos/seed/${seed}/640/420`;
}

/**
 * Map common English color names to CSS values so we can drive a real color
 * swatch from the catalog's prose description. Unknown names fall back to a
 * warm grey rather than crashing.
 */
const COLOR_MAP: Record<string, string> = {
  white: "#ffffff",    ivory: "#fffff0",     cream: "#fffdd0",
  beige: "#f5f5dc",    linen: "#faf0e6",     champagne: "#f7e7ce",
  gold: "#ffd700",     golden: "#ffd700",    yellow: "#fbbf24",
  amber: "#f59e0b",    orange: "#fb6514",    coral: "#ff6b6b",
  peach: "#ffcba4",    pink: "#f472b6",      rose: "#fb7185",
  magenta: "#e879f9",  purple: "#a855f7",    violet: "#7c3aed",
  indigo: "#4f46e5",   blue: "#3b82f6",      navy: "#1e3a5f",
  teal: "#0d9488",     cyan: "#06b6d4",      turquoise: "#40e0d0",
  green: "#22c55e",    emerald: "#10b981",   olive: "#6b7c45",
  mint: "#a8e6cf",     sage: "#87ae73",      khaki: "#c3b091",
  brown: "#92400e",    tan: "#d2b48c",       caramel: "#c68642",
  chocolate: "#7b3f00",black: "#111111",     charcoal: "#374151",
  slate: "#475569",    grey: "#9ca3af",      gray: "#9ca3af",
  silver: "#c0c0c0",   red: "#ef4444",       crimson: "#dc143c",
  maroon: "#800000",   onyx: "#353839",      pearl: "#eae6da",
  diamond: "#b9f2ff",  silk: "#f5e6cc",      cotton: "#f8f4e3",
};

function cssColor(name: string): string {
  const key = name.toLowerCase().trim();
  // Direct lookup
  if (COLOR_MAP[key]) return COLOR_MAP[key];
  // Partial match — "deep blue" → "blue"
  for (const [k, v] of Object.entries(COLOR_MAP)) {
    if (key.includes(k)) return v;
  }
  return "#9ca3af"; // fallback gray
}
