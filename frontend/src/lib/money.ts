/**
 * Money formatting.
 *
 * The store reports its currency as a symbol rather than an ISO 4217 code — the
 * backend defaults to "₹" and hands it to the frontend through
 * /api/capabilities. `Intl.NumberFormat` only accepts the code, so the raw value
 * has to be resolved before formatting. Doing it in one place keeps the price on a
 * product card, a cart line and an order confirmation identical.
 *
 * Resolution order:
 *   1. a known symbol or short name  ("₹", "Rs", "$" …)
 *   2. a real ISO 4217 code           ("INR", "usd" …)
 *   3. the store default              (anything unrecognised)
 *
 * Step 2 has to check against the actual ISO list: `Intl` accepts any three
 * letters, so "XYZ" formats happily as "XYZ 1,499" instead of throwing. Only a
 * real-code check turns that back into the intended ₹1,499.
 */

const DEFAULT_CURRENCY = "INR";

/**
 * Symbols and short names mapped to their ISO code, keyed by lower case.
 * Only unambiguous, widely used forms — anything else falls through to the ISO
 * check and then to the default, rather than guessing.
 */
const SYMBOLS: Readonly<Record<string, string>> = {
  "₹": "INR",
  rs: "INR",
  "rs.": "INR",
  rupee: "INR",
  rupees: "INR",
  inr: "INR",
  $: "USD",
  us$: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
};

let isoCodes: Set<string> | null = null;

/**
 * The currency codes the runtime actually knows. Built once, on first use.
 * Returns an empty set where `Intl.supportedValuesOf` is unavailable, which
 * makes the caller fall back to accepting any three-letter code.
 */
function knownIsoCodes(): Set<string> {
  if (isoCodes) return isoCodes;
  try {
    isoCodes = new Set(Intl.supportedValuesOf("currency"));
  } catch {
    isoCodes = new Set();
  }
  return isoCodes;
}

/** Resolves any currency the store might report into an ISO 4217 code. */
export function normalizeCurrency(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_CURRENCY;

  const symbol = SYMBOLS[value.toLowerCase()];
  if (symbol) return symbol;

  const code = value.toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) {
    const known = knownIsoCodes();
    if (known.size === 0 || known.has(code)) return code;
  }

  return DEFAULT_CURRENCY;
}

/**
 * Formats a whole-rupee amount for display, e.g. 1499 → ₹1,499.
 *
 * Never throws: an unresolvable currency falls back to the store default rather
 * than taking the whole component down with a RangeError.
 */
export function formatMoney(value: number, currency: string | null | undefined): string {
  const code = normalizeCurrency(currency);
  const options: Intl.NumberFormatOptions = {
    style: "currency",
    currency: code,
    maximumFractionDigits: 0,
  };

  try {
    return new Intl.NumberFormat("en-IN", options).format(value);
  } catch {
    return new Intl.NumberFormat("en-IN", {
      ...options,
      currency: DEFAULT_CURRENCY,
    }).format(value);
  }
}
