import { updateOrder } from "./airtable.js";
import { STATUS } from "./constants.js";

function moneyOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function textOrEmpty(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

const ALLOWED_STATUSES = new Set([
  STATUS.PURCHASED,
  STATUS.FAILED,
  STATUS.NO_VALID_PRICE,
  STATUS.SIZE_NOT_FOUND,
  STATUS.PRODUCT_NOT_FOUND,
  STATUS.ADDRESS_MISMATCH,
  STATUS.PAYMENT_MISMATCH
]);

export async function submitTaskResult(recordId, payload) {
  if (!recordId) {
    throw new Error("recordId is required");
  }

  const status = payload.status;

  if (!ALLOWED_STATUSES.has(status)) {
    throw new Error(`Invalid GOAT result status: ${status}`);
  }

  const now = new Date().toISOString();

  const fields = {
    "GOAT LastAction": status,
    "GOAT Final Price": moneyOrNull(payload.finalPrice),
    "GOAT Bought Size": textOrEmpty(payload.boughtSize),
    "GOAT ErrorMessage": textOrEmpty(payload.errorMessage)
  };

  if (status === STATUS.PURCHASED) {
    fields["GOAT Purchased At"] = now;
  }

  return await updateOrder(recordId, fields);
}
