import {
  fetchGoatPurchaseCandidates,
  fetchSizeRow,
  updateOrder
} from "./airtable.js";
import { resolveGoatUrlBySku } from "./retailed.js";
import { buildSizeMap } from "./sizeNormalization.js";
import { STATUS } from "./constants.js";

function normalizeLookup(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeKey(value) {
  const raw = normalizeLookup(value);

  if (raw === undefined || raw === null || raw === "") return null;

  return String(raw).trim().toLowerCase();
}

function isEnabled(value) {
  const raw = normalizeLookup(value);

  return (
    raw === true ||
    raw === 1 ||
    raw === "1" ||
    String(raw).trim().toLowerCase() === "true"
  );
}

function parseMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;

  const cleaned = String(value)
    .replace(/[^\d.,-]/g, "")
    .replace(",", ".");

  const parsed = Number(cleaned);

  return Number.isFinite(parsed) ? parsed : null;
}

function getSku(fields) {
  return normalizeLookup(fields["SKU"]);
}

function getBrand(fields) {
  return normalizeLookup(fields["Brand"]);
}

function getGoatAccountMode(fields) {
  return String(
    normalizeLookup(fields["Merchant GOAT Account Mode"]) || ""
  )
    .trim()
    .toUpperCase();
}

function getGoatRunnerName(fields) {
  return normalizeKey(fields["Merchant GOAT Runner Name"]);
}

function getGoatAccountGroupKey(fields) {
  const value = normalizeKey(fields["Merchant GOAT Account Group Key"]);

  if (value) return value;

  return getGoatRunnerName(fields);
}

function recordMatchesRunner(fields, runnerName, accountGroupKey) {
  if (!isEnabled(fields["Merchant GOAT Auto Purchase Enabled"])) {
    return false;
  }

  const accountMode = getGoatAccountMode(fields);
  const recordRunner = getGoatRunnerName(fields);
  const recordAccountGroup = getGoatAccountGroupKey(fields);

  if (accountMode === "MAIN_ACCOUNT") {
    return !!accountGroupKey && recordAccountGroup === accountGroupKey;
  }

  if (accountMode === "DEDICATED_ACCOUNT") {
    return !!runnerName && recordRunner === runnerName;
  }

  return false;
}

function sortOldestFirst(records) {
  return records.sort((a, b) => {
    return new Date(a.createdTime) - new Date(b.createdTime);
  });
}

async function failRecord(recordId, status, errorMessage) {
  await updateOrder(recordId, {
    "GOAT Purchase Status": status,
    "GOAT LastAction": status,
    "GOAT ErrorMessage": errorMessage || status
  });
}

export async function getNextTask({ runnerName, accountGroupKey }) {
  const normalizedRunnerName = normalizeKey(runnerName);
  const normalizedAccountGroupKey = normalizeKey(accountGroupKey);

  if (!normalizedRunnerName) {
    throw new Error("runnerName is required");
  }

  const records = await fetchGoatPurchaseCandidates();

  const eligible = sortOldestFirst(
    records.filter((record) => {
      return recordMatchesRunner(
        record.fields,
        normalizedRunnerName,
        normalizedAccountGroupKey
      );
    })
  );

  if (!eligible.length) return null;

  const record = eligible[0];
  const f = record.fields;

  const sku = getSku(f);
  const brand = getBrand(f);
  const euSize = normalizeLookup(f["Size"]);
  const maxBuyingPrice = parseMoney(f["Maximum Buying Price"]);

  if (!sku || !brand || !euSize || !Number.isFinite(maxBuyingPrice)) {
    await failRecord(
      record.id,
      STATUS.FAILED,
      "Missing required fields: SKU, Brand, Size or Maximum Buying Price"
    );

    return null;
  }

  let resolved;

  try {
    resolved = await resolveGoatUrlBySku(sku);
  } catch (err) {
    await failRecord(record.id, STATUS.PRODUCT_NOT_FOUND, err.message);
    return null;
  }

  const sizeRow = await fetchSizeRow(brand, euSize);

  if (!sizeRow) {
    await failRecord(
      record.id,
      STATUS.SIZE_NOT_FOUND,
      `Size normalization not found for Brand=${brand}, EU Size=${euSize}`
    );

    return null;
  }

  const sizeMap = buildSizeMap(sizeRow);

  await updateOrder(record.id, {
    "GOAT LastAction": STATUS.IN_PROGRESS,
    "GOAT ErrorMessage": ""
  });

  return {
    type: "GOAT_PURCHASE",
    recordId: record.id,

    sku,
    brand,
    euSize,
    maxBuyingPrice,

    goatUrl: resolved.goatUrl,

    sizeMap,

    merchant: {
      goatAddress: normalizeLookup(f["GOAT Address"]) || "",
      paymentMethod: normalizeLookup(f["GOAT Payment Method"]) || "",
      creditcardLast4: normalizeLookup(f["GOAT Creditcard"]) || ""
    },

    runner: {
      runnerName: normalizedRunnerName,
      accountGroupKey: normalizedAccountGroupKey,
      accountMode: getGoatAccountMode(f)
    }
  };
}
