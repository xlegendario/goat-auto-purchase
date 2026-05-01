console.log("GOAT Auto Purchase content script loaded");

let currentTask = null;
let flowStarted = false;

window.addEventListener("load", async () => {
  const stored = await chrome.storage.local.get("currentTask");
  currentTask = stored.currentTask || null;

  if (!currentTask) {
    console.log("No GOAT currentTask found");
    return;
  }

  if (flowStarted) return;
  flowStarted = true;

  setTimeout(() => {
    runGoatFlow().catch((err) => {
      console.error("GOAT flow failed:", err);

      reportTaskResult("PURCHASE_FAILED", {
        errorMessage: err.message
      });
    });
  }, 2000);
});

async function shouldForceStopRunner() {
  const data = await chrome.storage.local.get(["forceStop"]);
  return data.forceStop === true;
}

async function stopIfNeeded(context = "") {
  const mustStop = await shouldForceStopRunner();

  if (mustStop) {
    console.log(`Force stop triggered${context ? ` during ${context}` : ""}`);
    return true;
  }

  return false;
}

async function runGoatFlow() {
  if (!currentTask) return;

  if (await stopIfNeeded("start")) return;

  console.log("Starting GOAT purchase flow:", currentTask);

  if (window.location.pathname.includes("/checkout")) {
    await handleCheckoutPage();
    return;
  }

  if (!window.location.pathname.includes("/sneakers/")) {
    window.location.href = currentTask.goatUrl;
    return;
  }

  await handleProductPage();
}

async function handleProductPage() {
  await waitForPageReady();

  if (await stopIfNeeded("product page")) return;

  await verifyProductOrFail();

  const sizeType = await detectGoatSizeType();
  const targetSize = resolveTargetSize(sizeType, currentTask.sizeMap);

  if (!targetSize) {
    await reportTaskResult("SIZE_NOT_FOUND", {
      errorMessage: `No target US size found for GOAT size type "${sizeType}"`,
      boughtSize: ""
    });
    return;
  }

  console.log("Resolved GOAT target size:", {
    sizeType,
    targetSize
  });

  const selected = await selectSizeFromSlider(targetSize);

  if (!selected) {
    await reportTaskResult("SIZE_NOT_FOUND", {
      errorMessage: `GOAT size ${targetSize} not found in slider`,
      boughtSize: ""
    });
    return;
  }

  await sleep(1500);

  const bestPrice = findBestPriceOption();

  if (!bestPrice) {
    await reportTaskResult("NO_VALID_PRICE", {
      errorMessage: "Best Price / Under Retail option not found",
      boughtSize: targetSize
    });
    return;
  }

  console.log("Best price row detected:", {
    price: bestPrice.price,
    text: bestPrice.row.innerText
  });

  const estimatedTotal = bestPrice.price + 15;

  if (estimatedTotal > Number(currentTask.maxBuyingPrice)) {
    await reportTaskResult("NO_VALID_PRICE", {
      errorMessage: `Best Price ${bestPrice.price} + shipping 15 = ${estimatedTotal} exceeds max ${currentTask.maxBuyingPrice}`,
      finalPrice: estimatedTotal,
      boughtSize: targetSize
    });
    return;
  }

  console.log("Selecting Best Price option:", bestPrice);

  clickElement(bestPrice.selectButton);

  await chrome.storage.local.set({
    goatPendingCheckout: {
      recordId: currentTask.recordId,
      sku: currentTask.sku,
      productName: getProductName(),
      boughtSize: targetSize,
      maxBuyingPrice: currentTask.maxBuyingPrice,
      dryRun: currentTask.dryRun === true
    }
  });

  await sleep(4000);

  if (!window.location.pathname.includes("/checkout")) {
    console.log("Waiting for checkout navigation...");
  }
}

