"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { OrderInfo } from "@/types";
import { formatMoney } from "@/lib/money";

interface Props {
  order: OrderInfo | null;
  currency: string;
  onDismiss: () => void;
  reducedMotion: boolean;
}

/**
 * Order confirmation, on the same surface as everything else.
 *
 * It sits directly beneath the core rather than in its own panel, so finishing
 * an order reads as the end of the conversation instead of a jump to a different
 * screen. The text is the confirmation; nothing about it is communicated only by
 * an animation.
 */
export function CheckoutPanel({ order, currency, onDismiss, reducedMotion }: Props) {
  const libReduced = useReducedMotion();
  const still = reducedMotion || libReduced === true;

  return (
    <AnimatePresence>
      {order ? (
        <motion.section
          className="confirmed"
          aria-label="Order confirmed"
          initial={still ? { opacity: 0 } : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={still ? { opacity: 0 } : { opacity: 0, y: -8 }}
          transition={{ duration: still ? 0.15 : 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className="confirmed__kicker">Order placed</p>
          <h2 className="confirmed__title">{formatMoney(order.total, currency)}</h2>
          <dl className="confirmed__meta">
            <div>
              <dt>Order</dt>
              <dd>{order.id}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{order.status}</dd>
            </div>
          </dl>
          <button type="button" className="btn btn--ghost" onClick={onDismiss}>
            Back to shopping
          </button>
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}
