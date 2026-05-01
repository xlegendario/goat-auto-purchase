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

export async function fetchOrders() {
  const url = new URL(`${BASE_URL}/${ORDERS_TABLE}`);

  url.searchParams.set(
    "filterByFormula",
    `
    AND(
      {GOAT Purchase Status} = "GOAT_PURCHASE_NEEDED",
      {SKU} != "",
      {Size} != "",
      {Maximum Buying Price} != ""
    )
  `
  );

  const res = await fetch(url.toString(), {
    headers: headers()
  });

  const data = await res.json();
  return data.records || [];
}

export async function fetchSizeRow(brand, euSize) {
  const url = new URL(`${BASE_URL}/${SIZE_TABLE}`);

  url.searchParams.set(
    "filterByFormula",
    `AND({Brand}='${brand}', {EU Size}='${euSize}')`
  );

  const res = await fetch(url.toString(), {
    headers: headers()
  });

  const data = await res.json();
  return data.records?.[0] || null;
}

export async function updateOrder(recordId, fields) {
  const res = await fetch(`${BASE_URL}/${ORDERS_TABLE}/${recordId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ fields })
  });

  return await res.json();
}
