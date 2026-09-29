import mongoose from "mongoose";

const { Schema } = mongoose;

const conversationSessionSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    // The ONLY product ids a model may reference this turn. Backend tools
    // structurally reject ids outside this list. Most-recent-first.
    recentProductIds: { type: [String], default: [] },
    // Last tool action performed in this session (used for idempotency).
    lastAction: { type: Schema.Types.Mixed, default: null },

    // --- Extended conversational memory fields ---
    // The product currently being discussed (for follow-up questions like "what about the sleeves?")
    currentProductId: { type: String, default: null },
    // The most recent search query for context
    recentSearchQuery: { type: String, default: null },
    // The category of the recent search
    recentCategory: { type: String, default: null },
    // The inferred intent of the recent interaction
    recentIntent: { type: String, default: null },
    // Bounded history of product references with context (max 10)
    recentProductReferences: [
      {
        productId: { type: String, required: true },
        context: { type: String, required: true }, // e.g., "search", "getProduct", "addToCart"
        timestamp: { type: Number, required: true },
      },
    ],
    // Bounded conversation turn count (for debugging/metrics)
    turnCount: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false }
);

// Index for faster lookups
conversationSessionSchema.index({ sessionId: 1 });

export const ConversationSession =
  mongoose.models.ConversationSession ||
  mongoose.model("ConversationSession", conversationSessionSchema);