/**
 * Deterministic product-image assets for the catalog.
 *
 * Every seed product needs REAL image bytes, otherwise the visual-description
 * tool has nothing to look at and would be reduced to guessing from the product
 * name — which the feature explicitly must never do. This script renders one
 * clean studio product shot per product into
 * `backend/public/images/products/<slug>.png`, and the same slug is written to
 * `Product.imageUrl` by seed/productImages.ts, so image and catalog row can
 * never drift apart.
 *
 * It is a build-time asset step (no runtime dependency): run
 *   npm run images --workspace=backend
 * The output is committed, so the app works offline and the vision tool reads
 * the exact same bytes the browser loads.
 *
 * Zero dependencies: a tiny PNG encoder + scanline rasteriser on top of zlib.
 * Replace the generated PNGs with real photography any time — only the file at
 * the same path (or the product's imageUrl) has to change.
 */
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { SEED_PRODUCTS } from "../seed/products.js";
import { productImageFile, productImageUrl } from "../seed/productImages.js";

// ----------------------------------------------------------------- PNG output

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ raster

type RGB = [number, number, number];
/** A colour is either a resolved triple or a hex string literal. */
type Paint = RGB | string;
type Pt = [number, number];

const SS = 2; // supersampling per axis
const SIZE = 768;
const PX = SIZE * SS;

function hex(value: string): RGB {
  const m = value.trim().replace(/^#/, "");
  const n = m.length === 3
    ? m.split("").map((c) => c + c).join("")
    : m;
  if (!/^[0-9a-fA-F]{6}$/.test(n)) {
    // a malformed literal would otherwise become NaN and be written out as a
    // flat black patch, so refuse it here
    throw new Error(`invalid hex colour: "${value}"`);
  }
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}
const toRGB = (c: Paint): RGB => (typeof c === "string" ? hex(c) : c);
function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
const shade = (c: RGB, t: number): RGB => (t < 0 ? mix(c, [0, 0, 0], -t) : mix(c, [255, 255, 255], t));
const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * RGB float canvas in supersampled space, with an optional design-space clip
 * mask so a pattern can only paint inside a garment silhouette.
 */
class Raster {
  readonly data = new Float32Array(PX * PX * 3);
  private mask: Uint8Array | null = null;
  private maskBuf = new Uint8Array(SIZE * SIZE);

  reset(): void {
    this.data.fill(0);
    this.mask = null;
  }

  copyFrom(other: Raster): void {
    this.data.set(other.data);
  }

  private masked(x: number, y: number): boolean {
    if (!this.mask) return true;
    const mx = (x / SS) | 0;
    const my = (y / SS) | 0;
    return mx >= 0 && my >= 0 && mx < SIZE && my < SIZE && this.mask[my * SIZE + mx] === 1;
  }

  blend(x: number, y: number, paint: Paint, alpha: number): void {
    if (alpha <= 0 || x < 0 || y < 0 || x >= PX || y >= PX) return;
    if (this.mask && !this.masked(x, y)) return;
    const color = toRGB(paint);
    const i = (y * PX + x) * 3;
    const d = this.data;
    d[i] += (color[0] - d[i]) * alpha;
    d[i + 1] += (color[1] - d[i + 1]) * alpha;
    d[i + 2] += (color[2] - d[i + 2]) * alpha;
  }

  /** Per-pixel fill over a box, in design coordinates. */
  fillBox(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    fn: (x: number, y: number) => [Paint, number] | null
  ): void {
    const sx0 = Math.max(0, Math.floor(x0 * SS));
    const sx1 = Math.min(PX - 1, Math.ceil(x1 * SS));
    const sy0 = Math.max(0, Math.floor(y0 * SS));
    const sy1 = Math.min(PX - 1, Math.ceil(y1 * SS));
    for (let y = sy0; y <= sy1; y++) {
      for (let x = sx0; x <= sx1; x++) {
        const res = fn((x + 0.5) / SS, (y + 0.5) / SS);
        if (res) this.blend(x, y, res[0], res[1]);
      }
    }
  }

  poly(points: Pt[], color: Paint, alpha = 1): void {
    const pts = points.map(([x, y]) => [x * SS, y * SS] as Pt);
    let maxY = 0;
    for (const [, y] of pts) if (y > maxY) maxY = y;
    const yTop = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1]))));
    for (let y = yTop; y <= Math.min(PX - 1, Math.ceil(maxY)); y++) {
      const yc = y + 0.5;
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % pts.length];
        if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) {
          xs.push(x1 + ((yc - y1) * (x2 - x1)) / (y2 - y1));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = xs[i];
        const to = xs[i + 1];
        const lo = Math.max(0, Math.floor(from));
        const hi = Math.min(PX - 1, Math.ceil(to) - 1);
        for (let x = lo; x <= hi; x++) {
          const cov = Math.min(x + 1, to) - Math.max(x, from);
          if (cov > 0) this.blend(x, y, color, Math.min(1, cov) * alpha);
        }
      }
    }
  }

  rect(x: number, y: number, w: number, h: number, color: Paint, alpha = 1): void {
    this.poly(
      [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
      color,
      alpha
    );
  }

  roundRect(x: number, y: number, w: number, h: number, r: number, color: Paint, alpha = 1): void {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    this.poly(
      [
        [x + rr, y],
        [x + w - rr, y],
        [x + w, y + rr],
        [x + w, y + h - rr],
        [x + w - rr, y + h],
        [x + rr, y + h],
        [x, y + h - rr],
        [x, y + rr],
      ],
      color,
      alpha
    );
    for (const [cx, cy] of [
      [x + rr, y + rr],
      [x + w - rr, y + rr],
      [x + w - rr, y + h - rr],
      [x + rr, y + h - rr],
    ]) {
      this.ellipse(cx, cy, rr, rr, color, alpha);
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, color: Paint, alpha = 1, rot = 0): void {
    const outer = Math.max(rx, ry) + 1;
    this.fillBox(cx - outer, cy - outer, cx + outer, cy + outer, (x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      const u = (dx * Math.cos(rot) + dy * Math.sin(rot)) / rx;
      const v = (-dx * Math.sin(rot) + dy * Math.cos(rot)) / ry;
      const dist = Math.sqrt(u * u + v * v);
      if (dist > 1) return null;
      return [color, alpha * Math.min(1, (1 - dist) * Math.min(rx, ry) * SS + 0.5)] as [RGB, number];
    });
  }

  line(points: Pt[], width: number, color: Paint, alpha = 1): void {
    const half = width / 2;
    for (let i = 0; i + 1 < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[i + 1];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * half;
      const ny = (dx / len) * half;
      this.poly(
        [
          [x1 + nx, y1 + ny],
          [x2 + nx, y2 + ny],
          [x2 - nx, y2 - ny],
          [x1 - nx, y1 - ny],
        ],
        color,
        alpha
      );
    }
    for (const [x, y] of points) this.ellipse(x, y, half, half, color, alpha);
  }

  // ---- clip masks (design space)

  beginMask(): void {
    this.maskBuf.fill(0);
    this.mask = this.maskBuf;
  }
  endMask(): void {
    this.mask = null;
  }
  private mark(x: number, y: number): void {
    const mx = x | 0;
    const my = y | 0;
    if (mx >= 0 && my >= 0 && mx < SIZE && my < SIZE) this.maskBuf[my * SIZE + mx] = 1;
  }
  maskPoly(points: Pt[]): void {
    const yTop = Math.max(0, Math.floor(Math.min(...points.map((p) => p[1]))));
    const yBot = Math.min(SIZE - 1, Math.ceil(Math.max(...points.map((p) => p[1]))));
    for (let y = yTop; y <= yBot; y++) {
      const yc = y + 0.5;
      const xs: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % points.length];
        if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) {
          xs.push(x1 + ((yc - y1) * (x2 - x1)) / (y2 - y1));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.max(0, Math.floor(xs[i])); x <= Math.min(SIZE - 1, Math.ceil(xs[i + 1])); x++) {
          this.mark(x, y);
        }
      }
    }
  }
  maskEllipse(cx: number, cy: number, rx: number, ry: number): void {
    for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(SIZE - 1, Math.ceil(cy + ry)); y++) {
      for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(SIZE - 1, Math.ceil(cx + rx)); x++) {
        const u = (x + 0.5 - cx) / rx;
        const v = (y + 0.5 - cy) / ry;
        if (u * u + v * v <= 1) this.mark(x, y);
      }
    }
  }
  maskRoundRect(x: number, y: number, w: number, h: number, r: number): void {
    this.maskPoly([
      [x + r, y],
      [x + w - r, y],
      [x + w, y + r],
      [x + w, y + h - r],
      [x + w - r, y + h],
      [x + r, y + h],
      [x, y + h - r],
      [x, y + r],
    ]);
    this.maskEllipse(x + r, y + r, r, r);
    this.maskEllipse(x + w - r, y + r, r, r);
    this.maskEllipse(x + w - r, y + h - r, r, r);
    this.maskEllipse(x + r, y + h - r, r, r);
  }

  /**
   * Guards the whole pipeline: a single NaN pixel would silently be written to
   * the PNG as 0,0,0 by the clamp in toPng() and show up as a flat black or
   * fully-saturated patch, so fail loudly instead.
   */
  assertFinite(): void {
    for (let i = 0; i < this.data.length; i++) {
      if (!Number.isFinite(this.data[i])) {
        const px = Math.floor(i / 3);
        throw new Error(
          `non-finite channel at design (${Math.floor((px % PX) / SS)},${Math.floor(Math.floor(px / PX) / SS)}) channel ${i % 3}`
        );
      }
    }
  }

  toPng(): Buffer {
    const out = Buffer.alloc(SIZE * SIZE * 3);
    const area = SS * SS;
    const d = this.data;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let sy = 0; sy < SS; sy++) {
          const row = (y * SS + sy) * PX;
          for (let sx = 0; sx < SS; sx++) {
            const i = (row + x * SS + sx) * 3;
            r += d[i];
            g += d[i + 1];
            b += d[i + 2];
          }
        }
        const o = (y * SIZE + x) * 3;
        out[o] = clamp(r / area);
        out[o + 1] = clamp(g / area);
        out[o + 2] = clamp(b / area);
      }
    }
    return encodePng(SIZE, SIZE, out);
  }
}

