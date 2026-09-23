// HTML → PDF with headless Chromium (playwright-core).
// The browser is launched lazily and reused; each render gets its own isolated
// context with JavaScript disabled and all network requests blocked (the report
// is fully self-contained, so nothing needs to be fetched).

import { chromium } from "playwright-core";

let browserPromise = null;

function launch() {
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  return chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = launch().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  const browser = await browserPromise;
  if (!browser.isConnected()) {
    browserPromise = null;
    return getBrowser();
  }
  return browser;
}

const escFooter = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Same interface as renderPdfDoc (server/pdf-doc.js); only `html` and the
 * footer labels are used here.
 * @param {{ html: string, footer?: string, pageLabel?: string, ofLabel?: string }} ctx
 * @returns {Promise<Buffer>}
 */
export async function renderPdf({ html, footer = "", pageLabel = "Page", ofLabel = "of" }) {
  const browser = await getBrowser();
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    await context.route("**/*", (route) => {
      const url = route.request().url();
      return url.startsWith("data:") ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 20000 });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `<div style="font-size:7px;width:100%;padding:0 16mm;color:#56647a;display:flex;justify-content:space-between;font-family:Arial,sans-serif;"><span>${escFooter(footer)}</span><span>${escFooter(pageLabel)} <span class="pageNumber"></span> ${escFooter(ofLabel)} <span class="totalPages"></span></span></div>`,
      margin: { top: "16mm", bottom: "20mm", left: "14mm", right: "14mm" },
    });
  } finally {
    await context.close();
  }
}

export async function closePdf() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    if (b) await b.close();
  }
}
