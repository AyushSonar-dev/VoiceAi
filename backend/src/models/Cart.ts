import mongoose from "mongoose";

const { Schema } = mongoose;

// Cart carries couponCode + discountPercent (explicitly approved addition —
// the plan's applyCoupon() tool needs a persisted home for the applied coupon).
const cartSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    items: [
      {
        productId: { type: String, required: true },
        quantity: { type: Number, required: true, min: 1, default: 1 },
      },
    ],
    couponCode: { type: String, default: null },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
  },
  { timestamps: false, versionKey: false }
);

export const Cart = mongoose.models.Cart || mongoose.model("Cart", cartSchema);