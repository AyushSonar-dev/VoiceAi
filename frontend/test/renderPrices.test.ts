/**
 * Renders the real price-bearing components with the exact currency string the
 * backend sends ("₹") and asserts the HTML contains rupee amounts, not a code
 * and not a crash. This is the check that the reported RangeError is gone at the
 * component level, not just in the helper.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, default as React } from "react";
import type { RecentProduct } from "../src/types.js";

/*
 * tsconfig sets `"jsx": "preserve"` for Next's compiler, so this runner lowers
 * JSX with the classic transform and the components look for a global `React`.
 * Publishing it before they are loaded keeps the project config untouched.
 */
(globalThis as unknown as { React: unknown }).React = React;

/** The literal value from GET /api/capabilities. */
const CURRENCY = "₹";

const cart = {
  isEmpty: false,
  lines: [
    { productId: "p1", name: "Cashmere Cardigan", quantity: 2, unitPrice: 1499, lineTotal: 2998 },
    { productId: "p2", name: "Wireless Earbuds", quantity: 1, unitPrice: 4999, lineTotal: 4999 },
  ],
  subtotal: 7997,
  discountPercent: 10,
  discount: 800,
  total: 7197,
  linesText: "Cashmere Cardigan x2, Wireless Earbuds x1",
  couponCode: "WELCOME10",
};

const product: RecentProduct = {
  id: "p1",
  name: "Cashmere Cardigan",
  category: "Women's Clothing",
  price: 1499,
  stock: 4,
  rating: 4.6,
  reviewCount: 128,
  keySpecs: ["Pure cashmere", "Button front"],
  inStock: true,
  // The catalog's own visual description, exactly as GET /api/state sends it.
  appearance: {
    primaryColor: "oatmeal",
    details: ["button front", "ribbed cuffs and hem", "soft shawl collar"],
    texture: "plush, brushed cashmere",
    styleImpression: "cosy, understated",
    summary: "A soft oatmeal cashmere cardigan with a simple button front, a soft shawl collar and ribbed cuffs and hem.",
  },
};

test("price components render rupees from the raw '₹' the store sends", async () => {
  const { CartPanel } = await import("../src/components/CartPanel.js");
  const { CheckoutPanel } = await import("../src/components/CheckoutPanel.js");
  const { ProductCard } = await import("../src/components/ProductCard.js");

  const rendered: Array<[string, string]> = [
    [
      "CartPanel",
      renderToStaticMarkup(
        createElement(CartPanel, {
          cart,
          currency: CURRENCY,
          open: true,
          onOpen: () => {},
          onClose: () => {},
          busy: false,
          onRemove: () => {},
          onApplyCoupon: () => {},
          onCheckout: () => {},
          reducedMotion: false,
        })
      ),
    ],
    [
      "CheckoutPanel",
      renderToStaticMarkup(
        createElement(CheckoutPanel, {
          order: { id: "o1", total: 7197, status: "confirmed" },
          currency: CURRENCY,
          onDismiss: () => {},
          reducedMotion: false,
        })
      ),
    ],
    [
      "ProductCard",
      renderToStaticMarkup(
        createElement(ProductCard, {
          product,
          currency: CURRENCY,
          onSelect: () => {},
          onAdd: () => {},
          onFocus: () => {},
          spotlight: false,
          reducedMotion: false,
        })
      ),
    ],
  ];

  for (const [name, html] of rendered) {
    // The crash was a RangeError thrown from inside render, so reaching this
    // point at all is most of the assertion; these two cover the output.
    const amounts = html.match(/₹[\d,]+/g) ?? [];
    assert.ok(amounts.length > 0, `${name} rendered no rupee amount`);
    assert.doesNotMatch(html, /INR[\s ]?\d/, `${name} showed the code instead of ₹`);
    console.log(`      ${name}: ${amounts.join(", ")}`);
  }
});

test("the product card shows the stored appearance and no product image", async () => {
  const { ProductCard } = await import("../src/components/ProductCard.js");

  const render = (p: typeof product) =>
    renderToStaticMarkup(
      createElement(ProductCard, {
        product: p,
        currency: CURRENCY,
        onSelect: () => {},
        onAdd: () => {},
        onFocus: () => {},
        spotlight: false,
        reducedMotion: true,
      })
    );

  const html = render(product);

  // There is no image in this catalog: nothing may render an <img>, and no
  // product path may appear anywhere in the markup.
  assert.doesNotMatch(html, /<img/i, "the product card must not render an image");
  assert.doesNotMatch(html, /\/images\//, "no product image path may be emitted");

  // What replaces the photo is the catalog's own appearance text, as ordinary
  // readable text — the same wording the voice agent speaks.
  assert.match(html, /A soft oatmeal cashmere cardigan/, "the appearance summary must be on the card");
  assert.match(html, /Cashmere Cardigan/, "the name must still be present");
  assert.match(html, /4\.6|review/i, "rating and review count must still be present");

  // A product the catalog does not describe must say so, not invent a look.
  const undescribed = render({ ...product, appearance: undefined });
  assert.doesNotMatch(undescribed, /<img/i);
  assert.match(undescribed, /No visual description/i);
});
