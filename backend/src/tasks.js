import { fetchOrders, fetchSizeRow, updateOrder } from "./airtable.js";
import { resolveGoatUrlBySku } from "./retailed.js";
import { buildSizeMap } from "./sizeNormalization.js";
import { STATUS } from "./constants.js";

export async function getNextTask() {
  const records = await fetchOrders();

  if (!records.length) return null;

  const record = records[0];
  const f = record.fields;

  const sku = f["SKU"];
  const brand = f["Brand"];
  const euSize = f["Size"];
  const maxBuyingPrice = Number(f["Maximum Buying Price"]);

  // 🔎 Retailed
  let goatUrl;
  try {
    goatUrl = await resolveGoatUrlBySku(sku);
  } catch (err) {
    await updateOrder(record.id, {
      "GOAT Purchase Status": STATUS.PRODUCT_NOT_FOUND,
      "GOAT ErrorMessage": err.message
    });
    return null;
  }

  // 📏 Size normalization
  const sizeRow = await fetchSizeRow(brand, euSize);

  if (!sizeRow) {
    await updateOrder(record.id, {
      "GOAT Purchase Status": STATUS.SIZE_NOT_FOUND,
      "GOAT ErrorMessage": "Size normalization not found"
    });
    return null;
  }

  const sizeMap = buildSizeMap(sizeRow);

  // 🔒 Lock
  await updateOrder(record.id, {
    "GOAT Purchase Status": STATUS.IN_PROGRESS,
    "GOAT LastAction": "LOCKED"
  });

  return {
    type: "GOAT_PURCHASE",
    recordId: record.id,
    sku,
    brand,
    euSize,
    maxBuyingPrice,
    goatUrl,
    sizeMap,
    merchant: {
      goatAddress: f["GOAT Address"],
      paymentMethod: f["GOAT Payment Method"],
      creditcardLast4: f["GOAT Creditcard"]
    }
  };
}