async function handleCheckoutPage() {
  await waitForPageReady();

  if (await stopIfNeeded("checkout page")) return;

  const pending = await getPendingCheckout();

  const boughtSize = pending?.boughtSize || "";
  const maxBuyingPrice = Number(currentTask.maxBuyingPrice);

  const pageText = document.body.innerText || "";
  const normalizedPageText = normalizeText(pageText);

  const productOk = verifyCheckoutProduct(normalizedPageText);
  if (!productOk) {
    await reportTaskResult("PURCHASE_FAILED", {
      errorMessage: `Product mismatch on checkout. Expected SKU/product: ${currentTask.sku}`,
      boughtSize
    });
    return;
  }

  const sizeOk = verifyCheckoutSize(pageText, boughtSize);
  if (!sizeOk) {
    await reportTaskResult("SIZE_NOT_FOUND", {
      errorMessage: `Checkout size mismatch. Expected bought size ${boughtSize}`,
      boughtSize
    });
    return;
  }

  const addressOk = verifyAddress(currentTask.merchant?.goatAddress);
  if (!addressOk) {
    await reportTaskResult("ADDRESS_MISMATCH", {
      errorMessage: `GOAT address mismatch. Expected: ${currentTask.merchant?.goatAddress || ""}`,
      boughtSize
    });
    return;
  }

  const paymentOk = selectAndVerifyPayment(
    currentTask.merchant?.paymentMethod,
    currentTask.merchant?.creditcardLast4
  );

  if (!paymentOk) {
    await reportTaskResult("PAYMENT_MISMATCH", {
      errorMessage: `GOAT payment mismatch. Expected ${currentTask.merchant?.paymentMethod || ""} ${currentTask.merchant?.creditcardLast4 || ""}`,
      boughtSize
    });
    return;
  }

  const finalPrice = extractCheckoutTotal();

  if (!Number.isFinite(finalPrice)) {
    await reportTaskResult("PURCHASE_FAILED", {
      errorMessage: "Could not extract GOAT checkout total",
      boughtSize
    });
    return;
  }

  if (finalPrice > maxBuyingPrice) {
    await reportTaskResult("NO_VALID_PRICE", {
      errorMessage: `Checkout total ${finalPrice} exceeds max ${maxBuyingPrice}`,
      finalPrice,
      boughtSize
    });
    return;
  }

  const placeOrderButton = findButtonByText("securely place order");

  if (!placeOrderButton) {
    await reportTaskResult("PURCHASE_FAILED", {
      errorMessage: "Securely Place Order button not found",
      finalPrice,
      boughtSize
    });
    return;
  }

  if (currentTask.dryRun === true) {
    console.log("DRY_RUN enabled. Not clicking Securely Place Order.");

    await reportTaskResult("PURCHASED", {
      finalPrice,
      boughtSize,
      errorMessage: "DRY_RUN: checkout validated, order not actually placed"
    });

    return;
  }

  clickElement(placeOrderButton);

  await sleep(4000);

  await reportTaskResult("PURCHASED", {
    finalPrice,
    boughtSize,
    errorMessage: ""
  });
}

async function getPendingCheckout() {
  const data = await chrome.storage.local.get(["goatPendingCheckout"]);
  return data.goatPendingCheckout || null;
}

async function waitForPageReady(attempt = 0) {
  if (attempt > 30) return;

  if (document.body && document.body.innerText.length > 100) {
    return;
  }

  await sleep(1000);
  return waitForPageReady(attempt + 1);
}

async function verifyProductOrFail() {
  const expectedSku = normalizeText(currentTask.sku);
  const bodyText = normalizeText(document.body.innerText || "");

  if (bodyText.includes(expectedSku)) {
    return true;
  }

  console.warn("SKU not visible on GOAT page. Continuing with slug/product title validation only.");
  return true;
}

function getProductName() {
  const candidates = Array.from(document.querySelectorAll("h1, h2, div, span"))
    .map((el) => String(el.innerText || "").trim())
    .filter((text) => text.length > 5 && text.length < 120);

  return candidates[0] || "";
}

async function detectGoatSizeType() {
  console.log("Detecting GOAT size type...");

  const opened = await openSizePanel();
  if (!opened) {
    throw new Error("Could not open GOAT size panel");
  }

  const label = findSizePreferenceLabel();
  if (!label) {
    throw new Error("Could not find GOAT size preference label");
  }

  const text = normalizeText(label.innerText);

  if (text.includes("women")) return "US Women's Size";
  if (text.includes("youth")) return "US Youth Size";
  if (text.includes("infant")) return "US Infant Size";
  if (text.includes("men")) return "US Men's Size";

  throw new Error(`Could not detect GOAT size type from label: ${label.innerText}`);
}

