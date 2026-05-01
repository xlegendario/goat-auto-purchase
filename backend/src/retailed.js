const URL = process.env.RETAILED_GOAT_SEARCH_URL;
const API_KEY = process.env.RETAILED_API_KEY;

export async function resolveGoatUrlBySku(sku) {
  const url = new URL(URL);
  url.searchParams.set("query", sku);

  const res = await fetch(url.toString(), {
    headers: {
      "x-api-key": API_KEY
    }
  });

  const data = await res.json();

  if (!data?.slug) {
    throw new Error("GOAT slug not found");
  }

  return `https://www.goat.com/sneakers/${data.slug}`;
}
