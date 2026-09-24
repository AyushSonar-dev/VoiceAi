import mongoose from "mongoose";
import { Order } from "../models/Order.js";
import { config } from "../config.js";

async function main(): Promise<void> {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  const latest = await Order.findOne({ sessionId: /^e2e-/ }).sort({ createdAt: -1 }).lean();
  if (!latest) {
    console.log("NO_E2E_ORDER");
    await mongoose.disconnect();
    return;
  }
  const recent = await Order.countDocuments({ sessionId: latest.sessionId });
  const cartColl = mongoose.connection.collection("carts");
  const cart = await cartColl.findOne({ sessionId: latest.sessionId });
  console.log("latest order:", JSON.stringify({ sessionId: latest.sessionId, items: latest.items, couponApplied: latest.couponApplied, total: latest.total, status: latest.status, createdAt: latest.createdAt }));
  console.log("orders for that session:", recent);
  console.log("cart for that session:", JSON.stringify(cart ? { lines: cart.lines, isEmpty: (cart.lines ?? []).length === 0 } : null));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("VERIFY FATAL", e);
  process.exitCode = 1;
});