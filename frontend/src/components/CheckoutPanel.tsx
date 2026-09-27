"use client";

import { motion } from "framer-motion";
import type { OrderInfo } from "@/types";

interface Props {
  order: OrderInfo;
  currency: string;
  reducedMotion: boolean;
}

export function CheckoutPanel({ order, currency, reducedMotion }: Props) {
  const total = `${currency}${order.total.toLocaleString("en-IN")}`;

  return (
    <motion.section
      className="panel notice notice--good"
      aria-labelledby="order-heading"
      initial={reducedMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.35 }}
    >
      <h2 id="order-heading" style={{ fontSize: "1.1rem", marginBottom: "0.35rem" }}>
        Order #{(order.id ?? "").slice(0, 6)} confirmed
      </h2>
      <p style={{ margin: 0 }}>
        Total {total} · status <strong>{order.status}</strong>
      </p>
    </motion.section>
  );
}