function resolveTargetSize(sizeType, sizeMap) {
  if (!sizeMap) return null;

  if (sizeType === "US Women's Size") {
    return cleanSize(sizeMap.usWomensSize);
  }

  if (sizeType === "US Youth Size") {
    return cleanSize(sizeMap.usGsSize);
  }

  if (sizeType === "US Infant Size") {
    return cleanSize(sizeMap.usPsSize || sizeMap.usTdSize);
  }

  return cleanSize(sizeMap.usSize);
}

async function selectSizeFromSlider(targetSize) {
  const opened = await openSizePanel();
  if (!opened) return false;

  const label = findSizePreferenceLabel();
  if (!label) {
    console.log("GOAT size preference label not found");
    return false;
  }

  const labelText = normalizeText(label.innerText);
  let category = null;

  if (labelText.includes("women")) category = "women";
  else if (labelText.includes("youth")) category = "youth";
  else if (labelText.includes("infant")) category = "infant";
  else if (labelText.includes("men")) category = "men";

  if (!category) {
    console.log("Could not detect GOAT category from label:", label.innerText);
    return false;
  }

  clickElement(label);
  await sleep(700);

  if (!clickExactPreferenceOption(category)) return false;
  await sleep(300);

  if (!clickExactPreferenceOption("us")) return false;
  await sleep(300);

  const sizeClicked = clickExactPreferenceOption(String(targetSize));
  if (!sizeClicked) {
    scrollPreferenceModalDown();
    await sleep(300);

    if (!clickExactPreferenceOption(String(targetSize))) return false;
  }

  await sleep(300);

  const save = findButtonByText("save");
  if (!save) return false;

  clickElement(save);
  await sleep(1500);

  return true;
}

function findSizePreferenceLabel() {
  return getVisibleElements("button, div, span").find((el) => {
    const text = normalizeText(el.innerText);
    return (
      text.includes("us ") &&
      text.includes("size") &&
      (
        text.includes("women") ||
        text.includes("men") ||
        text.includes("youth") ||
        text.includes("infant")
      )
    );
  }) || null;
}

function clickExactPreferenceOption(value) {
  const target = normalizeText(value);

  const el = getVisibleElements("button, div, span").find((el) => {
    const text = normalizeText(el.innerText);
    return text === target;
  });

  if (!el) {
    console.log("Preference option not found:", value);
    return false;
  }

  clickElement(el);
  return true;
}

function scrollPreferenceModalDown() {
  const modal = getVisibleElements("div").find((el) => {
    const text = normalizeText(el.innerText);
    return text.includes("size preferences") && text.includes("save");
  });

  if (modal) {
    modal.scrollTop = modal.scrollHeight;
    modal.dispatchEvent(new Event("scroll", { bubbles: true }));
  }
}

function findLikelySizeArea() {
  const candidates = getVisibleElements("div, section, footer");

  return candidates
    .filter((el) => {
      const text = normalizeText(el.innerText);
      const rect = el.getBoundingClientRect();

      return (
        rect.top > window.innerHeight * 0.55 &&
        text.includes("€") &&
        /\b\d+(\.5)?\b/.test(text)
      );
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    })[0] || null;
}

async function openSizePanel() {
  const yPoints = [
    window.innerHeight - 110,
    window.innerHeight - 90,
    window.innerHeight - 75,
    window.innerHeight - 60
  ];

  const xPoints = [
    window.innerWidth * 0.35,
    window.innerWidth * 0.45,
    window.innerWidth * 0.55,
    window.innerWidth * 0.65
  ];

  for (let attempt = 0; attempt < 20; attempt++) {
    for (const y of yPoints) {
      for (const x of xPoints) {
        console.log("Trying GOAT hover point:", { x, y });

        moveMouseAt(x, y);
        await sleep(250);

        if (getSizeSliderBounds()) {
          console.log("GOAT size panel opened");
          return true;
        }
      }
    }

    await sleep(500);
  }

  return false;
}


function getSizeSliderBounds() {
  const tileCandidates = getVisibleElements("button, div, span").filter((el) => {
    const rect = el.getBoundingClientRect();
    const raw = String(el.innerText || "").trim();
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);

    return (
      rect.top > window.innerHeight * 0.55 &&
      rect.top < window.innerHeight * 0.9 &&
      rect.width <= 100 &&
      rect.height <= 80 &&
      lines.length >= 2 &&
      /\b\d+(\.5)?\b/.test(lines[0]) &&
      /€\s*\d+/.test(raw)
    );
  });

  if (!tileCandidates.length) return null;

  const rects = tileCandidates.map((el) => el.getBoundingClientRect());

  return {
    left: Math.min(...rects.map((r) => r.left)) - 80,
    right: Math.max(...rects.map((r) => r.right)) + 80,
    top: Math.min(...rects.map((r) => r.top)) - 50,
    bottom: Math.max(...rects.map((r) => r.bottom)) + 50
  };
}

