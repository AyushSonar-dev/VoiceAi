"use client";

import type { OrderInfo } from "@/types";

interface Props {
  order: OrderInfo;
  currency: string;
}

export function CheckoutPanel({ order, currency }: Props) {
  return (
    <section className="card" aria-labelledby="order-heading" style={{ borderColor: "var(--ok)" }}>
      <h2 id="order-heading" style={{ color: "var(--ok)" }}>
        Order #{(order.id ?? "").slice(0, 6)} confirmed
      </h2>
      <p style={{ margin: 0 }}>
        Total {currency}
        {order.total.toLocaleString("en-IN")} · status: <strong>{order.status}</strong>
      </p>
    </section>
  );
}