// ------------------------------------------------------------- scene helpers

const BACKDROP_A = hex("#f6f3ef");
const BACKDROP_B = hex("#cbc4ba");
const BACKDROP_MID = mix(BACKDROP_A, BACKDROP_B, 0.5);
const CARD_DARK = hex("#6c6762");
const CARD_LIGHT = hex("#eae6e0");
const lum = (c: RGB): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * Tone of the display card the current product is shot on. Set once per product
 * from that product's own colour, so no product is ever rendered on a surface
 * that matches it (a cream blouse on a cream sweep is unreadable).
 */
let cardTone: RGB = CARD_LIGHT;

/** The studio backdrop is identical for every product: render it once. */
function renderBackdrop(): Raster {
  const r = new Raster();
  r.fillBox(0, 0, SIZE, SIZE, (x, y) => {
    const t = Math.min(1, Math.max(0, (y - 60) / 640));
    let color = mix(BACKDROP_A, BACKDROP_B, 0.22 + t * 0.6);
    const glow = Math.max(0, 1 - Math.hypot(x - 300, y - 240) / 640);
    color = mix(color, [255, 255, 255], glow * 0.55);
    return [color, 1];
  });
  return r;
}

function groundShadow(r: Raster, cx: number, cy: number, rx: number, ry: number, strength = 0.3): void {
  // a cast shadow is always darker than the surface it falls on
  const tone = shade(cardTone, -0.45);
  r.fillBox(cx - rx, cy - ry, cx + rx, cy + ry, (x, y) => {
    const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
    const a = Math.max(0, 1 - d) ** 1.6 * strength;
    return a > 0 ? ([tone, a] as [RGB, number]) : null;
  });
}

/**
 * Every product is shot on the same large studio card, in a tone picked from the
 * product's own brightness. This is what a real product photographer does, and
 * it guarantees the silhouette stays readable whatever the product colour is.
 */
function displayCard(r: Raster, tone: RGB): void {
  const cx = CX;
  const cy = 384;
  const hw = 292;
  const hh = 304;
  const radius = 36;
  const flat = mix(tone, BACKDROP_MID, 0.05);
  const sdf = (x: number, y: number): number => {
    const qx = Math.abs(x - cx) - (hw - radius);
    const qy = Math.abs(y - cy) - (hh - radius);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
  };
  // soft drop shadow on the sweep so the card reads as paper, not a pasted mask
  r.fillBox(cx - hw - 30, cy - hh - 30, cx + hw + 30, cy + hh + 30, (x, y) => {
    const d = sdf(x - 7, y - 13);
    const a = Math.max(0, Math.min(1, 0.5 - d / 26)) * 0.3;
    return a > 0 ? ([shade(BACKDROP_MID, -0.5), a] as [RGB, number]) : null;
  });
  r.fillBox(cx - hw - 4, cy - hh - 4, cx + hw + 4, cy + hh + 4, (x, y) => {
    const d = sdf(x + 4, y + 12);
    const cover = Math.max(0, Math.min(1, 0.5 - d));
    if (cover <= 0) return null;
    const lift = Math.max(0, 1 - Math.hypot(x - (cx - 90), y - (cy - 110)) / 700);
    const color = mix(mix(flat, shade(tone, -0.3), 0.3), shade(tone, 0.18), lift * 0.55);
    return [color, cover] as [RGB, number];
  });
}

