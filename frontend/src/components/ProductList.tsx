"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ProductCard } from "./ProductCard";
import type { RecentProduct } from "@/types";

interface Props {
  products: RecentProduct[];
  spotlightId: string | null;
  currency: string;
  busy: boolean;
  onSelect: (product: RecentProduct) => void;
  onAdd: (product: RecentProduct) => void;
  onFocus: (product: RecentProduct) => void;
  reducedMotion: boolean;
}

/**
 * Results, revealed beneath the core.
 *
 * A plain list of products in a responsive grid. It enters with one soft, short
 * stagger — enough to guide the eye downward, short enough that it never delays
 * the first tap. With reduced motion the products are simply present.
 */
export function ProductList({
  products,
  spotlightId,
  currency,
  busy,
  onSelect,
  onAdd,
  onFocus,
  reducedMotion,
}: Props) {
  const libReduced = useReducedMotion();
  const still = reducedMotion || libReduced === true;

  if (products.length === 0) return null;

  return (
    <section className="results" aria-labelledby="results-heading">
      <h2 id="results-heading" className="results__heading">
        {products.length === 1 ? "1 result" : `${products.length} results`}
      </h2>

      <motion.ul
        className="results__grid"
        initial="hidden"
        animate="shown"
        variants={{
          hidden: {},
          shown: { transition: { staggerChildren: still ? 0 : 0.05 } },
        }}
      >
        <AnimatePresence initial={false}>
          {products.map((product) => (
            <motion.li
              key={product.id}
              className="results__item"
              variants={{
                hidden: still ? { opacity: 1 } : { opacity: 0, y: 14 },
                shown: { opacity: 1, y: 0 },
              }}
              exit={still ? { opacity: 1 } : { opacity: 0, y: -8 }}
              transition={{ duration: still ? 0 : 0.34, ease: [0.22, 1, 0.36, 1] }}
            >
              <ProductCard
                product={product}
                spotlight={product.id === spotlightId}
                currency={currency}
                onSelect={onSelect}
                onAdd={(p) => {
                  if (!busy) onAdd(p);
                }}
                onFocus={onFocus}
                reducedMotion={reducedMotion}
              />
            </motion.li>
          ))}
        </AnimatePresence>
      </motion.ul>
    </section>
  );
}
