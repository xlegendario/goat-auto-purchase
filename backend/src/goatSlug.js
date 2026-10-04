import { resolveGoatUrlBySku as resolveViaRetailed } from "./retailed.js";

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN = process.env.AIRTABLE_TOKEN;

const SKU_MASTER_TABLE = process.env.AIRTABLE_SKU_MASTER_TABLE || "SKU Master";

function airtableUrl(table, suffix = "") {
  return `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(table)}${suffix}`;
}

function airtableHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json"
  };
}

function escapeFormulaValue(value) {
  return String(value || "").replace(/'/g, "\\'");
}

function normalizeSku(sku) {
  if (Array.isArray(sku)) return String(sku[0] || "").trim();
  return String(sku || "").trim();
}

/*
 * A SKU Master row can name several SKUs at once ("553560-130/553560-136"),
 * so an exact {SKU}= match would miss it. FIND widens the net; comparing the
 * parts narrows it again, because FIND alone would also hit a longer SKU
 * that merely contains this one.
 */
function skuVariants(value) {
  return String(value || "")
    .split("/")
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

function skusMatch(a, b) {
  const right = new Set(skuVariants(b));
  return skuVariants(a).some((part) => right.has(part));
}

async function findSkuMasterRecord(sku) {
  const safe = escapeFormulaValue(sku);
  const url = new URL(airtableUrl(SKU_MASTER_TABLE));

  url.searchParams.set(
    "filterByFormula",
    `OR({SKU}='${safe}', FIND('${safe}', {SKU}&'') > 0)`
  );
  url.searchParams.set("maxRecords", "10");

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: airtableHeaders()
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SKU Master lookup failed: ${res.status} ${text}`);
  }

  const data = await res.json();

  return (
    (data.records || []).find((record) => skusMatch(sku, record.fields?.["SKU"])) || null
  );
}

async function storeSlugOnSkuMaster(recordId, slug) {
  const res = await fetch(airtableUrl(SKU_MASTER_TABLE, `/${recordId}`), {
    method: "PATCH",
    headers: airtableHeaders(),
    body: JSON.stringify({ fields: { "GOAT Slug": slug } })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SKU Master write-back failed: ${res.status} ${text}`);
  }
}

/*
 * SKU -> GOAT URL, cheapest source first.
 *
 * 1. SKU Master's GOAT Slug, filled by earlier lookups
 * 2. Retailed, as before
 * 3. write the Retailed slug back, so each product costs one Retailed call
 *
 * Only onto a SKU Master row that already exists: this bot also buys for
 * merchants whose products are not ours, and it should not grow SKU Master.
 * And only an exact SKU match is stored - Retailed falls back to its first
 * result, and caching that guess would make a wrong product permanent.
 */
export async function resolveGoatUrlBySku(rawSku) {
  const sku = normalizeSku(rawSku);

  if (!sku) {
    throw new Error("SKU is required for GOAT lookup");
  }

  const masterRecord = await findSkuMasterRecord(sku).catch((err) => {
    console.error("⚠️ SKU Master lookup failed, falling back to Retailed", {
      sku,
      error: err.message
    });

    return null;
  });

  const storedSlug = String(masterRecord?.fields?.["GOAT Slug"] || "").trim();

  if (storedSlug) {
    return {
      goatUrl: `https://www.goat.com/sneakers/${storedSlug}`,
      slug: storedSlug,
      matchedSku: String(masterRecord.fields["SKU"] || sku),
      raw: null,
      source: "sku_master"
    };
  }

  const resolved = await resolveViaRetailed(sku);

  if (masterRecord?.id && resolved.exactMatch) {
    // Best effort: a purchase must not fail because the cache could not be filled.
    await storeSlugOnSkuMaster(masterRecord.id, resolved.slug).catch((err) =>
      console.error("⚠️ Could not store the GOAT slug on SKU Master", {
        sku,
        error: err.message
      })
    );
  }

  return { ...resolved, source: "retailed" };
}