/** Soft top-left key light plus a whisper of edge falloff. */
function lighting(r: Raster, strength = 0.5): void {
  r.fillBox(0, 0, SIZE, SIZE, (x, y) => {
    const light = Math.max(0, 1 - Math.hypot(x - 250, y - 170) / 720);
    const up = (light - 0.38) * strength;
    if (up > 0) return [[255, 255, 255], up] as [RGB, number];
    const down = (0.38 - light) * strength * 0.5;
    return down > 0 ? ([[70, 62, 56], down] as [RGB, number]) : null;
  });
}

// ------------------------------------------------------------------ patterns

type PatternKind = "solid" | "floral" | "stripe" | "plaid" | "textile" | "knit";

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paints the base colour then the print, always inside the current mask. */
function applyPattern(
  r: Raster,
  pattern: PatternKind,
  base: RGB,
  accent: RGB,
  seedNum: number
): void {
  r.fillBox(0, 0, SIZE, SIZE, () => [base, 1]);
  if (pattern === "solid") return;

  if (pattern === "stripe") {
    for (let i = 0; i < 8; i++) r.rect(0, 70 + i * 84, SIZE, 24, accent, i % 2 === 0 ? 0.9 : 0.45);
    return;
  }
  if (pattern === "plaid") {
    for (let i = 0; i < 6; i++) {
      r.rect(0, 80 + i * 96, SIZE, 28, accent, 0.6);
      r.rect(40 + i * 110, 0, 24, SIZE, accent, 0.5);
    }
    r.rect(0, 0, SIZE, SIZE, shade(base, -0.1), 0.22);
    return;
  }
  if (pattern === "knit") {
    for (let y = 96; y < 730; y += 12) {
      for (let x = 130; x < 660; x += 12) {
        const off = ((y / 12) % 2) * 6;
        r.line([[x + off, y], [x + off, y + 8]], 2.6, shade(base, 0.18), 0.55);
        r.line([[x + off, y], [x + off + 6, y]], 2, shade(base, -0.16), 0.4);
      }
    }
    return;
  }
  if (pattern === "textile") {
    for (let y = 100; y < 730; y += 7) {
      r.rect(130, y, 530, 1.6, shade(base, -0.22), 0.4);
      r.rect(130, y + 2.4, 530, 1.2, shade(base, 0.16), 0.35);
    }
    for (let y = 100; y < 730; y += 22) r.rect(130, y, 530, 1.4, shade(base, -0.14), 0.3);
    for (let x = 140; x < 660; x += 26) r.rect(x, 100, 1.4, 630, shade(base, 0.1), 0.22);
    return;
  }

  // floral — the print a shopper reads first: small scattered blossoms
  const rnd = mulberry(seedNum);
  for (let i = 0; i < 40; i++) {
    const cx = 140 + rnd() * 500;
    const cy = 90 + rnd() * 630;
    const sc = 0.8 + rnd() * 0.6;
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * Math.PI * 2 + rnd() * 0.3;
      r.ellipse(cx + Math.cos(a) * 8 * sc, cy + Math.sin(a) * 8 * sc, 6 * sc, 4.6 * sc, accent, 0.95, a);
    }
    r.ellipse(cx, cy, 4.2 * sc, 4.2 * sc, shade(accent, -0.28), 0.95);
    r.ellipse(cx + 15 * sc, cy + 11 * sc, 7.5 * sc, 4.2 * sc, hex("#71935b"), 0.85, 0.6);
  }
}

// ------------------------------------------------------------------ garments

type GarmentArt = {
  kind: "garment";
  form: "dress" | "top" | "outer" | "bottom" | "stack";
  color: string;
  accent: string;
  pattern: PatternKind;
  neck: "v" | "round" | "collar" | "scoop" | "boat" | "strap" | "high" | "notch";
  sleeve: "none" | "cap" | "short" | "flutter" | "threeQuarter" | "long" | "puff";
  closure: "none" | "buttons" | "zip" | "tie" | "pullover";
  hem: "hip" | "knee" | "midi" | "maxi" | "floor";
  flare: "straight" | "aline" | "wide" | "tapered";
  hood?: boolean;
  lapels?: boolean;
  pockets?: boolean;
  doubleBreasted?: boolean;
  belt?: boolean;
  strapCount?: number;
};

const CX = 384;
const SHOULDER_Y = 168;

function hemYOf(hem: GarmentArt["hem"]): number {
  return hem === "hip" ? 400 : hem === "knee" ? 560 : hem === "midi" ? 640 : 730;
}

function bodyPolygon(g: GarmentArt): Pt[] {
  const shoulderHalf = 118;
  const waistY = 372;
  const waistHalf = g.flare === "wide" ? 132 : 96;
  const hemY = hemYOf(g.hem);
  const hemHalf = g.flare === "aline" ? 188 : g.flare === "wide" ? 176 : g.flare === "tapered" ? 76 : 116;
  const neckDepth = g.neck === "v" ? 96 : g.neck === "scoop" ? 78 : g.neck === "boat" ? 44 : 58;
  const neckHalf = g.neck === "boat" ? 86 : g.neck === "strap" ? 58 : 46;
  return [
    [CX - shoulderHalf, SHOULDER_Y + 26],
    [CX - neckHalf, SHOULDER_Y],
    [CX - neckHalf * 0.5, SHOULDER_Y + neckDepth * 0.5],
    [CX, SHOULDER_Y + neckDepth],
    [CX + neckHalf * 0.5, SHOULDER_Y + neckDepth * 0.5],
    [CX + neckHalf, SHOULDER_Y],
    [CX + shoulderHalf, SHOULDER_Y + 26],
    [CX + waistHalf + 12, waistY],
    [CX + hemHalf, hemY],
    [CX, hemY + 10],
    [CX - hemHalf, hemY],
    [CX - waistHalf - 12, waistY],
  ];
}

const SLEEVE_SPEC = {
  none: null,
  cap: { drop: 58, out: 46, flare: 8 },
  short: { drop: 112, out: 50, flare: 14 },
  flutter: { drop: 126, out: 88, flare: 78 },
  threeQuarter: { drop: 214, out: 48, flare: 10 },
  long: { drop: 320, out: 44, flare: 6 },
  puff: { drop: 136, out: 64, flare: 32 },
} as const;

function sleevePolygon(g: GarmentArt, side: -1 | 1): Pt[] | null {
  const spec = SLEEVE_SPEC[g.sleeve];
  if (!spec) return null;
  const shoulderX = CX + side * 118;
  const inner = shoulderX - side * 46;
  const outerX = shoulderX + side * spec.out;
  return [
    [shoulderX - side * 4, SHOULDER_Y + 8],
    [outerX, SHOULDER_Y + 46 + spec.drop * 0.12],
    [outerX - side * spec.flare, SHOULDER_Y + 52 + spec.drop],
    [inner - side * spec.flare * 0.6, SHOULDER_Y + 44 + spec.drop],
    [inner, SHOULDER_Y + 40],
  ];
}