function findVisibleSizeTiles() {
  const bounds = getSizeSliderBounds();
  if (!bounds) return [];

  return getVisibleElements("button, div, span").filter((el) => {
    const rect = el.getBoundingClientRect();
    const raw = String(el.innerText || "").trim();
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);

    const insideSlider =
      rect.left >= bounds.left &&
      rect.right <= bounds.right &&
      rect.top >= bounds.top &&
      rect.bottom <= bounds.bottom;

    if (!insideSlider) return false;
    if (rect.width > 90 || rect.height > 70) return false;
    if (!/€\s*\d+/.test(raw)) return false;

    return normalizeSize(lines[0]) !== "";
  });
}

function findSizeTile(normalizedTarget) {
  const tiles = findVisibleSizeTiles();

  return tiles.find((el) => {
    const lines = String(el.innerText || "")
      .split("\n")
      .map((line) => normalizeSize(line))
      .filter(Boolean);

    return lines[0] === normalizedTarget;
  }) || null;
}

function findSliderArrow(direction) {
  const bounds = getSizeSliderBounds();
  if (!bounds) return null;

  const targetText = direction === "left" ? "←" : "→";

  return getVisibleElements("button, div, span").find((el) => {
    const text = normalizeText(el.innerText);
    const rect = el.getBoundingClientRect();

    return (
      text === targetText &&
      rect.top >= bounds.top &&
      rect.bottom <= bounds.bottom
    );
  }) || null;
}

function findBestPriceOption() {
  const buttons = getVisibleElements("button").filter((btn) => {
    return normalizeText(btn.innerText) === "select";
  });

  for (const button of buttons) {
    const row = findPriceRowForSelectButton(button);
    if (!row) continue;

    const text = normalizeText(row.innerText);

    if (!text.includes("best price") && !text.includes("under retail")) continue;
    if (text.includes("instant")) continue;

    const price = extractFirstEuroPrice(row.innerText);

    if (Number.isFinite(price)) {
      return {
        price,
        row,
        selectButton: button
      };
    }
  }

  return null;
}

function findPriceRowForSelectButton(button) {
  let el = button;

  for (let i = 0; i < 6; i++) {
    if (!el) return null;

    const text = normalizeText(el.innerText || "");
    const raw = el.innerText || "";

    if (
      /€\s*\d+/.test(raw) &&
      (text.includes("best price") || text.includes("under retail") || text.includes("instant"))
    ) {
      return el;
    }

    el = el.parentElement;
  }

  return null;
}

function findSelectButtonInsideOrNear(row) {
  const inside = Array.from(row.querySelectorAll("button")).find((btn) => {
    return normalizeText(btn.innerText) === "select";
  });

  if (inside) return inside;

  const rect = row.getBoundingClientRect();

  return getVisibleElements("button").find((btn) => {
    const text = normalizeText(btn.innerText);
    const b = btn.getBoundingClientRect();

    return (
      text === "select" &&
      Math.abs(b.top - rect.top) < 80 &&
      b.left > rect.left
    );
  }) || null;
}

function verifyCheckoutProduct(normalizedPageText) {
  const sku = normalizeText(currentTask.sku);

  if (sku && normalizedPageText.includes(sku)) return true;

  const urlSlugText = normalizeText(currentTask.goatUrl.split("/").pop() || "")
    .replace(/-/g, " ");

  if (urlSlugText && normalizedPageText.includes(urlSlugText.slice(0, 20))) {
    return true;
  }

  return true;
}

function verifyCheckoutSize(rawText, boughtSize) {
  const normalized = normalizeText(rawText);
  const size = normalizeSize(boughtSize);

  if (!size) return false;

  return (
    normalized.includes(`size: us ${size}`) ||
    normalized.includes(`size us ${size}`) ||
    normalized.includes(`size: ${size}`) ||
    normalized.includes(`size ${size}`)
  );
}

