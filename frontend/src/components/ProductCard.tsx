"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { RecentProduct } from "@/types";

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
 * One product, as a photograph with a caption underneath. No border, no filled
 * container, no drop shadow — the image is the object and the type is the label,
 * the way a printed catalogue would set it.
 *
 * The image is decorative here because the product's name is right next to it in
 * text, so a screen reader is not made to listen to a filename. The image
 * `alt` would be redundant, not missing.
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

  return (
    <motion.article
      className="product"
      data-spotlight={spotlight || undefined}
      layout={!still}
      transition={{ layout: { duration: still ? 0 : 0.4, ease: [0.22, 1, 0.36, 1] } }}
    >
      <button
        type="button"
        className="product__shot"
        onClick={() => onSelect(product)}
        onMouseEnter={() => onFocus(product)}
        onFocus={() => onFocus(product)}
        aria-label={`${product.name}, ${price}${soldOut ? ", out of stock" : ""}. Show details.`}
      >
        <img
          src={product.imageUrl}
          alt=""
          width={640}
          height={800}
          loading="lazy"
          decoding="async"
          className="product__img"
        />
        {soldOut ? <span className="product__flag">Out of stock</span> : null}
      </button>

      <div className="product__body">
        <p className="product__category">{product.category}</p>
        <h4 className="product__name">{product.name}</h4>
        <p className="product__price">{price}</p>

        {/* Only ever present because the server actually described this photo. */}
        {product.visualDescription ? (
          <p className="product__desc">{product.visualDescription}</p>
        ) : null}

        <div className="product__actions">
          <button type="button" className="btn btn--ghost" onClick={() => onSelect(product)}>
            Details
          </button>
          <button
            type="button"
            className="btn btn--solid"
            onClick={() => onAdd(product)}
            disabled={soldOut}
            aria-label={`Add ${product.name} to cart, ${price}`}
          >
            {soldOut ? "Sold out" : "Add"}
          </button>
        </div>
      </div>
    </motion.article>
  );
}

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency || "INR",
    maximumFractionDigits: 0,
  }).format(value);
}
