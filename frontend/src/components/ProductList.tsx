"use client";

import { AnimatePresence, motion } from "framer-motion";
import type { RecentProduct } from "@/types";
import { ProductCard } from "./ProductCard";

interface Props {
  products: RecentProduct[];
  currency: string;
  busy: boolean;
  reducedMotion: boolean;
  /** id of the product Echo is describing right now, if any */
  spotlightId: string | null;
  onAdd: (optionIndex: number) => void;
}

export function ProductList({
  products,
  currency,
  busy,
  reducedMotion,
  spotlightId,
  onAdd,
}: Props) {
  if (products.length === 0) return null;

  return (
    <section aria-labelledby="products-heading" className="stack">
      <div className="cluster" style={{ justifyContent: "space-between" }}>
        <h2 id="products-heading" className="section-title" style={{ margin: 0 }}>
          {products.length === 1 ? "1 option" : `${products.length} options`}
        </h2>
        <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>
          Echo picked these for you
        </p>
      </div>

      <ul className="results__grid">
        <AnimatePresence initial={false} mode="popLayout">
          {products.map((p, index) => (
            <ProductCard
              key={p.id}
              product={p}
              index={index}
              currency={currency}
              busy={busy}
              reducedMotion={reducedMotion}
              spotlight={spotlightId === p.id}
              onAdd={onAdd}
            />
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}
