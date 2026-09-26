/**
 * Two failure modes the voice UX has to speak differently about:
 *
 * - `image_unavailable`  -> "I can't access the image for this product right now."
 * - `vision_failed`      -> "I couldn't analyze the product image right now. …"
 *
 * `detail` is a server-side reason code (logged, never spoken).
 */
export class VisionError extends Error {
  code: "image_unavailable" | "vision_failed";
  detail: string;

  constructor(code: "image_unavailable" | "vision_failed", detail: string) {
    super(`${code}:${detail}`);
    this.code = code;
    this.detail = detail;
  }
}
