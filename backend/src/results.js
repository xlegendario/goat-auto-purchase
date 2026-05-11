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
  STATUS.ORDER_SYNC,
  STATUS.ORDER_NOT_READY,
  STATUS.ORDER_SYNC_FAILED,
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
    "GOAT ErrorMessage": textOrEmpty(payload.errorMessage)
  };
  
  if (
    status === STATUS.PURCHASED ||
    status === STATUS.FAILED ||
    status === STATUS.NO_VALID_PRICE ||
    status === STATUS.SIZE_NOT_FOUND ||
    status === STATUS.PRODUCT_NOT_FOUND ||
    status === STATUS.ADDRESS_MISMATCH ||
    status === STATUS.PAYMENT_MISMATCH
  ) {
    fields["GOAT Final Price"] = moneyOrNull(payload.finalPrice);
    fields["GOAT Bought Size"] = textOrEmpty(payload.boughtSize);
  }

  if (status === STATUS.PURCHASED) {
    fields["GOAT Purchased At"] = payload.purchasedAt || now;
    fields["Fulfillment Status"] = { name: "GOAT Processing" };
  
    if (payload.goatOrderNumber) {
      fields["GOAT Order Number"] = textOrEmpty(payload.goatOrderNumber);
    }
  }

  if (
    status === STATUS.ORDER_SYNC ||
    status === STATUS.ORDER_NOT_READY ||
    status === STATUS.ORDER_SYNC_FAILED
  ) {
    fields["GOAT LastAction"] = STATUS.PURCHASED;
    fields["LastGoatOrderSyncAt"] = now;
  
    if (payload.goatOrderStatus) {
      fields["GOAT Order Status"] = textOrEmpty(payload.goatOrderStatus);
    }
  
    if (status === STATUS.ORDER_SYNC) {
      fields["GOAT Tracking Number"] = textOrEmpty(payload.goatTrackingNumber);
      fields["GOAT Tracking URL"] = textOrEmpty(payload.goatTrackingUrl);
      fields["GOAT ErrorMessage"] = "";
    }
  }

  return await updateOrder(recordId, fields);
}
