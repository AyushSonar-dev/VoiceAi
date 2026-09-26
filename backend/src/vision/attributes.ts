/**
 * Visual attribute vocabulary + the spoken-description rules.
 *
 * This is the anti-hallucination layer: the vision model may only report the
 * keys listed here, and a value is only kept when it actually says something.
 * Anything the model was unsure about is dropped and reported separately as
 * "not determined" so the agent can say "I can't reliably determine that
 * detail from the image" instead of inventing one.
 */
export const VISUAL_ATTRIBUTE_KEYS = [
  "itemType", // garment / device / jewellery type actually visible
  "color",
  "pattern",
  "silhouette", // overall shape or cut
  "neckline",
  "sleeves",
  "length",
  "style",
  "material", // how the surface looks (not what the catalog claims)
  "closure", // buttons, zip, tie, clasp, buckle…
  "details", // pockets, buttons, ruffle, logo, stitching, trim…
  "shape",
  "form", // for devices: what the physical object looks like
  "screen",
  "controls",
  "ports",
  "sole",
  "fastening",
  "stones",
  "chain",
  "pendant",
] as const;

export type VisualAttributeKey = (typeof VISUAL_ATTRIBUTE_KEYS)[number];

export type VisualAttributes = Partial<Record<VisualAttributeKey, string>>;

export interface VisionAnalysis {
  /** One or two short sentences, written to be spoken aloud. */
  description: string;
  attributes: VisualAttributes;
  /** Attribute keys the image did not let the model determine. */
  notDetermined: VisualAttributeKey[];
}

/** Placeholder answers that carry no information and must never be spoken. */
const EMPTY_VALUES = new Set([
  "",
  "-",
  "unknown",
  "unclear",
  "not sure",
  "not visible",
  "not shown",
  "not applicable",
  "n/a",
  "na",
  "null",
  "nil",
  "cannot determine",
  "not determinable",
  "i can't tell",
  "no idea",
  "not specified",
  "unavailable",
]);

function cleanValue(raw: unknown): string | null {
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (typeof raw !== "string") return null;
  const value = raw.replace(/\s+/g, " ").trim().replace(/[.;,]+$/, "");
  if (!value || value.length > 120) return null;
  if (EMPTY_VALUES.has(value.toLowerCase())) return null;
  return value;
}

function cleanKey(raw: unknown): VisualAttributeKey | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return (VISUAL_ATTRIBUTE_KEYS as readonly string[]).includes(key)
    ? (key as VisualAttributeKey)
    : null;
}

/**
 * Keep only real, in-vocabulary attributes. Returns the cleaned set plus the
 * keys the model explicitly could not determine.
 */
export function normalizeVisualAnalysis(raw: unknown): VisionAnalysis {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const attributes: VisualAttributes = {};
  const reported = (source.visualAttributes ?? source.attributes) as Record<string, unknown> | undefined;
  if (reported && typeof reported === "object") {
    for (const [rawKey, rawValue] of Object.entries(reported)) {
      const key = cleanKey(rawKey);
      if (!key) continue; // out-of-vocabulary key -> dropped, never spoken
      const value = cleanValue(rawValue);
      if (value) attributes[key] = value;
    }
  }

  const notDetermined: VisualAttributeKey[] = [];
  const rawUndetermined = Array.isArray(source.notDetermined) ? source.notDetermined : [];
  for (const entry of rawUndetermined) {
    const key = cleanKey(entry);
    if (key && !notDetermined.includes(key) && !(key in attributes)) notDetermined.push(key);
  }

  return {
    description: sanitizeSpokenDescription(typeof source.description === "string" ? source.description : ""),
    attributes,
    notDetermined,
  };
}

/**
 * Spoken accessibility: at most two sentences, no camera/photography language
 * ("the image contains a product positioned centrally…"), no bullet lists.
 */
export function sanitizeSpokenDescription(text: string, maxChars = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const sentences = (flat.match(/[^.!?]+[.!?]*/g) ?? [flat]).map((s) => s.trim()).filter(Boolean);
  let out = sentences.slice(0, 2).join(" ").trim();
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const lastStop = Math.max(cut.lastIndexOf("."), cut.lastIndexOf(","));
    out = `${(lastStop > 40 ? cut.slice(0, lastStop) : cut).trim()}…`;
  }
  return out;
}

export function attributesToText(attributes: VisualAttributes): string {
  return Object.entries(attributes)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
}

/**
 * Only used when the model returned attributes but no sentence. Built purely
 * from values the model itself reported as visible — still no invention, just
 * a plain way to say them out loud.
 */
export function fallbackDescription(attributes: VisualAttributes): string {
  const pick = (...keys: VisualAttributeKey[]): string | null => {
    for (const key of keys) {
      const value = attributes[key];
      if (value) return value;
    }
    return null;
  };
  const parts: string[] = [];
  const type = pick("itemType", "form");
  const color = pick("color");
  if (color && type) parts.push(`${color} ${type}`);
  else if (color) parts.push(color);
  else if (type) parts.push(type);
  const design = pick("pattern", "silhouette", "shape", "neckline", "sleeves", "details", "style");
  if (design) parts.push(design);
  if (!parts.length) return "";
  return sanitizeSpokenDescription(`It's ${parts.join(" with a ")}.`);
}

/**
 * The model is given the IMAGE ONLY — no product name, category, price or spec
 * text — so nothing it reports can be echoed back from catalog wording. It is
 * asked for strict JSON and for silence on anything it cannot see.
 */
export const VISION_SYSTEM_PROMPT = `You describe product photographs for a blind shopper who cannot see them.

Look ONLY at the image. You are deliberately NOT told the product name, brand, price or specifications, so never guess them and never say "this is a <brand> <item>" from prior knowledge — describe what is actually visible.

Report only what you can genuinely SEE. Prefer the 2 to 4 most useful facts for deciding whether to buy. Use the vocabulary below and omit anything that is hidden, unclear or not part of this kind of item:
${VISUAL_ATTRIBUTE_KEYS.join(", ")}
- For clothing: itemType, color, pattern, neckline, sleeves, length, silhouette, style, material, closure, details.
- For shoes: itemType, color, pattern, shape, sole, fastening, material, details.
- For electronics: form, color, screen, controls, ports, material, details.
- For jewellery: itemType, shape, color, material, stones, chain, pendant, fastening, details.

Rules:
- Describe colour, pattern, shape, texture and construction as seen, not as a brand would market them.
- If an attribute is not visible or not applicable, leave it out. Never estimate, never complete from a stereotype of the item type, never describe the background, the surface, the lighting, the watermark or the camera angle unless the user could not otherwise tell the item apart.
- description: ONE or TWO short sentences, written to be read aloud by a screen reader. Natural spoken English, for example "It's a white midi dress with a V-neck, short ruffle sleeves and a small floral print." Never say "the image", "the photo", "I can see", "as you can see" or "the picture shows".
- Use a plain ASCII apostrophe and no markdown.

Answer with JSON only, in exactly this shape:
{"description":"...","visualAttributes":{"color":"...","pattern":"..."},"notDetermined":["..."]}`;