function necklineCut(g: GarmentArt): Pt[] {
  const y = SHOULDER_Y - 2;
  const table: Record<GarmentArt["neck"], Pt[]> = {
    v: [
      [CX - 46, y], [CX + 46, y], [CX + 30, y + 60], [CX, y + 100], [CX - 30, y + 60],
    ],
    scoop: [
      [CX - 50, y], [CX + 50, y], [CX + 34, y + 70], [CX, y + 84], [CX - 34, y + 70],
    ],
    round: [
      [CX - 46, y], [CX + 46, y], [CX + 30, y + 40], [CX, y + 60], [CX - 30, y + 40],
    ],
    high: [
      [CX - 46, y], [CX + 46, y], [CX + 36, y + 40], [CX, y + 52], [CX - 36, y + 40],
    ],
    boat: [
      [CX - 86, y], [CX + 86, y], [CX + 70, y + 30], [CX, y + 42], [CX - 70, y + 30],
    ],
    notch: [
      [CX - 62, y - 2], [CX - 20, y + 72], [CX + 20, y + 72], [CX + 62, y - 2],
      [CX + 40, y - 8], [CX, y + 40], [CX - 40, y - 8],
    ],
    collar: [
      [CX - 30, y], [CX + 30, y], [CX + 20, y + 40], [CX, y + 50], [CX - 20, y + 40],
    ],
    strap: [
      [CX - 40, y], [CX + 40, y], [CX + 30, y + 34], [CX, y + 44], [CX - 30, y + 34],
    ],
  };
  return table[g.neck];
}

function drawGarment(r: Raster, g: GarmentArt, seedNum: number): void {
  const base = hex(g.color);
  const accent = hex(g.accent);
  const hemY = hemYOf(g.hem);

  if (g.form === "stack") {
    // three folded t-shirts, fanned out
    const cols = ["#33405c", "#f2f1ee", "#8d97a4"];
    for (let i = 0; i < 3; i++) {
      const y = 268 + i * 116;
      const off = (i - 1) * 30;
      const c = hex(cols[i]);
      groundShadow(r, CX + off, y + 214, 200, 34, 0.2);
      r.poly(
        [
          [CX - 205 + off, y + 30],
          [CX - 118 + off, y - 40],
          [CX + 118 + off, y - 40],
          [CX + 205 + off, y + 30],
          [CX + 205 + off, y + 190],
          [CX - 205 + off, y + 190],
        ],
        c
      );
      r.ellipse(CX + off, y - 22, 76, 32, shade(c, -0.22), 1);
      r.ellipse(CX + off, y - 16, 64, 22, mix(c, cardTone, 0.45), 0.5);
      r.rect(CX - 205 + off, y + 168, 410, 24, shade(c, -0.14), 0.55);
      r.line(
        [
          [CX - 118 + off, y - 38],
          [CX + 118 + off, y - 38],
        ],
        4,
        shade(c, 0.2),
        0.5
      );
    }
    lighting(r, 0.42);
    return;
  }

  const body = bodyPolygon(g);
  groundShadow(r, CX, hemY + 22, 224, 36, 0.3);

  r.beginMask();
  r.maskPoly(body);
  for (const side of [-1, 1] as const) {
    const sleeve = sleevePolygon(g, side);
    if (sleeve) r.maskPoly(sleeve);
  }
  applyPattern(r, g.pattern, base, accent, seedNum);
  // cloth shading: darker towards the sides, faint highlight down the middle
  r.fillBox(0, 0, SIZE, SIZE, (x, y) => {
    const side = Math.max(0, Math.abs(x - CX) / 300 - 0.35) * 0.5;
    const top = Math.max(0, 0.2 - (y - SHOULDER_Y) / 2600);
    if (side <= 0 && top <= 0) return null;
    return side > top
      ? ([[40, 34, 30], side] as [RGB, number])
      : ([[255, 255, 255], top] as [RGB, number]);
  });
  r.endMask();

  r.poly(necklineCut(g), cardTone);

  if (g.neck === "strap" || (g.form === "dress" && g.neck !== "high")) {
    const count = g.strapCount ?? 2;
    for (let i = 0; i < count; i++) {
      const x = CX + (count === 1 ? 0 : i === 0 ? -58 : 58);
      const lean = i === 0 ? -8 : 8;
      r.line([[x, SHOULDER_Y - 4], [x + lean, SHOULDER_Y + 98]], 13, base);
      r.line([[x, SHOULDER_Y - 4], [x + lean, SHOULDER_Y + 98]], 4, shade(base, 0.2), 0.45);
    }
  }

  if (g.neck === "collar" || g.lapels) {
    for (const side of [-1, 1] as const) {
      r.poly(
        [
          [CX + side * 14, SHOULDER_Y + 28],
          [CX + side * 94, SHOULDER_Y + 6],
          [CX + side * 72, SHOULDER_Y + 120],
          [CX + side * 8, SHOULDER_Y + 80],
        ],
        shade(base, side < 0 ? 0.12 : 0.04)
      );
      r.line(
        [
          [CX + side * 14, SHOULDER_Y + 28],
          [CX + side * 8, SHOULDER_Y + 80],
        ],
        3,
        shade(base, -0.3),
        0.5
      );
    }
  }

  if (g.hood) {
    r.poly(
      [
        [CX - 98, SHOULDER_Y + 32],
        [CX - 32, SHOULDER_Y - 46],
        [CX + 32, SHOULDER_Y - 46],
        [CX + 98, SHOULDER_Y + 32],
        [CX + 62, SHOULDER_Y + 96],
        [CX - 62, SHOULDER_Y + 96],
      ],
      shade(base, -0.12)
    );
    r.ellipse(CX, SHOULDER_Y + 36, 64, 42, shade(base, -0.32), 0.9);
  }

  if (g.closure === "buttons") {
    const from = SHOULDER_Y + 100;
    const to = g.form === "bottom" ? 372 : hemY - 26;
    for (let y = from; y < to; y += 54) {
      r.ellipse(CX, y, 9, 9, "#f7f5f0", 1);
      r.ellipse(CX, y, 6.6, 6.6, shade(base, -0.45), 0.9);
      r.ellipse(CX - 2, y - 2, 2.2, 2.2, "#ffffff", 0.75);
    }
    r.line([[CX, from - 24], [CX, to]], 2.6, shade(base, -0.28), 0.4);
  }
  if (g.closure === "zip") {
    r.rect(CX - 3, SHOULDER_Y + 64, 6, hemY - SHOULDER_Y - 96, "#d2d6d9", 0.95);
    r.rect(CX - 3, SHOULDER_Y + 64, 2, hemY - SHOULDER_Y - 96, "#93999d", 0.9);
    r.roundRect(CX - 9, SHOULDER_Y + 56, 18, 26, 5, "#bcc1c5");
  }
  if (g.closure === "tie" || g.belt) {
    const wy = 372;
    r.rect(CX - 116, wy - 17, 232, 32, shade(base, -0.18), 1);
    r.poly(
      [[CX + 4, wy + 6], [CX + 76, wy + 14], [CX + 60, wy + 124], [CX - 6, wy + 102]],
      shade(base, -0.22)
    );
    r.poly(
      [[CX - 4, wy + 6], [CX - 66, wy + 16], [CX - 56, wy + 106], [CX + 2, wy + 98]],
      shade(base, -0.1)
    );
  }

  if (g.pockets) {
    for (const side of [-1, 1] as const) {
      r.roundRect(CX + side * 70 - 46, 432, 92, 84, 10, shade(base, -0.14), 0.9);
      r.line(
        [
          [CX + side * 70 - 46, 436],
          [CX + side * 70 + 46, 436],
        ],
        3,
        shade(base, -0.32),
        0.6
      );
    }
  }
  if (g.form === "outer" && !g.pockets) {
    for (const side of [-1, 1] as const) {
      r.line([[CX + side * 42, 470], [CX + side * 46, 502]], 5, shade(base, -0.32), 0.5);
    }
  }
  if (g.doubleBreasted) {
    for (let y = 336; y < 430; y += 46) {
      r.ellipse(CX - 28, y, 9, 9, shade(base, -0.52), 0.95);
      r.ellipse(CX + 28, y, 9, 9, shade(base, -0.52), 0.95);
    }
  }
  if (g.flare === "aline" || g.flare === "wide") {
    const half = g.flare === "wide" ? 176 : 188;
    r.line([[CX - half, hemY], [CX + half, hemY]], 5, shade(base, -0.3), 0.5);
  }

  lighting(r, 0.45);
}

