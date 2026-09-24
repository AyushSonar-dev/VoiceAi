import { initStore, getMode } from "../db/index.js";
import { config } from "../config.js";

async function main(): Promise<void> {
  const store = await initStore();
  const products = await store.allProducts();
  const coupon = await store.findCouponByCode("WELCOME15");

  console.log("EchoLabs seed summary");
  console.log("--------------------");
  console.log(`Store mode : ${getMode()}`);
  console.log(`Products   : ${products.length}`);
  const byCategory: Record<string, number> = {};
  for (const p of products) byCategory[p.category] = (byCategory[p.category] || 0) + 1;
  for (const [cat, n] of Object.entries(byCategory)) console.log(`  ${cat}: ${n}`);
  console.log(`Coupons    : ${coupon ? `e.g. ${coupon.code} (${coupon.discountPercent}%)` : "none"}`);
  console.log(`Currency   : ${config.currency}`);
  if (getMode() === "memory") {
    console.warn(
      "\nNOTE: running against the in-memory PLACEHOLDER store. Set MONGODB_URI to persist."
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});