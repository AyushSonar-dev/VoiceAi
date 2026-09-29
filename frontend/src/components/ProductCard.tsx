"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { ProductAppearance, RecentProduct } from "@/types";
import { formatMoney } from "@/lib/money";

interface CardProps {
  product: RecentProduct;
  onSelect: (product: RecentProduct) => void;
  onAdd: (product: RecentProduct) => void;
  onFocus: (product: RecentProduct) => void;
  spotlight: boolean;
  reducedMotion: boolean;
  currency: string;
}

/**
 * One product, set as type rather than a photograph — there is no image in this
 * catalog. The block Echo would otherwise be read from a photo is carried by the
 * product's own `appearance` text, which is the same wording the voice agent
 * speaks, so a screen-reader user and a sighted user are given the same
 * description of what the item looks like.
 *
 * Everything stays in the reading order (name, price, rating, appearance, then
 * actions), and the appearance is plain text rather than a colour swatch or a
 * CSS hint, because neither can be read aloud.
 */
export function ProductCard({
  product,
  onSelect,
  onAdd,
  onFocus,
  spotlight,
  reducedMotion,
  currency,
}: CardProps) {
  const libReduced = useReducedMotion();
  const still = reducedMotion || libReduced === true;
  const price = formatMoney(product.price, currency);
  const soldOut = !product.inStock || product.stock <= 0;
  const appearance = describeAppearance(product.appearance);

  return (
    <motion.article
      className="product"
      data-spotlight={spotlight || undefined}
      layout={!still}
      transition={{ layout: { duration: still ? 0 : 0.4, ease: [0.22, 1, 0.36, 1] } }}
      onMouseEnter={() => onFocus(product)}
    >
      <div className="product__body">
        <p className="product__category">{product.category}</p>
        <h4 className="product__name">{product.name}</h4>
        <p className="product__price">
          {price}
          <span className="product__rating">
            {" "}
            · rated {product.rating} out of 5 from {product.reviewCount} reviews
          </span>
        </p>

        {appearance ? (
          <p className="product__desc">{appearance}</p>
        ) : (
          <p className="product__desc product__desc--none">
            No visual description is available for this item.
          </p>
        )}

        <div className="product__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => onSelect(product)}
            onFocus={() => onFocus(product)}
          >
            Details
          </button>
          <button
            type="button"
            className="btn btn--solid"
            onClick={() => onAdd(product)}
            onFocus={() => onFocus(product)}
            disabled={soldOut}
            aria-label={`Add ${product.name} to cart, ${price}`}
          >
            {soldOut ? "Sold out" : "Add"}
          </button>
        </div>

        {soldOut ? <p className="product__flag">Out of stock</p> : null}
      </div>
    </motion.article>
  );
}

/**
 * One sentence about how the product looks, built only from the stored
 * appearance fields. Returns `null` when the catalog described nothing, so the
 * card can state that plainly instead of showing a made-up visual impression.
 */
function describeAppearance(appearance: ProductAppearance | undefined): string | null {
  if (!appearance) return null;
  if (appearance.summary) return appearance.summary;

  const parts: string[] = [];
  if (appearance.primaryColor) parts.push(`${appearance.primaryColor}`);
  if (appearance.secondaryColors?.length) {
    parts.push(`with ${appearance.secondaryColors.join(" and ")}`);
  }
  if (appearance.pattern) parts.push(appearance.pattern);
  if (appearance.details?.length) parts.push(appearance.details.join(", "));
  if (appearance.texture) parts.push(appearance.texture);
  if (appearance.styleImpression) parts.push(appearance.styleImpression);
  if (!parts.length) return null;
  return parts.join(", ") + ".";
}