// ------------------------------------------------------------------ devices

type DeviceArt = {
  kind: "device";
  device:
    | "earbuds"
    | "watch"
    | "speaker"
    | "powerbank"
    | "tvstick"
    | "keyboard"
    | "router"
    | "lamp"
    | "microphone"
    | "projector";
  color: string;
  accent: string;
};

function drawDevice(r: Raster, d: DeviceArt): void {
  const body = hex(d.color);
  const accent = hex(d.accent);
  const metal = hex("#cfd4d8");

  switch (d.device) {
    case "earbuds": {
      groundShadow(r, CX, 600, 200, 32, 0.3);
      r.roundRect(CX - 150, 380, 300, 192, 46, body);
      r.roundRect(CX - 150, 372, 300, 62, 31, shade(body, 0.1));
      r.line([[CX - 150, 470], [CX + 150, 470]], 3, shade(body, -0.3), 0.7);
      r.ellipse(CX, 556, 26, 9, shade(body, -0.42), 0.85);
      for (const side of [-1, 1] as const) {
        const bx = CX + side * 78;
        r.ellipse(bx, 300, 40, 46, shade(body, 0.06));
        r.ellipse(bx, 266, 30, 20, shade(body, -0.22));
        r.roundRect(bx - 15, 316, 30, 94, 15, shade(body, -0.04));
        r.ellipse(bx, 336, 12, 12, shade(body, -0.38), 0.9);
        r.ellipse(bx - side * 22, 286, 10, 10, accent, 1);
      }
      break;
    }
    case "watch": {
      groundShadow(r, CX, 660, 150, 24, 0.26);
      r.roundRect(CX - 86, 150, 172, 474, 66, body);
      r.roundRect(CX - 86, 150, 172, 200, 66, shade(body, 0.07));
      for (let y = 180; y < 612; y += 14) r.rect(CX - 78, y, 156, 5, shade(body, -0.22), 0.45);
      r.roundRect(CX - 120, 300, 240, 250, 52, "#15181c");
      r.roundRect(CX - 112, 308, 224, 234, 46, "#0b0e12");
      r.roundRect(CX - 100, 320, 200, 118, 30, accent, 0.9);
      r.ellipse(CX, 470, 66, 46, shade(accent, -0.4), 0.95);
      r.ellipse(CX, 470, 52, 34, accent, 0.85);
      r.rect(CX - 150, 396, 22, 44, metal, 0.95);
      r.ellipse(CX - 122, 404, 13, 13, metal, 1);
      break;
    }
    case "speaker": {
      groundShadow(r, CX, 620, 186, 38, 0.32);
      r.roundRect(CX - 170, 220, 340, 382, 46, body);
      r.ellipse(CX, 226, 168, 44, shade(body, 0.14));
      r.ellipse(CX, 226, 140, 32, shade(body, -0.24));
      r.rect(CX - 170, 262, 340, 300, shade(body, -0.3), 1);
      for (let y = 274; y < 556; y += 12) {
        for (let x = CX - 156; x < CX + 156; x += 12) r.ellipse(x, y, 4, 4, shade(body, 0.02), 0.65);
      }
      r.ellipse(CX, 226, 40, 12, accent, 0.9);
      r.rect(CX - 60, 570, 120, 12, metal, 0.8);
      break;
    }
    case "powerbank": {
      groundShadow(r, CX, 620, 186, 30, 0.3);
      r.roundRect(CX - 150, 230, 300, 360, 30, body);
      r.roundRect(CX - 138, 244, 276, 332, 24, shade(body, 0.08));
      for (let i = 0; i < 4; i++) {
        r.roundRect(CX - 108 + i * 46, 292, 30, 14, 7, i < 3 ? accent : shade(body, -0.4));
      }
      r.roundRect(CX - 60, 480, 120, 30, 12, "#1b1e22", 1);
      r.roundRect(CX - 52, 488, 104, 14, 7, "#0c0e10", 1);
      r.roundRect(CX + 96, 470, 34, 48, 8, "#1b1e22", 1);
      break;
    }
    case "tvstick": {
      groundShadow(r, CX, 600, 196, 28, 0.3);
      r.roundRect(CX - 190, 280, 380, 130, 34, body);
      r.roundRect(CX - 176, 296, 352, 58, 22, shade(body, 0.12));
      r.ellipse(CX - 120, 372, 12, 12, accent, 1);
      r.roundRect(CX + 90, 330, 66, 46, 10, "#0d0f12");
      r.rect(CX + 100, 340, 46, 8, "#2a2f36", 1);
      r.roundRect(CX - 40, 470, 200, 262, 40, body);
      for (let i = 0; i < 4; i++) r.roundRect(CX - 16, 500 + i * 46, 152, 28, 12, shade(body, -0.2));
      r.ellipse(CX + 60, 690, 40, 18, "#0d0f12", 1);
      r.ellipse(CX + 60, 690, 26, 11, accent, 0.75);
      break;
    }
    case "keyboard": {
      groundShadow(r, CX, 556, 250, 32, 0.3);
      r.roundRect(CX - 280, 300, 560, 220, 22, body);
      r.roundRect(CX - 268, 314, 536, 176, 16, shade(body, -0.06));
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 14; col++) {
          const x = CX - 258 + col * 38 + (row === 0 ? 12 : 0);
          const y = 330 + row * 42;
          r.roundRect(x, y, 30, 30, 7, shade(body, 0.24));
          r.roundRect(x, y, 30, 8, 4, shade(body, 0.34), 0.7);
        }
      }
      r.rect(CX - 262, 498, 250, 12, accent, 0.85);
      r.roundRect(CX + 150, 490, 90, 26, 8, shade(body, 0.18));
      break;
    }
    case "router": {
      groundShadow(r, CX, 590, 196, 30, 0.3);
      for (const side of [-1, 1] as const) {
        r.roundRect(CX + side * 92 - 12, 132, 24, 254, 12, shade(body, -0.14));
        r.roundRect(CX + side * 152 - 12, 172, 24, 214, 12, shade(body, -0.14));
      }
      r.roundRect(CX - 190, 380, 380, 170, 30, body);
      r.rect(CX - 176, 396, 352, 40, shade(body, 0.12), 1);
      for (let i = 0; i < 5; i++) {
        r.ellipse(CX - 60 + i * 30, 480, 8, 8, i < 4 ? accent : shade(body, -0.32), 0.95);
      }
      break;
    }
    case "lamp": {
      groundShadow(r, CX, 656, 190, 28, 0.3);
      r.ellipse(CX, 640, 130, 30, shade(body, -0.22));
      r.ellipse(CX, 630, 118, 24, body);
      r.rect(CX - 12, 300, 24, 336, metal);
      r.rect(CX - 7, 306, 6, 326, "#eef1f3", 0.6);
      r.poly([[CX - 132, 302], [CX + 132, 302], [CX + 94, 176], [CX - 94, 176]], shade(body, -0.06));
      r.poly([[CX - 132, 302], [CX + 132, 302], [CX + 102, 232], [CX - 102, 232]], shade(accent, 0.2), 0.85);
      r.ellipse(CX, 302, 130, 22, shade(accent, 0.45), 0.95);
      r.fillBox(CX - 220, 180, CX + 220, 560, (x, y) => {
        const d = Math.hypot((x - CX) / 210, (y - 340) / 190);
        const a = Math.max(0, 1 - d) * 0.3;
        return a > 0 ? ([shade(accent, 0.5), a] as [RGB, number]) : null;
      });
      break;
    }
    case "microphone": {
      groundShadow(r, CX, 650, 156, 28, 0.3);
      r.roundRect(CX - 120, 610, 240, 30, 14, shade(body, -0.22));
      r.roundRect(CX - 90, 556, 180, 58, 16, body);
      r.rect(CX - 16, 330, 32, 234, metal);
      r.roundRect(CX - 96, 190, 192, 200, 60, body);
      for (let y = 202; y < 384; y += 11) {
        for (let x = CX - 82; x < CX + 82; x += 11) r.ellipse(x, y, 3.4, 3.4, shade(body, -0.5), 0.6);
      }
      r.rect(CX - 100, 300, 200, 12, accent, 0.9);
      r.ellipse(CX + 54, 596, 12, 12, accent, 1);
      break;
    }
    case "projector": {
      groundShadow(r, CX, 570, 196, 32, 0.3);
      r.roundRect(CX - 200, 280, 400, 260, 36, body);
      r.roundRect(CX - 186, 296, 372, 120, 24, shade(body, 0.08));
      r.ellipse(CX + 90, 440, 84, 84, "#1c2026");
      r.ellipse(CX + 90, 440, 66, 66, "#0a0d11");
      r.ellipse(CX + 90, 440, 40, 40, shade(accent, -0.55), 0.95);
      r.ellipse(CX + 74, 424, 16, 16, "#ffffff", 0.5);
      for (let y = 320; y < 420; y += 14) r.rect(CX - 168, y, 110, 6, shade(body, -0.3), 0.5);
      r.ellipse(CX - 110, 470, 16, 16, accent, 0.95);
      r.rect(CX - 160, 500, 320, 16, shade(body, -0.22), 0.8);
      break;
    }
  }
  lighting(r, 0.42);
}

