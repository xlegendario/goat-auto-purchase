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

async function runGoatFlow() {
  if (!currentTask) return;

  console.log("Starting GOAT purchase flow:", currentTask);

  if (!window.location.pathname.includes("/sneakers/")) {
    window.location.href = sanitizeGoatUrl(currentTask.goatUrl);
    return;
  }

  await handleProductPage();
}

async function handleProductPage() {
  await sleep(2000);

  const sizeType = await detectGoatSizeType();
  const targetSize = resolveTargetSize(sizeType, currentTask.sizeMap);

  console.log("Target size:", targetSize);

  await openPreferencesAndSelect(targetSize);
}

async function detectGoatSizeType() {
  const label = [...document.querySelectorAll("button, div, span")]
    .find(el => el.innerText.includes("US"));

  const text = label?.innerText.toLowerCase() || "";

  if (text.includes("women")) return "US Women's Size";
  if (text.includes("youth")) return "US Youth Size";
  if (text.includes("men")) return "US Men's Size";

  return "US Men's Size";
}

function resolveTargetSize(type, map) {
  if (type.includes("Women")) return map.usWomensSize;
  if (type.includes("Youth")) return map.usGsSize;
  return map.usSize;
}

/* ========================= */
/* 🔥 FIXED PREFERENCES FLOW */
/* ========================= */

async function openPreferencesAndSelect(size) {
  console.log("Opening size preferences...");

  // open panel
  document.body.dispatchEvent(new MouseEvent("mousemove", {
    bubbles: true,
    clientX: window.innerWidth * 0.5,
    clientY: window.innerHeight * 0.9
  }));

  await sleep(1000);

  const label = findSizeLabel();
  if (!label) {
    console.log("Label not found");
    return;
  }

  label.click();
  await sleep(1000);

  const modal = findModal();
  if (!modal) {
    console.log("Modal not found");
    return;
  }

  /* ===== CATEGORY ===== */

  const category = getCategoryFromLabel(label.innerText);
  console.log("Category should be:", category);

  const categoryBtn = [...modal.querySelectorAll("button, div, span")]
    .find(el => el.innerText.trim().toLowerCase() === category.toLowerCase());

  if (categoryBtn) {
    console.log("Clicking category:", category);
    categoryBtn.click();
  } else {
    console.log("Category already selected or not found");
  }

  await sleep(500);

  /* ===== US ===== */

  const usBtn = [...modal.querySelectorAll("button, div, span")]
    .find(el => el.innerText.trim().toLowerCase() === "us");

  if (usBtn) {
    console.log("Clicking US");
    usBtn.click();
  }

  await sleep(500);

  /* ===== SIZE ===== */

  const sizeBtn = [...modal.querySelectorAll("button, div, span")]
    .find(el => el.innerText.trim() === String(size));

  if (sizeBtn) {
    console.log("Clicking size:", size);
    sizeBtn.click();
  } else {
    console.log("SIZE NOT FOUND:", size);
    return;
  }

  await sleep(500);

  /* ===== SAVE ===== */

  const saveBtn = [...modal.querySelectorAll("button")]
    .find(el => el.innerText.toLowerCase().includes("save"));

  if (saveBtn) {
    console.log("Clicking save");
    saveBtn.click();
  } else {
    console.log("Save button not found");
  }
}

/* ========================= */

function findModal() {
  return [...document.querySelectorAll("div")]
    .find(el => el.innerText.includes("Size Preferences"));
}

function findSizeLabel() {
  return [...document.querySelectorAll("button, div, span")]
    .find(el =>
      el.innerText.includes("US") &&
      el.innerText.toLowerCase().includes("size")
    );
}

function getCategoryFromLabel(text) {
  text = text.toLowerCase();

  if (text.includes("women")) return "Women";
  if (text.includes("youth")) return "Youth";
  if (text.includes("men")) return "Men";
  if (text.includes("infant")) return "Infant";

  return "Men";
}

/* ========================= */

function sanitizeGoatUrl(url) {
  if (url.startsWith("//")) {
    return "https://www.goat.com" + url.slice(1);
  }
  return url;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function reportTaskResult(status, extra = {}) {
  console.log("Result:", status, extra);
}
