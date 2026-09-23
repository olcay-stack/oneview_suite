// Renders the privacy notice from i18n (keeps all visible strings in i18n/*.json).
import { lookup } from "./i18n.js";

const lang = document.documentElement.dataset.lang === "nl" ? "nl" : "en";
const dict = await fetch(`/i18n/${lang}.json`).then((r) => r.json());
document.title = lookup(dict, "privacy.title");
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = lookup(dict, el.dataset.i18n);
const box = document.getElementById("privacy-sections");
for (const s of lookup(dict, "privacy.sections")) {
  const h2 = document.createElement("h2");
  h2.textContent = s.h;
  const p = document.createElement("p");
  p.textContent = s.p;
  box.append(h2, p);
}