// ----------------------------------------------------------------- jewellery

type JewelryArt = {
  kind: "jewelry";
  piece:
    | "necklace"
    | "crescent"
    | "sapphire"
    | "earrings"
    | "bangles"
    | "bracelet"
    | "onyx"
    | "rings"
    | "hoops"
    | "studs"
    | "anklet"
    | "tennis";
  metal: string;
  gem: string;
};

function chainCurve(cx: number, top: number, spread: number, depth: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= 32; i++) {
    const t = i / 32;
    pts.push([cx - spread + 2 * spread * t, top + depth * Math.sin(Math.PI * t) ** 0.85]);
  }
  return pts;
}

function drawJewelry(r: Raster, j: JewelryArt): void {
  const m = hex(j.metal);
  const gem = hex(j.gem);
  const hi = shade(m, 0.45);
  const lo = shade(m, -0.35);
  const backdropHole = cardTone;

  const links = (pts: Pt[], width: number): void => {
    r.line(pts, width, m, 0.95);
    r.line(pts.map(([x, y]) => [x + 2, y - 2] as Pt), width * 0.3, hi, 0.5);
  };

  switch (j.piece) {
    case "necklace":
    case "crescent": {
      links(chainCurve(CX, 150, 176, 250), 9);
      if (j.piece === "crescent") {
        r.ellipse(CX, 470, 78, 78, m);
        r.ellipse(CX + 30, 456, 66, 66, backdropHole);
        r.ellipse(CX - 26, 428, 26, 20, hi, 0.6);
        r.ellipse(CX, 396, 16, 14, shade(m, 0.1));
      } else {
        r.ellipse(CX, 460, 54, 60, gem);
        r.ellipse(CX, 460, 54, 60, shade(gem, 0.2), 0.5);
        r.ellipse(CX - 14, 434, 16, 20, "#ffffff", 0.5);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          r.ellipse(CX + Math.cos(a) * 30, 460 + Math.sin(a) * 32, 6, 6, hi, 0.8);
        }
      }
      break;
    }
    case "sapphire": {
      links(chainCurve(CX, 150, 180, 260), 9);
      r.poly([[CX - 44, 400], [CX + 44, 400], [CX + 30, 470], [CX, 512], [CX - 30, 470]], gem);
      r.poly(
        [[CX - 30, 414], [CX + 30, 414], [CX + 16, 466], [CX, 494], [CX - 16, 466]],
        shade(gem, 0.28),
        0.7
      );
      r.ellipse(CX - 14, 428, 12, 16, "#ffffff", 0.45);
      r.ellipse(CX, 402, 46, 14, shade(m, 0.2));
      break;
    }
    case "earrings": {
      for (const side of [-1, 1] as const) {
        const x = CX + side * 108;
        r.ellipse(x, 226, 26, 26, m);
        r.ellipse(x, 226, 14, 14, backdropHole, 0.9);
        r.line([[x, 246], [x, 296]], 7, m);
        r.ellipse(x, 350, 62, 74, gem);
        r.ellipse(x - 16, 318, 18, 24, "#ffffff", 0.55);
        r.ellipse(x + 20, 386, 20, 26, shade(gem, -0.2), 0.6);
        r.ellipse(x, 418, 30, 12, shade(m, 0.15));
      }
      break;
    }
    case "bangles": {
      for (let i = 0; i < 3; i++) {
        const ry = 470 + i * 44;
        const s = 1 - i * 0.07;
        r.ellipse(CX, ry, 170 * s, 52 * s, shade(m, -0.12));
        r.ellipse(CX, ry - 8, 170 * s, 52 * s, m);
        r.ellipse(CX, ry - 8, 138 * s, 34 * s, backdropHole);
        r.ellipse(CX - 60 * s, ry - 20, 40, 12, hi, 0.5);
      }
      break;
    }
    case "bracelet":
    case "tennis": {
      const isTennis = j.piece === "tennis";
      const n = isTennis ? 13 : 11;
      for (let i = 0; i < n; i++) {
        const x = CX - 190 + i * (380 / (n - 1));
        const y = 420 + Math.sin((i / (n - 1)) * Math.PI) * 26;
        if (isTennis) {
          r.roundRect(x - 15, y - 20, 30, 40, 8, shade(m, 0.1));
          r.roundRect(x - 11, y - 16, 22, 32, 5, "#f7fbff", 0.95);
          r.ellipse(x - 5, y - 8, 5, 6, "#ffffff", 0.9);
        } else {
          r.ellipse(x, y, 21, 21, m);
          r.ellipse(x, y, 15, 15, shade(m, 0.2));
        }
      }
      r.line([[CX - 200, 452], [CX + 200, 452]], 8, m, 0.9);
      r.ellipse(CX + 196, 420, 20, 24, lo, 0.6);
      break;
    }
    case "onyx": {
      const beads = 11;
      for (let i = 0; i < beads; i++) {
        const x = CX - 190 + i * (380 / (beads - 1));
        const y = 420 + Math.sin((i / (beads - 1)) * Math.PI) * 24;
        r.ellipse(x, y, 26, 26, "#1b1d21");
        r.ellipse(x - 7, y - 8, 9, 8, "#6d737c", 0.7);
        r.ellipse(x + 8, y + 9, 12, 10, "#0a0b0d", 0.6);
      }
      r.line([[CX - 200, 452], [CX + 200, 452]], 6, "#26292e", 0.85);
      break;
    }
    case "rings": {
      for (let i = 0; i < 3; i++) {
        const x = CX - 130 + i * 130;
        r.ellipse(x, 430, 76, 76, shade(m, -0.12));
        r.ellipse(x, 430, 76, 76, m);
        r.ellipse(x, 430, 52, 52, backdropHole);
        r.ellipse(x - 30, 402, 24, 12, hi, 0.6);
        r.ellipse(x, 348, 22, 18, shade(m, 0.15));
      }
      break;
    }
    case "hoops": {
      for (const side of [-1, 1] as const) {
        const x = CX + side * 106;
        r.ellipse(x, 400, 104, 104, m);
        r.ellipse(x, 400, 74, 74, backdropHole);
        r.ellipse(x - 34, 366, 30, 14, hi, 0.55);
      }
      break;
    }
    case "studs": {
      for (const side of [-1, 1] as const) {
        const x = CX + side * 108;
        r.ellipse(x, 420, 74, 74, m);
        r.ellipse(x, 420, 56, 56, gem);
        r.ellipse(x - 18, 396, 18, 14, "#ffffff", 0.6);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          r.ellipse(x + Math.cos(a) * 40, 420 + Math.sin(a) * 40, 5, 5, hi, 0.7);
        }
      }
      break;
    }
    case "anklet": {
      links(chainCurve(CX, 330, 190, 150), 8);
      r.ellipse(CX + 6, 452, 30, 22, shade(m, 0.05));
      r.ellipse(CX + 6, 452, 16, 10, lo, 0.8);
      r.ellipse(CX - 30, 470, 10, 8, hi, 0.6);
      break;
    }
  }
  lighting(r, 0.4);
}

