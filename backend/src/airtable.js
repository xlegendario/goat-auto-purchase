const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN = process.env.AIRTABLE_TOKEN;

const ORDERS_TABLE = process.env.AIRTABLE_ORDERS_TABLE_NAME;
const SIZE_TABLE = process.env.AIRTABLE_SIZE_TABLE_NAME;

const BASE_URL = `https://api.airtable.com/v0/${BASE_ID}`;

function headers() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json"
  };
}

function tableUrl(tableName) {
  return `${BASE_URL}/${encodeURIComponent(tableName)}`;
}

function escapeFormulaValue(value) {
  return String(value || "").replace(/'/g, "\\'");
}

async function fetchAllRecords(url) {
  let allRecords = [];
  let offset = null;

  do {
    const nextUrl = new URL(url.toString());

    if (offset) {
      nextUrl.searchParams.set("offset", offset);
    }

    const res = await fetch(nextUrl.toString(), {
      method: "GET",
      headers: headers()
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Airtable fetch failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    allRecords = allRecords.concat(data.records || []);
    offset = data.offset || null;
  } while (offset);

  return allRecords;
}

export async function fetchGoatPurchaseCandidates() {
  const url = new URL(tableUrl(ORDERS_TABLE));

  url.searchParams.set(
    "filterByFormula",
    `
    AND(
      {GOAT Purchase Needed} = 1
      {SKU} != "",
      {Size} != "",
      {Maximum Buying Price} != "",
      {Merchant GOAT Auto Purchase Enabled} = 1
    )
    `
  );

  return await fetchAllRecords(url);
}

export async function fetchSizeRow(brand, euSize) {
  const url = new URL(tableUrl(SIZE_TABLE));

  url.searchParams.set(
    "filterByFormula",
    `AND(
      {Brand} = '${escapeFormulaValue(brand)}',
      {EU Size} = '${escapeFormulaValue(euSize)}'
    )`
  );

  const records = await fetchAllRecords(url);
  return records[0] || null;
}

export async function updateOrder(recordId, fields) {
  const res = await fetch(`${tableUrl(ORDERS_TABLE)}/${recordId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ fields })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable update failed: ${res.status} ${text}`);
  }

  return await res.json();
}
