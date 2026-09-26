/**
 * ONE place that decides where a product's image lives.
 *
 * `productImageUrl(name)` is used by the seed data (so every catalog product
 * ships with a real, resolvable image) and `productImageFile(name)` is used by
 * `scripts/generateProductImages.ts` to write the asset under the same name —
 * the two can never drift.
 *
 * The stored value is store-relative ("/images/products/<slug>.png"): the
 * backend serves it to the browser at /images/* and the vision tool reads the
 * very same bytes off disk. An absolute http(s) URL is also accepted by the
 * fetcher, so a real CDN can be swapped in without touching any other code.
 */
export function productImageSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "product"
  );
}

export function productImageFile(name: string): string {
  return `${productImageSlug(name)}.png`;
}

/** The value stored on the product document. */
export function productImageUrl(name: string): string {
  return `/images/products/${productImageFile(name)}`;
}
