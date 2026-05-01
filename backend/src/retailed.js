const SEARCH_URL = process.env.RETAILED_GOAT_SEARCH_URL;
const API_KEY = process.env.RETAILED_API_KEY;

const RETAILED_TIMEOUT_MS = 10000;

function normalizeSku(sku) {
  if (Array.isArray(sku)) return String(sku[0] || "").trim();
  return String(sku || "").trim();
}

export async function resolveGoatUrlBySku(rawSku) {
  const sku = normalizeSku(rawSku);

  if (!sku) {
    throw new Error("SKU is required for GOAT lookup");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RETAILED_TIMEOUT_MS);

  try {
    const url = new URL(SEARCH_URL);
    url.searchParams.set("query", sku);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-api-key": API_KEY
      },
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Retailed GOAT request failed: ${res.status} ${text}`);
    }

    const data = await res.json();

    const results = Array.isArray(data) ? data : [data];

    if (!results.length) {
      throw new Error(`No GOAT product found for SKU ${sku}`);
    }

    const exactMatch =
      results.find((item) => {
        return (
          String(item.sku || "").trim().toLowerCase() === sku.toLowerCase()
        );
      }) || null;

    const match = exactMatch || results[0];

    if (!match?.slug) {
      throw new Error(`No GOAT slug found for SKU ${sku}`);
    }

    return {
      goatUrl: `https://www.goat.com/sneakers/${match.slug}`,
      slug: match.slug,
      matchedSku: match.sku || null,
      raw: match
    };
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Retailed GOAT request timed out for SKU ${sku}`);
    }

    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
