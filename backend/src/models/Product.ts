import mongoose from "mongoose";
import { ALLOWED_CATEGORIES } from "../config.js";
import type { Category, ProductAppearance } from "../types.js";

const { Schema } = mongoose;

/**
 * Every field is optional, so the sub-document validates for any category
 * (a pair of earbuds has no neckline; a dress may have no stated texture) and
 * a product that simply hasn't been described yet stays valid. Explicitly
 * avoiding `required` is the point: a missing field must round-trip as
 * "not specified" so the agent can say so instead of guessing.
 */
const appearanceSchema = new Schema<ProductAppearance>(
  {
    primaryColor: { type: String, trim: true },
    secondaryColors: { type: [String] },
    pattern: { type: String, trim: true },
    details: { type: [String] },
    texture: { type: String, trim: true },
    styleImpression: { type: String, trim: true },
    summary: { type: String, trim: true },
  },
  { _id: false }
);

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
  /** Trusted visual description. Absent means "not specified", never inferred. */
  appearance?: ProductAppearance;
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
    // Optional on purpose: catalogs seeded before appearance data existed stay
    // valid, and the agent answers "I don't have that detail" for those.
    appearance: { type: appearanceSchema, default: undefined },
  },
  { timestamps: false, versionKey: false }
);

productSchema.index({ name: 1, category: 1 });

export const Product = (mongoose.models.Product || mongoose.model<ProductDoc>("Product", productSchema)) as mongoose.Model<ProductDoc>;