"use client";

import { useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import type { CartSummary } from "@/types";

interface Props {
  cart: CartSummary;
  currency: string;
  busy: boolean;
  reducedMotion: boolean;
  onRemove: (productName: string) => void;
  onApplyCoupon: (code: string) => void;
  onCheckout: () => void;
}

export function CartPanel({ cart, currency, busy, reducedMotion, onRemove, onApplyCoupon, onCheckout }: Props) {
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
    <section className="panel stack" aria-labelledby="cart-heading">
      <div className="cluster" style={{ justifyContent: "space-between" }}>
        <h2 id="cart-heading" className="section-title" style={{ margin: 0 }}>
          Your cart
        </h2>
        {cart.isEmpty ? null : (
          <span className="badge">
            {cart.lines.reduce((n, l) => n + l.quantity, 0)} items
          </span>
        )}
      </div>

      {cart.isEmpty ? (
        <p className="muted" style={{ margin: 0 }}>
          Your cart is empty. Ask Echo to add something — “add the first one to my cart”.
        </p>
      ) : (
        <>
          <ul className="cart-lines">
            {cart.lines.map((line) => (
              <motion.li
                key={line.productId}
                className="cart-line"
                initial={reducedMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: reducedMotion ? 0 : 0.25 }}
              >
                <span className="cart-line__name">
                  {line.name} <span className="muted">× {line.quantity}</span>
                </span>
                <span className="cluster" style={{ gap: "0.5rem" }}>
                  <strong>{money(line.lineTotal)}</strong>
                  <button
                    type="button"
                    className="btn btn--quiet btn--danger"
                    disabled={busy}
                    onClick={() => onRemove(line.name)}
                    aria-label={`Remove ${line.name} from your cart`}
                  >
                    Remove
                  </button>
                </span>
              </motion.li>
            ))}
          </ul>

          <div className="cart-totals">
            <div className="cart-totals__row">
              <span>Subtotal</span>
              <span>{money(cart.subtotal)}</span>
            </div>
            {cart.discountPercent > 0 ? (
              <div className="cart-totals__row cart-totals__row--discount">
                <span>
                  Coupon {cart.couponCode} (−{cart.discountPercent}%)
                </span>
                <span>−{money(cart.discount)}</span>
              </div>
            ) : null}
            <div className="cart-totals__row cart-totals__row--total">
              <span>Total</span>
              <span>{money(cart.total)}</span>
            </div>
          </div>

          <form className="form-row" onSubmit={apply} aria-label="Apply a coupon">
            <div className="field">
              <label className="field__label" htmlFor="coupon-code">
                Coupon code
              </label>
              <input
                id="coupon-code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="e.g. WELCOME15"
                disabled={busy}
                autoComplete="off"
              />
            </div>
            <button type="submit" className="btn" disabled={busy || !code.trim()}>
              Apply
            </button>
          </form>

          <button
            type="button"
            className="btn btn--primary btn--block"
            disabled={busy}
            onClick={onCheckout}
          >
            Check out — {money(cart.total)}
          </button>
        </>
      )}
    </section>
  );
}
