import OpenAI from "openai";
import { config } from "../config.js";
import { VisionError } from "./errors.js";
import {
  VISION_SYSTEM_PROMPT,
  normalizeVisualAnalysis,
  type VisionAnalysis,
} from "./attributes.js";

/** What a vision provider must be able to do for this feature. */
export interface VisionClient {
  analyze(input: { dataUrl: string; mimeType: string }): Promise<VisionAnalysis>;
}

export interface OpenAiVisionClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** "low" keeps tokens (and latency) down for catalog photos. */
  detail?: "low" | "high" | "auto";
}

const VISION_USER_PROMPT =
  "Describe this product photo for a blind shopper. Reply with JSON only.";

/**
 * Vision-capable analysis on the SAME OpenAI-compatible provider, API key and
 * base URL the conversation brain already uses (LLM_MODEL-compatible gateways
 * work unchanged). The image is sent as an inline data URL, so nothing is
 * uploaded to a third party and no public URL for the photo is required.
 */
export class OpenAiVisionClient implements VisionClient {
  private client: OpenAI;
  private model: string;
  private detail: "low" | "high" | "auto";

  constructor(opts: OpenAiVisionClientOptions = {}) {
    const apiKey = opts.apiKey ?? config.openaiKey;
    if (!apiKey) throw new VisionError("vision_failed", "no_vision_credential");
    this.client = new OpenAI({ apiKey, baseURL: opts.baseUrl ?? (config.openaiBaseUrl || undefined) });
    this.model = opts.model ?? config.visionModel;
    this.detail = opts.detail ?? "low";
  }

  async analyze(input: { dataUrl: string; mimeType: string }): Promise<VisionAnalysis> {
    let content: string | null | undefined;
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: VISION_USER_PROMPT },
              { type: "image_url", image_url: { url: input.dataUrl, detail: this.detail } },
            ],
          },
        ],
      });
      content = completion.choices[0]?.message?.content;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new VisionError("vision_failed", `vision_call_failed: ${reason.slice(0, 200)}`);
    }

    const analysis = normalizeVisualAnalysis(extractJson(content));
    if (!analysis.description && !Object.keys(analysis.attributes).length) {
      throw new VisionError("vision_failed", "vision_returned_nothing_usable");
    }
    return analysis;
  }
}

/** Tolerates a stray code fence or prose around the JSON object. */
function extractJson(content: string | null | undefined): unknown {
  if (!content) throw new VisionError("vision_failed", "vision_returned_empty_content");
  const trimmed = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new VisionError("vision_failed", "vision_returned_unparseable_json");
  }
}
