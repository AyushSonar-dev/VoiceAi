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
  },
  { timestamps: false, versionKey: false }
);

export const ConversationSession =
  mongoose.models.ConversationSession ||
  mongoose.model("ConversationSession", conversationSessionSchema);