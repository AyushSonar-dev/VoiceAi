import mongoose from "mongoose";

const { Schema } = mongoose;

const couponSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, trim: true, uppercase: true },
    discountPercent: { type: Number, required: true, min: 1, max: 100 },
    active: { type: Boolean, required: true, default: true },
  },
  { timestamps: false, versionKey: false }
);

export const Coupon = mongoose.models.Coupon || mongoose.model("Coupon", couponSchema);