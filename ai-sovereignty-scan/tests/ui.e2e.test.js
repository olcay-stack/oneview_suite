// Browser end-to-end: drives the real UI in Chromium, submits, and checks the
// emails that arrive at the local SMTP capture server.
// Screenshots go to $SCREENSHOT_DIR when set.
process.env.NODE_ENV = "test";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright-core";
import { createApp, loadKnowledgeBase } from "../server/index.js";
import { closePdf } from "../server/pdf.js";
import { startSmtpCapture } from "./helpers/smtp.js";

const SHOTS = process.env.SCREENSHOT_DIR;
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

let smtp, server, base, browser;

async function waitFor(pred, what, ms = 15_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  smtp = await startSmtpCapture();
  const app = createApp({ kb: loadKnowledgeBase(), mail: { cfg: smtp.cfg } });
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
});

after(async () => {
  await browser?.close();
  server?.close();
  await smtp?.close();
  await closePdf();
});

test("Dutch scan: validation, tool inventory, results, send report", { timeout: 120_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "nl-NL" });
  const page = await context.newPage();
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto(`${base}/nl/`);
  await page.waitForSelector("#step-title");
  assert.equal(await page.textContent("#step-title"), "Gegevens van uw organisatie");
  assert.equal(await page.getAttribute("html", "lang"), "nl");
  await shot(page, "01-start-nl");

  // Validation: empty required fields produce an error summary with links.
  await page.click("#btn-next");
  await page.waitForSelector("#error-summary");
  const errors = await page.locator("#error-summary li").allTextContents();
  assert.ok(errors.some((e) => e.includes("bedrijfsnaam")), errors.join("|"));
  assert.equal(await page.getAttribute("#f-name", "aria-invalid"), "true");
  assert.equal(await page.evaluate(() => document.activeElement.id), "error-summary");

  // Step 1 via keyboard where practical.
  await page.fill("#f-name", "Testbedrijf Utrecht B.V.");
  await page.fill("#f-email", "tester@example.nl");
  await page.fill("#f-contact", "Sanne de Vries");
  await page.selectOption("#f-sector", "logistics");
  await page.selectOption("#f-employees", "50-249");
  await page.focus("#f-consent");
  await page.keyboard.press("Space");
  await page.waitForTimeout(3100); // a human needs > 3 s (anti-bot timing check)
  await page.click("#btn-next");
  // Step-1 lead: company details are emailed to Oneview Logic straight away.
  await waitFor(() => smtp.messages.some((m) => m.mail.subject.includes("nieuwe lead")), "lead email");
  const lead = smtp.messages.find((m) => m.mail.subject.includes("nieuwe lead")).mail;
  assert.equal(lead.to.text, "info@oneviewlogic.com");
  assert.equal(lead.subject, "AI Sovereignty Scan – nieuwe lead – Testbedrijf Utrecht B.V.");
  assert.ok(lead.html.includes("Sanne de Vries") && lead.html.includes("tester@example.nl") && lead.html.includes("Logistiek"));
  assert.equal(lead.replyTo.text, "tester@example.nl");
  await page.waitForFunction(() => document.querySelector("#step-title")?.textContent === "Overzicht van AI-tools");
  assert.equal(await page.evaluate(() => document.activeElement.id), "step-title", "focus moves to the step heading");

  // Step 2: filter, select ChatGPT Free (shadow AI, customer data) + M365 Copilot.
  await page.fill("#tool-filter", "chatgpt");
  assert.equal(await page.isVisible("#card-openai-chatgpt"), true);
  assert.equal(await page.isVisible("#card-deepl-deepl"), false);
  await page.click("#toggle-openai-chatgpt");
  // Next without choosing a tier → error.
  await page.click("#btn-next");
  await page.waitForSelector("#error-summary");
  await page.check("#tier-openai-chatgpt-openai-chatgpt-free");
  await page.fill("#users-openai-chatgpt-free", "25");
  await page.check("#appr-openai-chatgpt-shadow");
  await page.check("#data-openai-chatgpt-customer_personal");
  await page.fill("#tool-filter", "");
  await page.click("#toggle-microsoft-m365_copilot");
  await page.check("#tier-microsoft-m365_copilot-microsoft-m365_copilot-business");
  await page.check("#res-microsoft-m365_copilot-no");
  await page.check("#appr-microsoft-m365_copilot-approved");
  await page.check("#data-microsoft-m365_copilot-internal_docs");
  await page.check("#data-microsoft-m365_copilot-employee");
  // Custom tool.
  await page.click("#btn-add-custom");
  await page.fill("#custom-c1-name", "InterneBot");
  await page.selectOption("#custom-c1-tier", "business");
  await page.check("#data-custom-c1-source_code");
  await shot(page, "02-tools-nl");
  await page.click("#btn-next");

  // Step 3: use cases.
  await page.waitForFunction(() => document.querySelector("#step-title")?.textContent === "Toepassingen");
  await page.check("#uc-recruitment_hr");
  await page.check("#uc-customer_chatbot");
  await page.click("#btn-next");

  // Step 4: governance — must answer all.
  await page.waitForFunction(() => document.querySelector("#step-title")?.textContent === "Governance");
  await page.click("#btn-next");
  await page.waitForSelector("#error-summary");
  for (const [q, a] of Object.entries({ ai_policy: "yes", ai_literacy: "no", ai_register: "partial", dpia: "no", dpo: "yes", vendor_dpas: "dk", human_oversight: "no" })) {
    await page.check(`#gov-${q}-${a}`);
  }
  await page.click("#btn-next");

  // Step 5: results.
  await page.waitForSelector(".gauge");
  assert.equal(await page.textContent("#step-title"), "Uw resultaten van de AI Sovereignty Scan");
  const gaugeLabel = await page.getAttribute(".gauge", "aria-label");
  assert.match(gaugeLabel, /Totale risicoscore: \d+ van de 100 — (Laag|Gemiddeld|Hoog|Kritiek)/);
  const rows = await page.locator("table.data tbody tr.tool-row").count();
  assert.equal(rows, 3);
  assert.equal(await page.locator(".actions-list li").count(), 5);
  // Sort by tool name (ascending) via keyboard-accessible button.
  await page.click("#sort-name");
  assert.equal(await page.getAttribute("th:has(#sort-name)", "aria-sort"), "ascending");
  const firstTool = await page.locator("table.data tbody tr th strong").first().textContent();
  assert.equal(firstTool, "ChatGPT Free");
  await shot(page, "03-results-nl");

  // No browser storage is used at any point.
  const storage = await page.evaluate(() => ({ ls: localStorage.length, ss: sessionStorage.length, cookie: document.cookie }));
  assert.deepEqual(storage, { ls: 0, ss: 0, cookie: "" });

  // Results are emailed to Oneview Logic automatically; the visitor gets a contact link, not a copy.
  await page.waitForSelector(".status-box.ok", { timeout: 60_000 });
  const success = await page.textContent(".status-box.ok");
  assert.ok(success.includes("info@oneviewlogic.com"), success);
  assert.match(await page.getAttribute("#btn-contact", "href"), /^mailto:info@oneviewlogic\.com\?subject=/);
  assert.equal(await page.isVisible("#f-copy"), false);
  await shot(page, "04-sent-nl");

  // Sorting / re-rendering must not send the results again.
  await page.click("#sort-total");
  await page.waitForTimeout(300);

  const results = smtp.messages.filter((m) => /^AI Sovereignty Scan – Testbedrijf/.test(m.mail.subject));
  assert.equal(results.length, 1, "exactly one results email");
  assert.equal(smtp.messages.length, 2, "lead + results, no copy to the visitor");
  assert.ok(!smtp.messages.some((m) => m.mail.to.text === "tester@example.nl"));
  const internal = results[0].mail;
  assert.equal(internal.to.text, "info@oneviewlogic.com");
  assert.match(internal.subject, /^AI Sovereignty Scan – Testbedrijf Utrecht B\.V\. – (Laag|Gemiddeld|Hoog|Kritiek) \(\d+\)$/);
  assert.equal(internal.attachments[0].content.subarray(0, 5).toString(), "%PDF-");

  // "Start a new scan" clears every answer from memory.
  await page.click("#btn-restart");
  assert.equal(await page.inputValue("#f-name"), "");

  assert.ok(internal.html.includes("InterneBot"));
  assert.ok(internal.html.includes("Sanne de Vries"));
  assert.ok(internal.text.startsWith("Testbedrijf Utrecht B.V. (Logistics, 50-249 employees, NL) scored"));
  // The score shown in the UI equals the server-computed score in the email.
  const uiScore = gaugeLabel.match(/: (\d+) /)[1];
  assert.ok(internal.subject.endsWith(`(${uiScore})`), `${internal.subject} vs UI ${uiScore}`);

  assert.deepEqual(problems, [], "no console errors / CSP violations");
  await context.close();
});

test("English page on a phone: layout fits, language switch, no horizontal scroll", { timeout: 60_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  await page.goto(`${base}/en/`);
  await page.waitForSelector("#step-title");
  assert.equal(await page.textContent("#step-title"), "Company information");
  assert.equal(await page.getAttribute('[data-lang-link="en"]', "aria-current"), "true");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
  await shot(page, "05-mobile-en");
  await page.click('[data-lang-link="nl"]');
  await page.waitForURL(/\/nl\/$/);
  await page.waitForSelector("#step-title");
  assert.equal(await page.textContent("#step-title"), "Gegevens van uw organisatie");
  await page.goto(`${base}/nl/privacy.html`);
  assert.equal(await page.textContent("h1"), "Privacyverklaring — AI Sovereignty Scan");
  assert.deepEqual(problems, []);
  await context.close();
});
