"use client";

import type { RecentProduct } from "@/types";

interface Props {
  products: RecentProduct[];
  currency: string;
  busy: boolean;
  onAdd: (optionIndex: number) => void;
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth"];

export function ProductList({ products, currency, busy, onAdd }: Props) {
  if (products.length === 0) {
    return (
      <section className="card" aria-labelledby="products-heading">
        <h2 id="products-heading">Your options</h2>
        <p style={{ margin: 0, color: "var(--muted)" }}>
          Nothing yet — ask for something like “show me jewelry under 2000”.
        </p>
      </section>
    );
  }

  const money = (n: number) => `${currency}${n.toLocaleString("en-IN")}`;

  return (
    <section className="card" aria-labelledby="products-heading">
      <h2 id="products-heading">Your options</h2>
      <ul className="products" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {products.map((p, index) => (
          <li key={p.id} className="product-card">
            <span className="category">
              {p.category} · Option {index + 1}
            </span>
            <h3>{p.name}</h3>
            <span className="price">{money(p.price)}</span>
            <span className="stars" aria-label={`Rated ${p.rating} out of 5 from ${p.reviewCount} reviews`}>
              ★ {p.rating.toFixed(1)}{" "}
              <span style={{ color: "var(--muted)", fontWeight: 400 }}>({p.reviewCount} reviews)</span>
            </span>
            <ul className="specs">
              {p.keySpecs.slice(0, 3).map((spec) => (
                <li key={spec}>{spec}</li>
              ))}
            </ul>
            {p.inStock ? (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => onAdd(index)}
              >
                Add the {ORDINALS[index] ?? `option ${index + 1}`} to cart
              </button>
            ) : (
              <p className="outOfStock" style={{ margin: 0 }}>
                Out of stock — ask Echo for an alternative in {p.category}.
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}