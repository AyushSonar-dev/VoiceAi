"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import type { RecentProduct } from "@/types";

interface Props {
  product: RecentProduct;
  /** position in the agent's spoken options, 0-based */
  index: number;
  currency: string;
  busy: boolean;
  reducedMotion: boolean;
  /** the agent is currently describing this product */
  spotlight: boolean;
  onAdd: (optionIndex: number) => void;
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth"];

function money(currency: string, n: number): string {
  return `${currency}${n.toLocaleString("en-IN")}`;
}

/**
 * One product. Everything needed to make a decision is visible without hover
 * and without colour: image, name, price, rating, review count, key specs and
 * the action. The visual description from Echo's image analysis appears inline
 * as text, never as a tooltip.
 */
export function ProductCard({
  product,
  index,
  currency,
  busy,
  reducedMotion,
  spotlight,
  onAdd,
}: Props) {
  const [imageFailed, setImageFailed] = useState(false);
  const ordinal = ORDINALS[index] ?? `option ${index + 1}`;
  const price = money(currency, product.price);
  const rating = `${product.rating.toFixed(1)} out of 5`;

  return (
    <motion.li
      className={`product-card${spotlight ? " product-card--speaking" : ""}`}
      initial={reducedMotion ? false : { opacity: 0, y: 18, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        duration: reducedMotion ? 0 : 0.42,
        // Each card settles a beat after the one before it, so results read as
        // a sequence of discoveries rather than a grid appearing at once.
        delay: reducedMotion ? 0 : Math.min(index, 6) * 0.07,
        ease: [0.22, 0.61, 0.36, 1],
      }}
      layout={!reducedMotion ? "position" : false}
    >
      <figure className="product-card__figure">
        {product.imageUrl && !imageFailed ? (
          // The backend serves these itself; alt text is the product name, and
          // the visual description is exposed as text below rather than here.
          <img
            className="product-card__image"
            src={product.imageUrl}
            alt={`${product.name} — ${product.category}`}
            loading="lazy"
            decoding="async"
            width={480}
            height={480}
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div className="product-card__image--missing" role="img" aria-label={`${product.name} has no photo`}>
            No photo available
          </div>
        )}
        <figcaption className="product-card__tag">
          {product.category} · Option {index + 1}
        </figcaption>
      </figure>

      <div className="product-card__body">
        <h3 className="product-card__name">{product.name}</h3>

        <p className="product-card__price">
          {price}
          {product.inStock ? null : <span className="muted"> · out of stock</span>}
        </p>

        <p className="product-card__rating">
          <span aria-hidden="true" className="product-card__rating-star">
            ★
          </span>
          <span>
            <span className="sr-only">Rated </span>
            {rating}
            <span className="muted">
              {" "}
              · {product.reviewCount} {product.reviewCount === 1 ? "review" : "reviews"}
            </span>
          </span>
        </p>

        {product.keySpecs.length > 0 ? (
          <ul className="product-card__specs">
            {product.keySpecs.slice(0, 3).map((spec) => (
              <li key={spec}>{spec}</li>
            ))}
          </ul>
        ) : null}

        {product.visualDescription ? (
          <p className="product-card__visual">
            <strong>From the photo</strong>
            {product.visualDescription}
          </p>
        ) : null}

        <div className="product-card__foot">
          {product.inStock ? (
            <button
              type="button"
              className="btn btn--primary btn--block"
              disabled={busy}
              onClick={() => onAdd(index)}
              aria-label={`Add the ${ordinal} option, ${product.name}, ${price}, to your cart`}
            >
              Add to cart
            </button>
          ) : (
            <p className="product-card__oos">
              Out of stock — ask Echo for an alternative in {product.category}.
            </p>
          )}
        </div>
      </div>
    </motion.li>
  );
}
