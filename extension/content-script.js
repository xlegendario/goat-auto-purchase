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
  const marker = await chrome.storage.local.get(["lastGoatPreferenceTask"]);
  if (marker.lastGoatPreferenceTask !== currentTask.recordId) {
    await chrome.storage.local.remove(["goatPreferenceSetForProduct", "goatResolvedPreference"]);
    await chrome.storage.local.set({ lastGoatPreferenceTask: currentTask.recordId });
  }

  if (window.location.pathname.includes("/checkout")) {
    await handleCheckoutPage();
    return;
  }

  if (window.location.pathname.includes("/account/preferences")) {
    await handlePreferencesPage();
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

  const prefData = await chrome.storage.local.get(["goatPreferenceSetForProduct"]);
  const alreadyReturned = prefData.goatPreferenceSetForProduct === currentTask.recordId;
  
  if (!alreadyReturned) {
    const sizeType = await detectGoatSizeType();
    const targetSize = resolveTargetSize(sizeType, currentTask.sizeMap);
    const category = sizeTypeToCategory(sizeType);
  
    if (!targetSize || !category) {
      await reportTaskResult("SIZE_NOT_FOUND", {
        errorMessage: `Could not resolve GOAT preference. sizeType=${sizeType}, targetSize=${targetSize}`,
        boughtSize: ""
      });
      return;
    }
  
    await chrome.storage.local.set({
      goatResolvedPreference: {
        recordId: currentTask.recordId,
        sizeType,
        category,
        targetSize,
        returnedFromPreferences: false
      }
    });
  
    console.log("Going to GOAT preferences page every run:", {
      sizeType,
      category,
      targetSize
    });
  
    window.location.href = "https://www.goat.com/account/preferences";
    return;
  }
  
  const targetSize = resolved.targetSize;
  
  console.log("Returned from preferences. Opening product size panel:", resolved);

  const opened = await openSizePanel();

  if (!opened) {
    await reportTaskResult("SIZE_NOT_FOUND", {
      errorMessage: "Could not open GOAT size panel after preferences save",
      boughtSize: targetSize
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

  const estimatedTotal = bestPrice.price + 15;

  if (estimatedTotal > Number(currentTask.maxBuyingPrice)) {
    await reportTaskResult("NO_VALID_PRICE", {
      errorMessage: `Best Price ${bestPrice.price} + shipping 15 = ${estimatedTotal} exceeds max ${currentTask.maxBuyingPrice}`,
      finalPrice: estimatedTotal,
      boughtSize: targetSize
    });
    return;
  }

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
}

async function handlePreferencesPage() {
  await waitForPageReady();

  if (await stopIfNeeded("preferences page")) return;

  const prefData = await chrome.storage.local.get(["goatResolvedPreference"]);
  const resolved = prefData.goatResolvedPreference;

  if (!resolved || resolved.recordId !== currentTask.recordId) {
    window.location.href = currentTask.goatUrl;
    return;
  }

  console.log("Setting GOAT account preferences:", resolved);

  const categoryOk = clickPreferencePageOption(
    resolved.category,
    "what category do you shop for most often"
  );

  await sleep(700);

  const usOk = clickPreferencePageOption(
    "US",
    "what size chart do you prefer"
  );

  await sleep(700);

  const sizeOk = clickPreferencePageOption(
    resolved.targetSize,
    "which size fits you best"
  );

  await sleep(700);

  if (!categoryOk || !usOk || !sizeOk) {
    await reportTaskResult("SIZE_NOT_FOUND", {
      errorMessage: `Could not set preferences. category=${categoryOk}, US=${usOk}, size=${sizeOk}`,
      boughtSize: resolved.targetSize
    });
    return;
  }

  const saveButton = findPreferenceSaveButton();

  if (!saveButton) {
    await reportTaskResult("PURCHASE_FAILED", {
      errorMessage: "SAVE button not found on GOAT preferences page",
      boughtSize: resolved.targetSize
    });
    return;
  }

  clickElement(saveButton);

  await chrome.storage.local.set({
    goatPreferenceSetForProduct: currentTask.recordId
  });

  await sleep(2500);

  window.location.href = currentTask.goatUrl;
}

function findPreferenceSaveButton() {
  const candidates = getVisibleElements("button, [role='button'], div, span")
    .filter((el) => normalizeText(el.innerText) === "save")
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (ar.width * ar.height) - (br.width * br.height);
    });

  return candidates[0] || null;
}

function clickPreferencePageOption(value, headingText) {
  const section = findPreferenceSection(headingText);

  if (!section) {
    console.log("Preference section not found:", headingText);
    return false;
  }

  const targetText = normalizeText(value);
  const targetSize = normalizeSize(value);

  const candidates = Array.from(section.querySelectorAll("button, label, div, span"))
    .filter(isVisible)
    .map((el) => {
      const rect = el.getBoundingClientRect();

      return {
        el,
        text: normalizeText(el.innerText),
        size: normalizeSize(el.innerText),
        area: rect.width * rect.height
      };
    })
    .filter((item) => {
      if (targetSize) return item.size === targetSize && item.area < 5000;
      return item.text === targetText && item.area < 5000;
    })
    .sort((a, b) => a.area - b.area);

  if (!candidates.length) {
    console.log("Preference option not found:", { value, headingText });
    return false;
  }

  console.log("Clicking preference option:", {
    value,
    headingText,
    text: candidates[0].el.innerText
  });

  clickElementAtCenter(candidates[0].el);
  return true;
}

function findPreferenceSection(headingText) {
  const target = normalizeText(headingText);

  const headings = getVisibleElements("div, p, span, h1, h2, h3, h4")
    .filter((el) => normalizeText(el.innerText).includes(target))
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.top - br.top;
    });

  const heading = headings[0];
  if (!heading) return null;

  let el = heading;

  for (let i = 0; i < 6; i++) {
    if (!el?.parentElement) break;

    const text = normalizeText(el.parentElement.innerText);

    if (
      text.includes(target) &&
      (
        text.includes("men") ||
        text.includes("women") ||
        text.includes("us") ||
        /\b\d+(\.5)?\b/.test(text)
      )
    ) {
      return el.parentElement;
    }

    el = el.parentElement;
  }

  return heading.parentElement;
}

