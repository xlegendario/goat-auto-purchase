async function searchGoatProductBySku(sku) {
  const searchText = String(sku || "").trim();

  if (!searchText) {
    throw new Error("Missing SKU for GOAT search fallback");
  }

  const searchButton = getVisibleElements("button, div, span, a")
    .find((el) => normalizeText(el.innerText || el.textContent) === "search");

  if (!searchButton) {
    throw new Error("GOAT search button not found");
  }

  clickElement(searchButton);
  await sleep(800);

  const searchInput =
    Array.from(document.querySelectorAll("input")).find((input) => {
      const rect = input.getBoundingClientRect();

      return (
        isVisible(input) &&
        rect.top < 150 &&
        rect.left < window.innerWidth * 0.4 &&
        rect.width > 150
      );
    });

  if (!searchInput) {
    throw new Error("GOAT search input not found");
  }

  searchInput.focus();

  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;

  if (!setter) {
    throw new Error("Could not set GOAT search input value");
  }

  setter.call(searchInput, searchText);

  searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  searchInput.dispatchEvent(new Event("change", { bubbles: true }));

  await sleep(2000);

  /*
   * Zoek de witte GOAT search-overlay.
   * We mogen NIET meer globaal over alle sneakerlinks op de homepage zoeken.
   */
  const overlayCandidates = getVisibleElements("div, section")
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      return {
        el,
        rect,
        backgroundColor: style.backgroundColor,
        area: rect.width * rect.height
      };
    })
    .filter((item) => {
      const { rect, backgroundColor } = item;

      const isWhite =
        backgroundColor === "rgb(255, 255, 255)" ||
        backgroundColor === "rgba(255, 255, 255, 1)";

      return (
        isWhite &&
        rect.left < 80 &&
        rect.top < 120 &&
        rect.width > 250 &&
        rect.width < 700 &&
        rect.height > 150 &&
        rect.height < 900
      );
    })
    .sort((a, b) => a.area - b.area);

  if (!overlayCandidates.length) {
    throw new Error(
      `GOAT search fallback: search overlay not found for SKU ${searchText}`
    );
  }

  const overlay = overlayCandidates[0].el;
  const overlayRect = overlay.getBoundingClientRect();

  console.log("GOAT search overlay found:", {
    sku: searchText,
    rect: {
      left: overlayRect.left,
      top: overlayRect.top,
      width: overlayRect.width,
      height: overlayRect.height
    }
  });

  /*
   * CRITICAL:
   * alleen sneakerlinks BINNEN de witte search-overlay.
   */
  const productLinks = Array.from(
    overlay.querySelectorAll('a[href*="/sneakers/"]')
  )
    .filter(isVisible)
    .map((a) => {
      const rect = a.getBoundingClientRect();
      const img = a.querySelector("img");

      return {
        el: a,
        href: a.href,
        text: normalizeText(a.innerText || a.textContent),
        rect,
        hasImage: !!img,
        area: rect.width * rect.height
      };
    })
    .filter((item) => {
      return (
        item.hasImage &&
        item.href &&
        item.href.includes("/sneakers/") &&
        item.rect.left >= overlayRect.left &&
        item.rect.right <= overlayRect.right + 5 &&
        item.rect.top >= overlayRect.top &&
        item.rect.bottom <= overlayRect.bottom + 5
      );
    })
    .sort((a, b) => {
      /*
       * Het echte sneakerresultaat staat onder de suggestion chips.
       * Daarom geven we het onderste resultaat voorrang.
       */
      if (a.rect.top !== b.rect.top) {
        return b.rect.top - a.rect.top;
      }

      return a.area - b.area;
    });

  console.log(
    "GOAT search product links INSIDE overlay:",
    productLinks.map((item) => ({
      href: item.href,
      text: item.text,
      rect: {
        left: item.rect.left,
        top: item.rect.top,
        width: item.rect.width,
        height: item.rect.height
      }
    }))
  );

  if (!productLinks.length) {
    throw new Error(
      `GOAT search fallback: no sneaker result inside search overlay for SKU ${searchText}`
    );
  }

  const productLink = productLinks[0];
  const targetUrl = productLink.href;

  if (!targetUrl || !targetUrl.includes("/sneakers/")) {
    throw new Error(
      `GOAT search fallback found invalid product URL for SKU ${searchText}: ${targetUrl}`
    );
  }

  console.log("Opening GOAT search result from overlay:", {
    sku: searchText,
    href: targetUrl,
    text: productLink.text
  });

  /*
   * Bewaar de gevonden URL.
   * Dit is GOAT AUTO PURCHASE, dus de storage key blijft currentTask.
   */
  currentTask.goatUrl = targetUrl;
  currentTask.useGoatSearchFallback = false;

  await chrome.storage.local.set({
    currentTask
  });

  window.location.href = targetUrl;
}
