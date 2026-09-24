import type { Coupon } from "../types.js";

export type CouponSeed = Omit<Coupon, "id">;

export const SEED_COUPONS: CouponSeed[] = [
  { code: "WELCOME15", discountPercent: 15, active: true },
  { code: "SAVE10", discountPercent: 10, active: true },
  { code: "VIP20", discountPercent: 20, active: true },
  { code: "FLASH25", discountPercent: 25, active: true },
  { code: "EXPIRED50", discountPercent: 50, active: false },
];