function sizeTypeToCategory(sizeType) {
  if (sizeType === "US Women's Size") return "Women";
  if (sizeType === "US Youth Size") return "Youth";
  if (sizeType === "US Infant Size") return "Infant";
  if (sizeType === "US Men's Size") return "Men";
  return null;
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

function clickAtPoint(x, y) {
  const el = document.elementFromPoint(x, y) || document.body;

  console.log("ClickAtPoint target:", {
    tag: el.tagName,
    text: String(el.innerText || "").slice(0, 80),
    x,
    y
  });

  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    const EventClass = type.startsWith("pointer") ? PointerEvent : MouseEvent;

    el.dispatchEvent(new EventClass(type, {
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

  if (typeof el.click === "function") {
    el.click();
  }
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);

  return (
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function findSizePreferenceLabel() {
  const wanted = [
    "us women's size",
    "us womens size",
    "us men's size",
    "us mens size",
    "us youth size",
    "us infant size"
  ];

  const matches = getVisibleElements("button, div, span").filter((el) => {
    const text = normalizeText(el.innerText);
    const rect = el.getBoundingClientRect();

    return (
      wanted.some((phrase) => text.includes(phrase)) &&
      rect.top > window.innerHeight * 0.35 &&
      rect.top < window.innerHeight * 0.8 &&
      rect.width > 40 &&
      rect.width < 400 &&
      rect.height > 10 &&
      rect.height < 80
    );
  });

  return matches.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();

    return (ar.width * ar.height) - (br.width * br.height);
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

  const patterns = [
    `size: us ${size}`,
    `size us ${size}`,
    `size: ${size}`,
    `size ${size}`,
    `size: us women's ${size}`,
    `size us women's ${size}`,
    `size: us womens ${size}`,
    `size us womens ${size}`,
    `size: us men's ${size}`,
    `size us men's ${size}`,
    `size: us mens ${size}`,
    `size us mens ${size}`,
    `size: us youth ${size}`,
    `size us youth ${size}`,
    `size: us infant ${size}`,
    `size us infant ${size}`
  ];

  return patterns.some((pattern) => normalized.includes(pattern));
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

function clickElementAtCenter(el) {
  if (!el) return false;

  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  clickAtPoint(x, y);
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
