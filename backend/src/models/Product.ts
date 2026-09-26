import mongoose from "mongoose";
import { ALLOWED_CATEGORIES } from "../config.js";
import type { Category } from "../types.js";

const { Schema } = mongoose;

export interface ProductDoc {
  _id: mongoose.Types.ObjectId | string;
  name: string;
  category: Category;
  price: number;
  stock: number;
  rating: number;
  reviewCount: number;
  keySpecs: string[];
  description: string;
  /** Store-relative path (or absolute http(s) URL) of the product photo. */
  imageUrl: string;
}

const productSchema = new Schema<ProductDoc>(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true, enum: ALLOWED_CATEGORIES },
    price: { type: Number, required: true, min: 0 },
    stock: { type: Number, required: true, min: 0 },
    rating: { type: Number, required: true, min: 0, max: 5 },
    reviewCount: { type: Number, required: true, min: 0 },
    keySpecs: {
      type: [String],
      validate: {
        validator: (v: string[]) => v.length <= 3,
        message: "keySpecs must contain at most 3 entries",
      },
    },
    description: { type: String, required: true, trim: true },
    // The product photo. Optional so pre-existing documents stay valid; an
    // empty value simply means "no image available" (never guessed around).
    imageUrl: { type: String, default: "", trim: true },
  },
  { timestamps: false, versionKey: false }
);

productSchema.index({ name: 1, category: 1 });

export const Product = (mongoose.models.Product || mongoose.model<ProductDoc>("Product", productSchema)) as mongoose.Model<ProductDoc>;