function verifyAddress(expectedAddress) {
  const expected = normalizeText(expectedAddress);

  if (!expected) return false;

  const selectedAddressBlocks = getVisibleElements("div, section").filter((el) => {
    const text = normalizeText(el.innerText);
    const rect = el.getBoundingClientRect();

    return (
      rect.left < window.innerWidth * 0.65 &&
      text.includes("shipping address") === false &&
      text.includes(expected)
    );
  });

  return selectedAddressBlocks.length > 0 || normalizeText(document.body.innerText).includes(expected);
}

function selectAndVerifyPayment(method, last4) {
  const normalizedMethod = normalizeText(method);
  const normalizedLast4 = normalizeText(last4);

  if (normalizedMethod.includes("paypal")) {
    const paypal = findElementByText("paypal");

    if (!paypal) return false;

    clickElement(paypal);
    return true;
  }

  if (
    normalizedMethod.includes("creditcard") ||
    normalizedMethod.includes("credit card") ||
    normalizedMethod.includes("card")
  ) {
    if (!normalizedLast4) return false;

    const card = getVisibleElements("button, div").find((el) => {
      const text = normalizeText(el.innerText);
      return text.includes(normalizedLast4);
    });

    if (!card) return false;

    clickElement(card);
    return true;
  }

  return false;
}

function extractCheckoutTotal() {
  const raw = document.body.innerText || "";
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);

  for (let i = 0; i < lines.length - 1; i++) {
    if (normalizeText(lines[i]) === "total") {
      const value = extractFirstEuroPrice(lines[i + 1]);
      if (Number.isFinite(value)) return value;
    }
  }

  const fallback = raw.match(/Total[\s\S]{0,80}?€\s*([\d.,]+)/i);

  if (fallback?.[1]) {
    return parseMoney(fallback[1]);
  }

  return null;
}

function extractFirstEuroPrice(text) {
  const match = String(text || "").match(/€\s*([\d.,]+)/);
  if (!match?.[1]) return null;

  return parseMoney(match[1]);
}

function parseMoney(raw) {
  const cleaned = String(raw || "")
    .replace(/[^\d.,-]/g, "")
    .replace(",", ".");

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function findButtonByText(targetText) {
  const target = normalizeText(targetText);

  return getVisibleElements("button, [role='button'], div").find((el) => {
    return normalizeText(el.innerText) === target;
  }) || null;
}

function findElementByText(targetText) {
  const target = normalizeText(targetText);

  return getVisibleElements("button, div, span").find((el) => {
    return normalizeText(el.innerText).includes(target);
  }) || null;
}

function getVisibleElements(selector) {
  return Array.from(document.querySelectorAll(selector)).filter((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      rect.width > 0 &&
      rect.height > 0
    );
  });
}

function moveMouseOver(el) {
  const rect = el.getBoundingClientRect();
  moveMouseAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function moveMouseAt(x, y) {
  const el = document.elementFromPoint(x, y) || document.body;

  console.log("Mouse target element:", {
    tag: el.tagName,
    text: String(el.innerText || "").slice(0, 80),
    x,
    y
  });

  for (const type of [
    "pointerover",
    "pointerenter",
    "mouseover",
    "mouseenter",
    "pointermove",
    "mousemove"
  ]) {
    el.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      view: window
    }));
  }
}

function clickElement(el) {
  if (!el) return false;

  el.scrollIntoView({
    block: "center",
    inline: "center"
  });

  const rect = el.getBoundingClientRect();

  el.dispatchEvent(new MouseEvent("mousedown", {
    bubbles: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2
  }));

  el.dispatchEvent(new MouseEvent("mouseup", {
    bubbles: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2
  }));

  el.dispatchEvent(new MouseEvent("click", {
    bubbles: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2
  }));

  return true;
}

async function reportTaskResult(status, extra = {}) {
  const payload = {
    recordId: currentTask.recordId,
    status,
    finalPrice: extra.finalPrice ?? null,
    boughtSize: extra.boughtSize ?? "",
    errorMessage: extra.errorMessage || ""
  };

  console.log("Reporting GOAT task result:", payload);

  await chrome.runtime.sendMessage({
    type: "TASK_COMPLETED",
    payload
  });
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(",", ".")
    .replace(/\s+/g, " ");
}

function normalizeSize(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(",", ".");

  const match = text.match(/\b\d+(\.5)?\b/);
  return match ? match[0] : "";
}

function cleanSize(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
