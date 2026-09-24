import mongoose from "mongoose";

const { Schema } = mongoose;

const orderSchema = new Schema(
  {
    sessionId: { type: String, required: true, index: true },
    items: [
      {
        productId: { type: String, required: true },
        quantity: { type: Number, required: true, min: 1 },
        priceAtOrder: { type: Number, required: true, min: 0 },
      },
    ],
    couponApplied: { code: { type: String }, discountPercent: { type: Number, min: 0, max: 100 } },
    total: { type: Number, required: true, min: 0 },
    status: { type: String, required: true, enum: ["confirmed"] },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

export const Order = mongoose.models.Order || mongoose.model("Order", orderSchema);