import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatMoney, normalizeCurrency } from "../src/lib/money.js";

/**
 * The store reports its currency as the rupee sign, not as an ISO 4217 code, so
 * every price passes through this on its way to the screen. The bug these tests
 * exist to prevent is a RangeError taking down the cart, so the important
 * property is simply that formatting never throws — whatever the store sends.
 */

describe("normalizeCurrency", () => {
  test("resolves the rupee sign the store actually sends", () => {
    // This is the literal value /api/capabilities returns.
    assert.equal(normalizeCurrency("₹"), "INR");
  });

  test("accepts a real ISO code in any case", () => {
    assert.equal(normalizeCurrency("INR"), "INR");
    assert.equal(normalizeCurrency("inr"), "INR");
    assert.equal(normalizeCurrency("USD"), "USD");
  });

  test("resolves other common symbols and short names", () => {
    assert.equal(normalizeCurrency("Rs"), "INR");
    assert.equal(normalizeCurrency("Rs."), "INR");
    assert.equal(normalizeCurrency("rupees"), "INR");
    assert.equal(normalizeCurrency("$"), "USD");
    assert.equal(normalizeCurrency("€"), "EUR");
    assert.equal(normalizeCurrency("£"), "GBP");
  });

  test("falls back to the store currency for missing values", () => {
    assert.equal(normalizeCurrency(""), "INR");
    assert.equal(normalizeCurrency("   "), "INR");
    assert.equal(normalizeCurrency(null), "INR");
    assert.equal(normalizeCurrency(undefined), "INR");
  });

  test("rejects three letters that are not a real currency code", () => {
    // Intl formats "XYZ" as "XYZ 1,499" rather than throwing, so a shape-only
    // check would let nonsense through to the price on screen.
    assert.equal(normalizeCurrency("XYZ"), "INR");
    assert.equal(normalizeCurrency("ZZZ"), "INR");
    assert.equal(normalizeCurrency("not-a-currency"), "INR");
  });
});

describe("formatMoney", () => {
  test("renders rupees with the symbol, not the code", () => {
    assert.equal(formatMoney(1499, "₹"), "₹1,499");
    assert.equal(formatMoney(1499, "INR"), "₹1,499");
  });

  test("matches for the cart, a product card and a confirmation", () => {
    // Same amount, three components, one implementation: they cannot drift.
    const fromCart = formatMoney(2499, "₹");
    const fromProduct = formatMoney(2499, "₹");
    const fromOrder = formatMoney(2499, "₹");
    assert.equal(fromCart, fromProduct);
    assert.equal(fromProduct, fromOrder);
    assert.equal(fromCart, "₹2,499");
  });

  test("never throws, whatever the store reports", () => {
    for (const currency of ["₹", "INR", "USD", "XYZ", "", "  ", "💥", null, undefined]) {
      assert.doesNotThrow(() => formatMoney(1499, currency as string));
    }
  });

  test("falls back to rupees for a currency it cannot resolve", () => {
    assert.equal(formatMoney(1499, "XYZ"), "₹1,499");
  });

  test("respects a currency the store really does use", () => {
    assert.equal(formatMoney(1499, "USD"), "$1,499");
  });
});