// ------------------------------------------------------------- the catalogue

type Art = GarmentArt | DeviceArt | JewelryArt;

const C = {
  white: "#f4f1ec",
  cream: "#efe4cf",
  ivory: "#f7f2e6",
  navy: "#2c3a52",
  denim: "#6d8bb0",
  indigo: "#3d5273",
  olive: "#5d6b4b",
  khaki: "#c2ad86",
  heather: "#a8adb5",
  gold: "#d9a94a",
  silver: "#cfd4d8",
};

function artFor(name: string): Art {
  const table: Record<string, Art> = {
    // ---- Electronics
    "Nova Wireless Earbuds": { kind: "device", device: "earbuds", color: "#f3f3f1", accent: "#4aa3df" },
    "Pulse Smart Watch Pro": { kind: "device", device: "watch", color: "#2f3641", accent: "#31c48d" },
    "Sona Bluetooth Speaker": { kind: "device", device: "speaker", color: "#5b6068", accent: "#7fd3f0" },
    "Volt 10000mAh Power Bank": { kind: "device", device: "powerbank", color: "#23262b", accent: "#5fd08a" },
    "Vision 4K TV Stick": { kind: "device", device: "tvstick", color: "#1c1f25", accent: "#4aa3df" },
    "Orbit Wireless Keyboard": { kind: "device", device: "keyboard", color: "#3a3f47", accent: "#6fd0e8" },
    "EchoMesh Wi-Fi Router": { kind: "device", device: "router", color: "#eceae6", accent: "#5fd08a" },
    "Aurora LED Desk Lamp": { kind: "device", device: "lamp", color: "#e8e2d8", accent: "#ffd88a" },
    "SoundWave USB Microphone": { kind: "device", device: "microphone", color: "#33373d", accent: "#7fd3f0" },
    "Nimbus Mini Projector": { kind: "device", device: "projector", color: "#e6e4e0", accent: "#4aa3df" },

    // ---- Jewelry
    "Silver Crescent Necklace": { kind: "jewelry", piece: "crescent", metal: C.silver, gem: "#e8eef2" },
    "Pearl Drop Earrings": { kind: "jewelry", piece: "earrings", metal: C.silver, gem: "#f6f1e7" },
    "Gold-Plated Bangle Set": { kind: "jewelry", piece: "bangles", metal: C.gold, gem: "#f3dd9a" },
    "Onyx Bead Bracelet": { kind: "jewelry", piece: "onyx", metal: C.silver, gem: "#15171a" },
    "Sapphire Pendant Necklace": { kind: "jewelry", piece: "sapphire", metal: C.silver, gem: "#1f4fa8" },
    "Minimal Hoop Earrings": { kind: "jewelry", piece: "hoops", metal: C.silver, gem: "#e8eef2" },
    "Rose Gold Ring Set": { kind: "jewelry", piece: "rings", metal: "#dda08c", gem: "#f2cdc2" },
    "Turquoise Stud Earrings": { kind: "jewelry", piece: "studs", metal: C.silver, gem: "#3fb3ad" },
    "Twisted Knot Anklet": { kind: "jewelry", piece: "anklet", metal: C.silver, gem: "#e8eef2" },
    "Diamond-Cut Tennis Bracelet": { kind: "jewelry", piece: "tennis", metal: C.silver, gem: "#f7fbff" },

    // ---- Men's Clothing
    "Classic Oxford Shirt": {
      kind: "garment", form: "top", color: "#bcd2e6", accent: "#8fa9c2", pattern: "solid",
      neck: "collar", sleeve: "long", closure: "buttons", hem: "hip", flare: "straight",
    },
    "Slim Denim Jeans": {
      kind: "garment", form: "bottom", color: C.indigo, accent: "#2c3d59", pattern: "textile",
      neck: "high", sleeve: "none", closure: "zip", hem: "knee", flare: "tapered", pockets: true,
    },
    "Merino Crew Sweater": {
      kind: "garment", form: "top", color: C.heather, accent: "#8d939c", pattern: "knit",
      neck: "round", sleeve: "long", closure: "pullover", hem: "hip", flare: "straight",
    },
    "Everyday Chino Pants": {
      kind: "garment", form: "bottom", color: C.khaki, accent: "#a89573", pattern: "textile",
      neck: "high", sleeve: "none", closure: "zip", hem: "knee", flare: "tapered", pockets: true,
    },
    "Lightweight Bomber Jacket": {
      kind: "garment", form: "outer", color: C.olive, accent: "#48553a", pattern: "textile",
      neck: "high", sleeve: "long", closure: "zip", hem: "hip", flare: "straight", pockets: true,
    },
    "Cotton Crew T-Shirt 3-Pack": {
      kind: "garment", form: "stack", color: C.navy, accent: C.white, pattern: "solid",
      neck: "round", sleeve: "short", closure: "pullover", hem: "hip", flare: "straight",
    },
    "Tailored Navy Blazer": {
      kind: "garment", form: "outer", color: C.navy, accent: "#22304a", pattern: "solid",
      neck: "notch", sleeve: "long", closure: "buttons", hem: "knee", flare: "straight",
      lapels: true, doubleBreasted: true, pockets: true,
    },
    "Fleece Hoodie": {
      kind: "garment", form: "outer", color: "#3a3d44", accent: "#2c2f35", pattern: "textile",
      neck: "round", sleeve: "long", closure: "pullover", hem: "hip", flare: "straight",
      hood: true, pockets: true,
    },
    "Linen Summer Shirt": {
      kind: "garment", form: "top", color: C.cream, accent: "#ddcdae", pattern: "textile",
      neck: "collar", sleeve: "long", closure: "buttons", hem: "hip", flare: "straight", pockets: true,
    },
    "Jogger Sweatpants": {
      kind: "garment", form: "bottom", color: "#4a4e56", accent: "#3a3d44", pattern: "knit",
      neck: "high", sleeve: "none", closure: "pullover", hem: "knee", flare: "tapered",
    },

    // ---- Women's Clothing
    "Floral Wrap Dress": {
      kind: "garment", form: "dress", color: C.white, accent: "#d1618a", pattern: "floral",
      neck: "v", sleeve: "flutter", closure: "tie", hem: "knee", flare: "aline",
      belt: true, pockets: true,
    },
    "High-Rise Leggings": {
      kind: "garment", form: "bottom", color: "#26282d", accent: "#3a3d44", pattern: "solid",
      neck: "high", sleeve: "none", closure: "none", hem: "knee", flare: "tapered",
    },
    "Silk Blouse": {
      kind: "garment", form: "top", color: "#e8dcc9", accent: "#d3c3a9", pattern: "solid",
      neck: "round", sleeve: "long", closure: "buttons", hem: "hip", flare: "straight",
    },
    "A-Line Floral Skirt": {
      kind: "garment", form: "dress", color: C.ivory, accent: "#6f9ab8", pattern: "floral",
      neck: "high", sleeve: "none", closure: "zip", hem: "midi", flare: "aline",
    },
    "Wool Tailored Coat": {
      kind: "garment", form: "outer", color: "#b08b62", accent: "#8d6c48", pattern: "textile",
      neck: "notch", sleeve: "long", closure: "buttons", hem: "maxi", flare: "straight",
      lapels: true, doubleBreasted: true, pockets: true,
    },
    "Ribbed Knit Top": {
      kind: "garment", form: "top", color: "#d8a7a7", accent: "#c48f8f", pattern: "knit",
      neck: "boat", sleeve: "long", closure: "pullover", hem: "hip", flare: "straight",
    },
    "Wide-Leg Trousers": {
      kind: "garment", form: "bottom", color: C.cream, accent: "#ddcdae", pattern: "solid",
      neck: "high", sleeve: "none", closure: "zip", hem: "midi", flare: "wide",
    },
    "Denim Jacket": {
      kind: "garment", form: "outer", color: C.denim, accent: "#57749b", pattern: "textile",
      neck: "collar", sleeve: "long", closure: "buttons", hem: "hip", flare: "straight", pockets: true,
    },
    "Maxi Sundress": {
      kind: "garment", form: "dress", color: "#e9f2f0", accent: "#4f9c96", pattern: "stripe",
      neck: "scoop", sleeve: "cap", closure: "none", hem: "maxi", flare: "aline", strapCount: 2,
    },
    "Cashmere Cardigan": {
      kind: "garment", form: "outer", color: "#d9c9ad", accent: "#c0ab8c", pattern: "knit",
      neck: "round", sleeve: "long", closure: "buttons", hem: "knee", flare: "aline", pockets: true,
    },
  };
  return table[name];
}

