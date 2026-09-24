"use client";

import { useState, type FormEvent } from "react";
import type { CartSummary } from "@/types";

interface Props {
  cart: CartSummary;
  currency: string;
  busy: boolean;
  onRemove: (productName: string) => void;
  onApplyCoupon: (code: string) => void;
  onCheckout: () => void;
}

export function CartPanel({ cart, currency, busy, onRemove, onApplyCoupon, onCheckout }: Props) {
  const [code, setCode] = useState("");
  const money = (n: number) => `${currency}${n.toLocaleString("en-IN")}`;

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    onApplyCoupon(trimmed);
    setCode("");
  };

  return (
    <section className="card" aria-labelledby="cart-heading">
      <h2 id="cart-heading">Your cart</h2>
      {cart.isEmpty ? (
        <p style={{ margin: 0, color: "var(--muted)" }}>Empty — say “add the first one to my cart”.</p>
      ) : (
        <>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {cart.lines.map((line) => (
              <li key={line.productId} className="cart-line">
                <span>
                  {line.name}{" "}
                  <span style={{ color: "var(--muted)" }}>× {line.quantity}</span>
                </span>
                <span className="row">
                  <strong>{money(line.lineTotal)}</strong>
                  <button
                    type="button"
                    className="btn danger"
                    disabled={busy}
                    onClick={() => onRemove(line.name)}
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>

          <div className="cart-totals">
            <div className="row spread">
              <span>Subtotal</span>
              <span>{money(cart.subtotal)}</span>
            </div>
            {cart.discountPercent > 0 && (
              <div className="row spread" style={{ color: "var(--ok)" }}>
                <span>
                  Coupon {cart.couponCode} (−{cart.discountPercent}%)
                </span>
                <span>−{money(cart.discount)}</span>
              </div>
            )}
            <div className="row spread" style={{ fontWeight: 700 }}>
              <span>Total</span>
              <span>{money(cart.total)}</span>
            </div>
          </div>

          <form onSubmit={apply} className="row" aria-label="Apply a coupon" style={{ marginTop: "0.9rem" }}>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Coupon code, e.g. WELCOME15"
              disabled={busy}
              aria-label="Coupon code"
            />
            <button type="submit" className="btn" disabled={busy || !code.trim()}>
              Apply
            </button>
          </form>

          <button type="button" className="btn primary" disabled={busy} onClick={onCheckout} style={{ marginTop: "0.75rem" }}>
            Check out
          </button>
        </>
      )}
    </section>
  );
}