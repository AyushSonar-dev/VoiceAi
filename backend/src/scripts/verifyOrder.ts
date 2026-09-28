import mongoose from "mongoose";
import { Order } from "../models/Order.js";
import { config } from "../config.js";

/**
 * A read-only look at the most recent end-to-end order, to confirm a checkout
 * actually persisted.
 *
 * The shape of the rows is declared here rather than on the shared models,
 * because the models are intentionally schema-only and are used untyped
 * everywhere else. Typing the query results at the point of use keeps this check
 * honest without changing how anything else reads the database.
 */
interface OrderRow {
  sessionId: string;
  items: Array<{ productId: string; quantity: number; priceAtOrder: number }>;
  couponApplied?: { code?: string; discountPercent?: number };
  total: number;
  status: string;
  createdAt?: Date;
}

/** The cart collection stores its lines under `items`, matching the schema. */
interface CartRow {
  items?: Array<{ productId: string; quantity: number }>;
}

async function main(): Promise<void> {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });

  const latest = await Order.findOne({ sessionId: /^e2e-/ })
    .sort({ createdAt: -1 })
    .lean<OrderRow>();

  if (!latest) {
    console.log("NO_E2E_ORDER");
    await mongoose.disconnect();
    return;
  }

  const recent = await Order.countDocuments({ sessionId: latest.sessionId });
  const cartColl = mongoose.connection.collection("carts");
  const cart = (await cartColl.findOne({ sessionId: latest.sessionId })) as unknown as
    | CartRow
    | null;

  console.log(
    "latest order:",
    JSON.stringify({
      sessionId: latest.sessionId,
      items: latest.items,
      couponApplied: latest.couponApplied,
      total: latest.total,
      status: latest.status,
      createdAt: latest.createdAt,
    })
  );
  console.log("orders for that session:", recent);

  const items = cart?.items ?? [];
  console.log(
    "cart for that session:",
    JSON.stringify({ items, isEmpty: items.length === 0 })
  );

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("VERIFY FATAL", e);
  process.exitCode = 1;
});