const raster = new Raster();
const backdropTemplate = renderBackdrop();

/** Colour the product is mostly made of — decides the card tone. */
function primaryColor(art: Art): RGB {
  if (art.kind === "garment") return hex(art.color);
  if (art.kind === "device") return hex(art.color);
  return mix(hex(art.metal), hex(art.gem), 0.35);
}

async function main(): Promise<void> {
  const outDir = path.resolve(process.cwd(), "public/images/products");
  await fs.mkdir(outDir, { recursive: true });

  let written = 0;
  let index = 0;
  for (const product of SEED_PRODUCTS) {
    index += 1;
    const art = artFor(product.name);
    if (!art) {
      console.warn(`[images] no art spec for "${product.name}" — skipped`);
      continue;
    }
    raster.reset();
    raster.copyFrom(backdropTemplate);
    cardTone = lum(primaryColor(art)) >= 150 ? CARD_DARK : CARD_LIGHT;
    displayCard(raster, cardTone);
    if (art.kind === "garment") drawGarment(raster, art, index * 977);
    else if (art.kind === "device") drawDevice(raster, art);
    else drawJewelry(raster, art);
    raster.assertFinite();

    await fs.writeFile(path.join(outDir, productImageFile(product.name)), raster.toPng());
    written += 1;
  }
  console.log(`[images] wrote ${written} product images to ${outDir}`);
  if (written !== SEED_PRODUCTS.length) {
    console.warn(`[images] WARNING: ${SEED_PRODUCTS.length - written} product(s) have no image`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
