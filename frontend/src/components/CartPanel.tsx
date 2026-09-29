"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { CartSummary } from "@/types";
import { formatMoney } from "@/lib/money";

interface Props {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  cart: CartSummary | null;
  currency: string;
  busy: boolean;
  onRemove: (productName: string) => void;
  onApplyCoupon: (code: string) => void;
  onCheckout: () => void;
  reducedMotion: boolean;
}

/**
 * The cart, out of the main flow.
 *
 * While connected, the cart is a single line of type in the header — a count and
 * a total — that opens a drawer. It stays completely functional, but it stops
 * competing with the core for attention, which is exactly what made the earlier
 * two-column layout read as a dashboard.
 *
 * Every mutation still goes through the same tool gateway the voice uses, so a
 * click and a spoken request are indistinguishable to the backend.
 */
export function CartPanel({
  open,
  onOpen,
  onClose,
  cart,
  currency,
  busy,
  onRemove,
  onApplyCoupon,
  onCheckout,
  reducedMotion,
}: Props) {
  const [code, setCode] = useState("");
  const libReduced = useReducedMotion();
  const still = reducedMotion || libReduced === true;

  // Escape closes the drawer, and focus is not trapped: the toggle in the
  // header remains reachable, so this is a disclosure rather than a modal and
  // keyboard users are never stranded.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const lines = cart?.lines ?? [];
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const total = cart?.total ?? 0;
  const discount = cart?.discount ?? 0;

  const submitCoupon = (event: FormEvent) => {
    event.preventDefault();
    const value = code.trim();
    if (!value || busy) return;
    onApplyCoupon(value);
    setCode("");
  };

  return (
    <>
      <div className="cartbar">
        <button
          type="button"
          className="cartbar__toggle"
          onClick={onOpen}
          aria-expanded={open}
          aria-controls="cart-drawer"
        >
          <span className="cartbar__label">Cart</span>
          <span className="cartbar__count">{count}</span>
          <span className="cartbar__total">{formatMoney(total, currency)}</span>
        </button>
        {/* A cart changed by voice is announced here, so the drawer does not
            have to open to make the change perceptible. */}
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {count === 0
            ? "Cart is empty."
            : `Cart has ${count} item${count === 1 ? "" : "s"}, total ${formatMoney(total, currency)}.`}
        </span>
      </div>

      <AnimatePresence>
        {open ? (
          <motion.div
            key="scrim"
            className="drawer-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: still ? 0.1 : 0.24 }}
            onClick={onClose}
            aria-hidden="true"
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {open ? (
          <motion.aside
            id="cart-drawer"
            className="drawer"
            aria-label="Your cart"
            initial={still ? { opacity: 0 } : { opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={still ? { opacity: 0 } : { opacity: 0, x: 24 }}
            transition={{ duration: still ? 0.12 : 0.3, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="drawer__bar">
              <h2 className="drawer__heading">
                Cart{" "}
                <span className="drawer__muted">
                  {count === 0 ? "empty" : `${count} item${count === 1 ? "" : "s"}`}
                </span>
              </h2>
              <button type="button" className="linkish" onClick={onClose}>
                Close
              </button>
            </div>

            {count === 0 ? (
              <p className="drawer__empty">
                Nothing here yet. Ask Echo to find something and it will add it for you.
              </p>
            ) : (
              <>
                <ul className="lines">
                  {lines.map((line) => (
                    <li key={line.productId} className="lines__row">
                      <span className="lines__name">
                        {line.name}
                        {line.quantity > 1 ? (
                          <span className="lines__qty"> ×{line.quantity}</span>
                        ) : null}
                      </span>
                      <span className="lines__price">
                        {formatMoney(line.lineTotal, currency)}
                      </span>
                      <button
                        type="button"
                        className="linkish lines__remove"
                        onClick={() => onRemove(line.name)}
                        disabled={busy}
                        aria-label={`Remove ${line.name} from cart`}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>

                <dl className="totals">
                  <div className="totals__row">
                    <dt>Subtotal</dt>
                    <dd>{formatMoney(cart?.subtotal ?? 0, currency)}</dd>
                  </div>
                  {discount > 0 ? (
                    <div className="totals__row totals__row--credit">
                      <dt>Discount{cart?.couponCode ? ` (${cart.couponCode})` : ""}</dt>
                      <dd>−{formatMoney(discount, currency)}</dd>
                    </div>
                  ) : null}
                  <div className="totals__row totals__row--grand">
                    <dt>Total</dt>
                    <dd>{formatMoney(total, currency)}</dd>
                  </div>
                </dl>

                <form className="coupon" onSubmit={submitCoupon}>
                  <label className="sr-only" htmlFor="coupon-code">
                    Coupon code
                  </label>
                  <input
                    id="coupon-code"
                    className="coupon__input"
                    type="text"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="Coupon code"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="submit"
                    className="btn btn--ghost"
                    disabled={busy || !code.trim()}
                  >
                    Apply
                  </button>
                </form>

                <button
                  type="button"
                  className="btn btn--solid btn--wide"
                  onClick={onCheckout}
                  disabled={busy}
                >
                  {busy ? "Working…" : "Checkout"}
                </button>
              </>
            )}
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </>
  );
}
