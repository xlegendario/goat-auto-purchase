import { updateOrder } from "./airtable.js";
import { STATUS } from "./constants.js";

export async function submitTaskResult(recordId, payload) {
  const now = new Date().toISOString();

  return await updateOrder(recordId, {
    "GOAT Purchase Status": payload.status,
    "GOAT LastAction": payload.status,
    "GOAT Final Price": payload.finalPrice || null,
    "GOAT Bought Size": payload.boughtSize || null,
    "GOAT Purchased At":
      payload.status === STATUS.PURCHASED ? now : null,
    "GOAT ErrorMessage": payload.errorMessage || ""
  });
}
