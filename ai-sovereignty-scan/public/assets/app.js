// AI Sovereignty Scan — frontend (vanilla JS, no build step).
// All answers live in memory only (no cookies / localStorage / sessionStorage)
// and are wiped after a successful submit. All visible strings come from
// /i18n/<lang>.json; all vendor facts from /data/*.json.

import { assess, indexKnowledgeBase, GOVERNANCE_QUESTIONS, DATA_TYPES, bandFor } from "./scoring.js";
import { t, lookup, interpolate, fmtDate, formatReason, formatAction, formatFinding, tierTypeLabel } from "./i18n.js";

const LANG = document.documentElement.dataset.lang === "nl" ? "nl" : "en";
const STEPS = ["company", "tools", "usecases", "governance", "results"];
const TIER_TYPES = ["free", "personal_paid", "business", "enterprise", "api", "self_hosted"];
const SECTORS = ["manufacturing", "logistics", "healthcare", "finance", "public", "education", "retail", "it", "legal", "energy", "construction", "other"];
const SIZES = ["1-9", "10-49", "50-249", "250-999", "1000+"];
const COUNTRIES = ["NL", "BE", "DE", "FR", "LU", "AT", "DK", "ES", "IE", "IT", "PL", "SE", "FI", "PT", "OTHER_EU", "NON_EU"];
const BAND_ICON = { low: "●", medium: "▲", high: "◆", critical: "✖" };
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()\-./]{6,24}$/;

let I18N, TOOLS, REG, KB, CONFIG;
let state;

function freshState() {
  return {
    step: 0,
    maxStep: 0,
    startedAt: Date.now(),
    company: { name: "", email: "", contact: "", jobTitle: "", phone: "", country: "NL", website: "", sector: "", employees: "" },
    consent: false,
    hp: "",
    products: {}, // productKey -> { tiers: {tierId: users}, residency, dataTypes: [], approval }
    custom: [], // { key, name, tierType, users, residency, dataTypes, approval }
    useCases: [],
    governance: {},
    sendCopy: false,
    errors: [],
    sort: { key: "total", dir: "desc" },
    filter: "",
    submit: { status: "idle", message: "" },
  };
}

// ── Tiny DOM helper (always textContent, never innerHTML) ────────────────────
function h(tag, props = {}, ...children) {
  const el = tag === "svg" || props.svg ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false || k === "svg") continue;
    if (k === "class") el.setAttribute("class", v);
    else if (k === "text") el.textContent = v;
    else if (k === "style") Object.assign(el.style, v); // CSSOM, allowed under a strict CSP
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "checked" || k === "value" || k === "selected") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const svg = (tag, props = {}, ...c) => h(tag, { ...props, svg: true }, ...c);
const tr = (key, params) => t(I18N, key, params);
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "-");

// ── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  const app = document.getElementById("app");
  try {
    const [i18n, tools, reg, config] = await Promise.all([
      fetch(`/i18n/${LANG}.json`).then((r) => r.json()),
      fetch("/data/tools.json").then((r) => r.json()),
      fetch("/data/regulation.json").then((r) => r.json()),
      fetch("/api/config").then((r) => (r.ok ? r.json() : { copyToClient: false })).catch(() => ({ copyToClient: false })),
    ]);
    I18N = i18n;
    TOOLS = tools;
    REG = reg;
    CONFIG = config;
    KB = indexKnowledgeBase(tools);
  } catch (e) {
    app.textContent = "Could not load the scan. Please reload the page. / De scan kon niet worden geladen. Herlaad de pagina.";
    app.removeAttribute("aria-busy");
    return;
  }
  state = freshState();
  applyStaticI18n();
  render();
  app.removeAttribute("aria-busy");
}

function applyStaticI18n() {
  document.title = lookup(I18N, "meta.title");
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.setAttribute("content", lookup(I18N, "meta.description"));
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = lookup(I18N, el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-attr]")) {
    const [attr, key] = el.dataset.i18nAttr.split(":");
    el.setAttribute(attr, lookup(I18N, key));
  }
  const points = document.getElementById("hero-points");
  if (points) {
    const tierCount = [...KB.keys()].filter((id) => !id.startsWith("custom.")).length;
    points.replaceChildren(
      ...lookup(I18N, "hero.points").map((p) => h("li", { text: interpolate(p, { tools: tierCount }) })),
      h("li", { text: tr("hero.as_of", { date: fmtDate(TOOLS.meta.as_of, LANG) }) }),
    );
  }
  for (const a of document.querySelectorAll("[data-lang-link]")) {
    if (a.dataset.langLink === LANG) a.setAttribute("aria-current", "true");
    a.addEventListener("click", (e) => {
      if (a.dataset.langLink !== LANG && isDirty() && !window.confirm(lookup(I18N, "header.lang_switch_confirm"))) e.preventDefault();
    });
  }
}

function isDirty() {
  return state && (state.company.name || state.company.email || Object.keys(state.products).length || state.custom.length || state.useCases.length);
}

// ── Rendering ───────────────────────────────────────────────────────────────
function render({ focus } = {}) {
  const app = document.getElementById("app");
  const activeId = document.activeElement && document.activeElement.id;
  const stepName = STEPS[state.step];
  const body = { company: renderCompany, tools: renderTools, usecases: renderUseCases, governance: renderGovernance, results: renderResults }[stepName]();
  app.replaceChildren(renderProgress(), body);
  document.querySelector(".hero")?.classList.toggle("compact", state.step > 0);

  if (focus === "heading") document.getElementById("step-title")?.focus();
  else if (focus === "errors") document.getElementById("error-summary")?.focus();
  else if (focus) document.getElementById(focus)?.focus();
  else if (activeId && document.getElementById(activeId)) document.getElementById(activeId).focus();
}

function renderProgress() {
  return h(
    "nav",
    { class: "progress", "aria-label": tr("progress.label") },
    h(
      "ol",
      {},
      STEPS.map((s, i) => {
        const cls = i < state.step ? "done" : i === state.step ? "current" : "";
        const reachable = i <= state.maxStep && i !== state.step && state.submit.status !== "sent";
        return h(
          "li",
          { class: cls },
          h(
            "button",
            {
              type: "button",
              class: "step-btn",
              id: `progress-${s}`,
              "data-reachable": String(reachable),
              "aria-current": i === state.step ? "step" : undefined,
              "aria-disabled": reachable ? undefined : "true",
              onClick: () => reachable && goTo(i),
            },
            h("span", { class: "bar", "aria-hidden": "true" }),
            h("span", { class: "label", text: `${i + 1}. ${tr(`progress.steps.${s}`)}` }),
          ),
        );
      }),
    ),
    h("p", { class: "step-of", text: tr("progress.step_of", { n: state.step + 1, total: STEPS.length }) }),
  );
}

function stepPanel(titleKey, introKey, ...content) {
  return h(
    "section",
    { class: "panel", "aria-labelledby": "step-title" },
    h("h2", { id: "step-title", class: "step-title", tabindex: "-1", text: tr(titleKey) }),
    introKey ? h("p", { class: "intro", text: tr(introKey) }) : null,
    renderErrorSummary(),
    ...content,
  );
}

function renderErrorSummary() {
  if (!state.errors.length) return null;
  return h(
    "div",
    { class: "error-summary", id: "error-summary", tabindex: "-1", role: "alert" },
    h("h3", { text: tr("form.error_summary") }),
    h("ul", {}, state.errors.map((e) => h("li", {}, h("a", { href: `#${e.field}`, text: e.msg, onClick: (ev) => { ev.preventDefault(); document.getElementById(e.field)?.focus(); } })))),
  );
}

const errorFor = (field) => state.errors.find((e) => e.field === field);

function navButtons({ nextLabel = "nav.next", onNext, back = true } = {}) {
  return h(
    "div",
    { class: "step-nav" },
    back ? h("button", { type: "button", class: "btn secondary", id: "btn-back", text: `← ${tr("nav.back")}`, onClick: () => goTo(state.step - 1) }) : h("span", { class: "spacer" }),
    h("button", { type: "button", class: "btn", id: "btn-next", text: `${tr(nextLabel)} →`, onClick: onNext || next }),
  );
}

// ── Step 1: company ─────────────────────────────────────────────────────────
function textField(key, { type = "text", required = false, autocomplete, hint, inputmode } = {}) {
  const id = `f-${key}`;
  const err = errorFor(id);
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = err ? `${id}-err` : undefined;
  return h(
    "div",
    { class: "field" },
    h("label", { for: id }, tr(`company.${key === "jobTitle" ? "job_title" : key}`), required ? h("span", { class: "req", "aria-hidden": "true", text: " *" }) : null),
    hint ? h("span", { class: "hint", id: hintId, text: tr(hint) }) : null,
    h("input", {
      id,
      name: key,
      type,
      value: state.company[key],
      required: required || undefined,
      "aria-required": required ? "true" : undefined,
      autocomplete,
      inputmode,
      maxlength: key === "website" ? "200" : "120",
      "aria-invalid": err ? "true" : undefined,
      "aria-describedby": [hintId, errId].filter(Boolean).join(" ") || undefined,
      onInput: (e) => (state.company[key] = e.target.value),
    }),
    err ? h("span", { class: "error-msg", id: errId, text: err.msg }) : null,
  );
}

function selectField(key, options, labelPrefix, placeholderKey) {
  const id = `f-${key}`;
  return h(
    "div",
    { class: "field" },
    h("label", { for: id, text: tr(`company.${key}`) }),
    h(
      "select",
      { id, name: key, onChange: (e) => (state.company[key] = e.target.value) },
      placeholderKey ? h("option", { value: "", text: tr(placeholderKey) }) : null,
      options.map((o) => h("option", { value: o, selected: state.company[key] === o, text: tr(`${labelPrefix}.${o}`) })),
    ),
  );
}

function renderCompany() {
  const consentErr = errorFor("f-consent");
  const privacyHref = `/${LANG}/privacy.html`;
  return stepPanel(
    "company.title",
    "company.intro",
    h(
      "form",
      { novalidate: true, onSubmit: (e) => { e.preventDefault(); next(); } },
      h(
        "div",
        { class: "grid-2" },
        textField("name", { required: true, autocomplete: "organization" }),
        textField("email", { type: "email", required: true, autocomplete: "email", hint: "company.email_hint" }),
        textField("contact", { autocomplete: "name" }),
        textField("jobTitle", { autocomplete: "organization-title" }),
        textField("phone", { type: "tel", autocomplete: "tel", hint: "company.phone_hint", inputmode: "tel" }),
        selectField("country", COUNTRIES, "company.countries"),
        textField("website", { type: "url", autocomplete: "url", inputmode: "url" }),
        selectField("sector", SECTORS, "company.sectors", "company.sector_placeholder"),
        selectField("employees", SIZES, "company.sizes", "company.employees_placeholder"),
      ),
      // Honeypot: hidden from people and assistive tech; bots tend to fill it.
      h(
        "div",
        { class: "honeypot", "aria-hidden": "true" },
        h("label", { for: "f-fax", text: tr("company.honeypot") }),
        h("input", { id: "f-fax", name: "fax", type: "text", tabindex: "-1", autocomplete: "off", value: state.hp, onInput: (e) => (state.hp = e.target.value) }),
      ),
      h(
        "div",
        { class: "consent" },
        h(
          "div",
          { class: "check" },
          h("input", {
            type: "checkbox",
            id: "f-consent",
            checked: state.consent,
            "aria-required": "true",
            "aria-invalid": consentErr ? "true" : undefined,
            "aria-describedby": consentErr ? "f-consent-err" : undefined,
            onChange: (e) => (state.consent = e.target.checked),
          }),
          h("label", { for: "f-consent" }, tr("company.consent"), h("span", { class: "req", "aria-hidden": "true", text: " *" }), " ", h("a", { href: privacyHref, target: "_blank", rel: "noopener", text: tr("company.privacy_link") })),
        ),
        consentErr ? h("span", { class: "error-msg", id: "f-consent-err", text: consentErr.msg }) : null,
      ),
      h("button", { type: "submit", class: "visually-hidden", tabindex: "-1", text: tr("nav.next") }),
    ),
    navButtons({ back: false }),
  );
}

function validateCompany() {
  const c = state.company;
  const errs = [];
  for (const k of Object.keys(c)) c[k] = String(c[k]).trim();
  if (!c.name) errs.push({ field: "f-name", msg: tr("company.errors.name") });
  if (!EMAIL_RE.test(c.email) || c.email.length > 254) errs.push({ field: "f-email", msg: tr("company.errors.email") });
  if (c.phone && !PHONE_RE.test(c.phone)) errs.push({ field: "f-phone", msg: tr("company.errors.phone") });
  if (c.website && !/^(https?:\/\/)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+([/?#].*)?$/.test(c.website)) errs.push({ field: "f-website", msg: tr("company.errors.website") });
  if (!state.consent) errs.push({ field: "f-consent", msg: tr("company.errors.consent") });
  return errs;
}

// ── Step 2: tools ───────────────────────────────────────────────────────────
function productKey(v, p) {
  return `${v.id}.${p.id}`;
}

function radioGroup(name, legendText, options, value, onChange, { hint, labelPrefix } = {}) {
  const gid = safeId(name);
  return h(
    "fieldset",
    { "aria-describedby": hint ? `${gid}-hint` : undefined },
    h("legend", { text: legendText }),
    hint ? h("p", { class: "hint", id: `${gid}-hint`, text: hint }) : null,
    h(
      "div",
      { class: "options" },
      options.map((o) =>
        h(
          "label",
          { class: "opt" },
          h("input", { type: "radio", name: gid, id: `${gid}-${o}`, value: o, checked: value === o, onChange: () => onChange(o) }),
          tr(`${labelPrefix}.${o}`),
        ),
      ),
    ),
  );
}

function dataTypeGroup(key, cfg, toolName) {
  const gid = safeId(`data-${key}`);
  const err = errorFor(`${gid}-${DATA_TYPES[0]}`);
  return h(
    "fieldset",
    { class: "span-2" },
    h("legend", { text: tr("tools.data") }),
    h(
      "div",
      { class: "options" },
      DATA_TYPES.map((d) =>
        h(
          "label",
          { class: "opt" },
          h("input", {
            type: "checkbox",
            id: `${gid}-${d}`,
            checked: cfg.dataTypes.includes(d),
            "aria-invalid": err && d === DATA_TYPES[0] ? "true" : undefined,
            onChange: (e) => {
              cfg.dataTypes = e.target.checked ? [...cfg.dataTypes, d] : cfg.dataTypes.filter((x) => x !== d);
            },
          }),
          tr(`tools.data_types.${d}`),
        ),
      ),
    ),
    err ? h("span", { class: "error-msg", text: err.msg }) : null,
  );
}

function renderToolCard(v, p) {
  const key = productKey(v, p);
  const cfg = state.products[key];
  const selected = Boolean(cfg);
  const cardId = safeId(`card-${key}`);
  const toggle = h("button", {
    type: "button",
    class: "toggle",
    id: safeId(`toggle-${key}`),
    "aria-pressed": String(selected),
    "aria-label": `${selected ? tr("tools.selected") : tr("tools.select")}: ${p.name}`,
    text: selected ? tr("tools.selected") : tr("tools.select"),
    onClick: () => {
      if (selected) delete state.products[key];
      else state.products[key] = { tiers: {}, residency: "dk", dataTypes: [], approval: "dk" };
      state.errors = [];
      render();
    },
  });
  const card = h(
    "article",
    { class: `tool-card${selected ? " is-selected" : ""}`, id: cardId, "data-search": `${v.name} ${p.name} ${p.tiers.map((x) => x.name).join(" ")}`.toLowerCase() },
    h("div", { class: "tool-card-head" }, h("div", {}, h("h4", { text: p.name }), h("span", { class: "sub", text: `${v.name} · ${p.tiers.length} ${tr("tools.tiers").toLowerCase()}` })), toggle),
  );
  if (!selected) return card;

  const tierErr = errorFor(safeId(`tier-${key}-${p.tiers[0].id}`));
  const tierRows = p.tiers.map((tier) => {
    const cid = safeId(`tier-${key}-${tier.id}`);
    const uid = safeId(`users-${tier.id}`);
    const checked = tier.id in cfg.tiers;
    return h(
      "div",
      { class: "tier-row" },
      h(
        "div",
        { class: "check" },
        h("input", {
          type: "checkbox",
          id: cid,
          checked,
          "aria-invalid": tierErr && tier === p.tiers[0] ? "true" : undefined,
          onChange: (e) => {
            if (e.target.checked) cfg.tiers[tier.id] = cfg.tiers[tier.id] || 1;
            else delete cfg.tiers[tier.id];
            state.errors = state.errors.filter((x) => x.field !== cid && x.field !== safeId(`tier-${key}-${p.tiers[0].id}`));
            render();
          },
        }),
        h("label", { for: cid }, h("strong", { text: tier.name }), " ", h("span", { class: "hint", text: `(${tierTypeLabel(I18N, tier.tier_type)})` })),
      ),
      checked
        ? h(
            "div",
            { class: "users" },
            h("label", { for: uid, text: tr("tools.users") }),
            h("input", {
              type: "number",
              class: "input",
              id: uid,
              min: "1",
              max: "1000000",
              step: "1",
              inputmode: "numeric",
              value: String(cfg.tiers[tier.id]),
              "aria-label": tr("tools.users_for", { tier: tier.name }),
              onInput: (e) => (cfg.tiers[tier.id] = Math.max(1, Math.min(1000000, parseInt(e.target.value, 10) || 1))),
            }),
          )
        : h("span"),
      checked && tier.status === "conflicting" ? h("span", { class: "kb-note", text: tr("tools.kb_conflicting") }) : null,
      checked && tier.status !== "conflicting" && tier.unverified_fields.length ? h("span", { class: "kb-note", text: tr("tools.kb_unverified") }) : null,
    );
  });

  const chosen = Object.keys(cfg.tiers).map((id) => KB.get(id));
  const residencyRelevant = chosen.some((x) => x.eu_data_residency.storage === "optional" || x.eu_data_residency.inference === "optional");

  card.append(
    h(
      "div",
      { class: "tool-config" },
      h(
        "fieldset",
        { class: "span-2" },
        h("legend", { text: tr("tools.tiers") }),
        h("div", { class: "tier-list" }, tierRows),
        tierErr ? h("span", { class: "error-msg", text: tierErr.msg }) : null,
      ),
      residencyRelevant
        ? radioGroup(`res-${key}`, tr("tools.residency"), ["yes", "no", "dk"], cfg.residency, (o) => (cfg.residency = o), { hint: tr("tools.residency_hint"), labelPrefix: "tools.answers" })
        : null,
      radioGroup(`appr-${key}`, tr("tools.approval"), ["approved", "shadow", "dk"], cfg.approval, (o) => (cfg.approval = o), { labelPrefix: "tools.approval_options" }),
      dataTypeGroup(key, cfg, p.name),
    ),
  );
  return card;
}

function renderCustomTool(ct, i) {
  const base = `custom-${ct.key}`;
  const nameErr = errorFor(`${base}-name`);
  return h(
    "div",
    { class: "custom-tool" },
    h(
      "div",
      { class: "row" },
      h(
        "div",
        { class: "field" },
        h("label", { for: `${base}-name` }, tr("tools.custom.name"), h("span", { class: "req", "aria-hidden": "true", text: " *" })),
        h("input", {
          type: "text", id: `${base}-name`, value: ct.name, maxlength: "80", "aria-required": "true",
          "aria-invalid": nameErr ? "true" : undefined,
          onInput: (e) => (ct.name = e.target.value),
        }),
        nameErr ? h("span", { class: "error-msg", text: nameErr.msg }) : null,
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: `${base}-tier`, text: tr("tools.custom.tier") }),
        h(
          "select",
          { id: `${base}-tier`, onChange: (e) => (ct.tierType = e.target.value || null) },
          h("option", { value: "", text: tr("tools.custom.tier_placeholder") }),
          TIER_TYPES.map((tt) => h("option", { value: tt, selected: ct.tierType === tt, text: tr(`tools.tier_types.${tt}`) })),
        ),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: `${base}-users`, text: tr("tools.users") }),
        h("input", { type: "number", id: `${base}-users`, min: "1", max: "1000000", value: String(ct.users), inputmode: "numeric", onInput: (e) => (ct.users = Math.max(1, parseInt(e.target.value, 10) || 1)) }),
      ),
    ),
    radioGroup(`${base}-res`, tr("tools.residency"), ["yes", "no", "dk"], ct.residency, (o) => (ct.residency = o), { labelPrefix: "tools.answers" }),
    radioGroup(`${base}-appr`, tr("tools.approval"), ["approved", "shadow", "dk"], ct.approval, (o) => (ct.approval = o), { labelPrefix: "tools.approval_options" }),
    dataTypeGroup(base, ct, ct.name),
    h("div", {}, h("button", { type: "button", class: "btn link", id: `${base}-remove`, text: `✕ ${tr("tools.remove")}${ct.name ? `: ${ct.name}` : ""}`, onClick: () => { state.custom.splice(i, 1); render({ focus: "btn-add-custom" }); } })),
  );
}

let customSeq = 0;
function renderTools() {
  const count = Object.values(state.products).reduce((n, c) => n + Math.max(1, Object.keys(c.tiers).length), 0) + state.custom.length;
  const groups = TOOLS.vendors
    .filter((v) => v.id !== "custom")
    .map((v) =>
      h(
        "section",
        { class: "vendor-group", "aria-labelledby": safeId(`vg-${v.id}`), "data-vendor": v.id },
        h("h3", { id: safeId(`vg-${v.id}`) }, v.name, v.parent_jurisdiction ? h("span", { class: "jur", text: `· ${lookup(I18N, `jurisdictions.${v.parent_jurisdiction}`)}` }) : null),
        h("div", { class: "card-grid" }, v.products.map((p) => renderToolCard(v, p))),
      ),
    );

  const filterInput = h("input", {
    type: "search", id: "tool-filter", class: "input", value: state.filter, placeholder: tr("tools.filter_placeholder"),
    onInput: (e) => { state.filter = e.target.value; applyFilter(); },
  });

  const panel = stepPanel(
    "tools.title",
    "tools.intro",
    h(
      "div",
      { class: "toolbar" },
      h("div", { class: "field" }, h("label", { for: "tool-filter", text: tr("tools.filter") }), filterInput),
      h("span", { class: "count-pill", role: "status", text: tr("tools.selected_count", { count }) }),
    ),
    count ? null : h("p", { class: "hint", text: tr("tools.none_selected") }),
    groups,
    h(
      "section",
      { class: "vendor-group", "aria-labelledby": "vg-custom" },
      h("h3", { id: "vg-custom", text: tr("tools.custom.title") }),
      h("p", { class: "hint", text: tr("tools.custom.intro") }),
      state.custom.map((ct, i) => renderCustomTool(ct, i)),
      h("button", {
        type: "button", class: "btn secondary", id: "btn-add-custom", text: `+ ${tr("tools.custom.add")}`,
        onClick: () => {
          const key = `c${++customSeq}`;
          state.custom.push({ key, name: "", tierType: null, users: 1, residency: "dk", dataTypes: [], approval: "dk" });
          render({ focus: `custom-${key}-name` });
        },
      }),
    ),
    navButtons(),
  );
  queueMicrotask(applyFilter);
  return panel;
}

function applyFilter() {
  const q = state.filter.trim().toLowerCase();
  for (const card of document.querySelectorAll(".tool-card")) {
    card.hidden = Boolean(q) && !card.classList.contains("is-selected") && !card.dataset.search.includes(q);
  }
  for (const g of document.querySelectorAll(".vendor-group[data-vendor]")) {
    g.hidden = ![...g.querySelectorAll(".tool-card")].some((c) => !c.hidden);
  }
}

function validateTools() {
  const errs = [];
  for (const v of TOOLS.vendors) for (const p of v.products) {
    const key = productKey(v, p);
    const cfg = state.products[key];
    if (!cfg) continue;
    if (!Object.keys(cfg.tiers).length) errs.push({ field: safeId(`tier-${key}-${p.tiers[0].id}`), msg: tr("tools.tiers_error", { tool: p.name }) });
    if (!cfg.dataTypes.length) errs.push({ field: safeId(`data-${key}-${DATA_TYPES[0]}`), msg: tr("tools.data_error", { tool: p.name }) });
  }
  for (const ct of state.custom) {
    ct.name = ct.name.trim();
    const base = `custom-${ct.key}`;
    if (!ct.name) errs.push({ field: `${base}-name`, msg: tr("tools.custom.name_error") });
    if (!ct.dataTypes.length) errs.push({ field: safeId(`data-${base}-${DATA_TYPES[0]}`), msg: tr("tools.data_error", { tool: ct.name || tr("tools.custom.title") }) });
  }
  return errs;
}

// ── Step 3: use cases ───────────────────────────────────────────────────────
function renderUseCases() {
  const items = REG.ai_act.use_case_mapping.items;
  return stepPanel(
    "usecases.title",
    "usecases.intro",
    h(
      "fieldset",
      {},
      h("legend", { class: "visually-hidden", text: tr("usecases.title") }),
      h(
        "div",
        { class: "uc-grid" },
        Object.entries(items).map(([id, m]) =>
          h(
            "label",
            { class: "uc-card", for: `uc-${id}` },
            h("input", {
              type: "checkbox", id: `uc-${id}`, checked: state.useCases.includes(id),
              onChange: (e) => (state.useCases = e.target.checked ? [...state.useCases, id] : state.useCases.filter((x) => x !== id)),
            }),
            h(
              "span",
              {},
              h("span", { class: "t", text: tr(`usecases.items.${id}.label`) }),
              h("span", { class: "h", text: tr(`usecases.items.${id}.hint`) }),
              h("span", { class: `tag ${m.risk_tier}` }, h("span", { class: "visually-hidden", text: `${tr("usecases.tier_label")}: ` }), tr(`usecases.tiers.${m.risk_tier}`)),
            ),
          ),
        ),
      ),
    ),
    navButtons(),
  );
}

// ── Step 4: governance ──────────────────────────────────────────────────────
function renderGovernance() {
  return stepPanel(
    "governance.title",
    "governance.intro",
    h(
      "div",
      { class: "gov-list" },
      Object.keys(GOVERNANCE_QUESTIONS).map((q) => {
        const err = errorFor(`gov-${q}-yes`);
        const item = h(
          "div",
          { class: "gov-item" },
          radioGroup(`gov-${q}`, tr(`governance.questions.${q}`), ["yes", "partial", "no", "dk"], state.governance[q], (o) => (state.governance[q] = o), { labelPrefix: "governance.answers" }),
        );
        if (err) item.append(h("span", { class: "error-msg", text: err.msg }));
        return item;
      }),
    ),
    navButtons({ nextLabel: "nav.see_results" }),
  );
}

function validateGovernance() {
  const missing = Object.keys(GOVERNANCE_QUESTIONS).filter((q) => !state.governance[q]);
  return missing.map((q) => ({ field: `gov-${q}-yes`, msg: `${tr(`governance.questions.${q}`)} — ${tr("governance.error")}` }));
}

// ── Step 5: results ─────────────────────────────────────────────────────────
function buildEntries() {
  const entries = [];
  for (const cfg of Object.values(state.products)) {
    for (const [tierId, users] of Object.entries(cfg.tiers)) {
      entries.push({ tierId, users, residency: cfg.residency, dataTypes: [...cfg.dataTypes], approval: cfg.approval });
    }
  }
  for (const ct of state.custom) {
    entries.push({ tierId: "custom.other.unknown", customName: ct.name, customTierType: ct.tierType, users: ct.users, residency: ct.residency, dataTypes: [...ct.dataTypes], approval: ct.approval });
  }
  return entries;
}

function answers() {
  return { tools: buildEntries(), useCases: [...state.useCases], governance: { ...state.governance }, company: { employees: state.company.employees } };
}

function bandBadge(band, extraClass = "") {
  return h("span", { class: `band-badge band-${band} ${extraClass}` }, h("span", { class: "ico", "aria-hidden": "true", text: BAND_ICON[band] }), tr(`bands.${band}`));
}

function gauge(score, band) {
  const len = Math.PI * 120;
  const filled = (len * Math.max(0, Math.min(100, score))) / 100;
  return svg(
    "svg",
    { class: "gauge", viewBox: "0 0 300 170", role: "img", "aria-label": `${tr("results.overall")}: ${score} ${tr("results.out_of")} — ${tr(`bands.${band}`)}` },
    svg("path", { d: "M30 150 A120 120 0 0 1 270 150", fill: "none", class: "track", "stroke-width": "22", "stroke-linecap": "round" }),
    svg("path", { d: "M30 150 A120 120 0 0 1 270 150", fill: "none", stroke: `var(--st-${band})`, "stroke-width": "22", "stroke-linecap": "round", "stroke-dasharray": `${filled} ${len}` }),
  );
}

function meterRow(label, value) {
  const band = bandFor(value);
  return h(
    "div",
    { class: "meter-row" },
    h("dt", { text: label }),
    h("dd", { class: "meter-dd" }, h("div", { class: "meter", role: "presentation" }, h("span", { class: `fill-${band}`, style: { width: `${Math.max(2, value)}%` } }))),
    h("dd", { class: "meter-val" }, h("strong", { text: String(value) }), bandBadge(band)),
  );
}

const SORT_COLS = [
  { key: "name", num: false, label: "results.table.tool", get: (x) => x.name.toLowerCase() },
  { key: "tier", num: false, label: "results.table.tier", get: (x) => x.tierType || "" },
  { key: "users", num: true, label: "results.table.users", get: (x) => x.users },
  { key: "sovereignty", num: true, label: "results.table.sovereignty", get: (x) => x.scores.sovereignty },
  { key: "gdpr", num: true, label: "results.table.gdpr", get: (x) => x.scores.gdpr },
  { key: "aiact", num: true, label: "results.table.aiact", get: (x) => x.scores.aiact },
  { key: "security", num: true, label: "results.table.security", get: (x) => x.scores.security },
  { key: "total", num: true, label: "results.table.total", get: (x) => x.total },
];

function toolTable(tools) {
  if (!tools.length) return h("p", { text: tr("results.no_tools") });
  const col = SORT_COLS.find((c) => c.key === state.sort.key) || SORT_COLS[SORT_COLS.length - 1];
  const dir = state.sort.dir === "asc" ? 1 : -1;
  const rows = [...tools].sort((a, b) => (col.get(a) > col.get(b) ? dir : col.get(a) < col.get(b) ? -dir : 0));
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "data" },
      h("caption", { class: "visually-hidden", text: tr("results.per_tool") }),
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          SORT_COLS.map((c) => {
            const active = c.key === state.sort.key;
            return h(
              "th",
              { scope: "col", class: c.num ? "num" : undefined, "aria-sort": active ? (state.sort.dir === "asc" ? "ascending" : "descending") : "none" },
              h(
                "button",
                {
                  type: "button", class: "sort-btn", id: `sort-${c.key}`,
                  "aria-label": tr("results.sort_by", { column: tr(c.label) }),
                  onClick: () => {
                    state.sort = { key: c.key, dir: active && state.sort.dir === "desc" ? "asc" : active ? "desc" : c.num ? "desc" : "asc" };
                    render();
                  },
                },
                tr(c.label),
                h("span", { class: "arrow", "aria-hidden": "true", text: active ? (state.sort.dir === "asc" ? "▲" : "▼") : "↕" }),
              ),
            );
          }),
        ),
      ),
      h(
        "tbody",
        {},
        rows.map((x) => [
          h(
            "tr",
            { class: "tool-row" },
            h("th", { scope: "row" }, h("strong", { text: x.name }), h("br"), h("span", { class: "hint", text: x.vendorName })),
            h("td", { text: tierTypeLabel(I18N, x.tierType) }),
            h("td", { class: "num", text: String(x.users) }),
            ["sovereignty", "gdpr", "aiact", "security"].map((k) => h("td", { class: "num", text: String(x.scores[k]) })),
            h("td", { class: "num" }, h("strong", { text: String(x.total) }), " ", bandBadge(x.band)),
          ),
          h(
            "tr",
            { class: "reason-row" },
            h(
              "td",
              { colspan: String(SORT_COLS.length) },
              h("span", { class: "reason-label", text: `${tr("results.table.reasons")}: ` }),
              h("ul", { class: "reason-list" }, x.mainReasons.map((r) => h("li", { text: formatReason(I18N, r) }))),
            ),
          ),
        ]),
      ),
    ),
  );
}

let lastResult = null;
function renderResults() {
  if (state.submit.status === "sent") return renderSent();
  const r = assess(answers(), { tools: TOOLS, regulation: REG, index: KB });
  lastResult = r;
  const alts = r.tools.filter((x) => x.alternativesScored.length);

  return h(
    "div",
    {},
    h(
      "section",
      { class: "panel", "aria-labelledby": "step-title" },
      h("h2", { id: "step-title", class: "step-title", tabindex: "-1", text: tr("results.title") }),
      h("p", { class: "intro", text: tr("results.intro", { date: fmtDate(TOOLS.meta.as_of, LANG) }) }),
      r.prohibitedFlag ? h("p", { class: "flag", role: "alert", text: tr("results.prohibited_flag") }) : null,
      h(
        "div",
        { class: "results-top" },
        h(
          "div",
          { class: "gauge-card" },
          h("h3", { text: tr("results.overall") }),
          gauge(r.overall, r.band),
          h("div", { class: "hero-figure", "aria-hidden": "true" }, String(r.overall), h("small", { text: `/ 100` })),
          bandBadge(r.band),
          h("p", { class: "method-note", text: r.method === "worst_tool" && r.worstTool ? tr("results.method_worst_tool", { tool: r.worstTool.name }) : tr("results.method_blended") }),
        ),
        h(
          "div",
          {},
          h("h3", { text: tr("results.sub_scores") }),
          h("dl", { class: "meters" }, ["sovereignty", "gdpr", "aiact", "security", "governance"].map((k) => meterRow(tr(`dims.${k}`), r.subScores[k]))),
          h("h3", { class: "mt", text: tr("results.key_findings") }),
          h("ul", { class: "findings" }, r.keyFindings.map((f) => h("li", { text: formatFinding(I18N, f) }))),
        ),
      ),
    ),
    h("section", { class: "panel", "aria-labelledby": "h-tools" }, h("h2", { id: "h-tools", text: tr("results.per_tool") }), toolTable(r.tools)),
    alts.length
      ? h(
          "section",
          { class: "panel", "aria-labelledby": "h-alts" },
          h("h2", { id: "h-alts", text: tr("results.alternatives") }),
          h(
            "ul",
            { class: "alt-list" },
            alts.flatMap((x) =>
              x.alternativesScored.map((a) =>
                h("li", {}, tr("results.alternative_line", { from: x.name, fromScore: x.total, to: a.name, toScore: a.total }), " ", bandBadge(a.band)),
              ),
            ),
          ),
        )
      : null,
    h(
      "section",
      { class: "panel", "aria-labelledby": "h-actions" },
      h("h2", { id: "h-actions", text: tr("results.top_actions") }),
      h(
        "ol",
        { class: "actions-list" },
        r.actions.slice(0, 5).map((a) => {
          const f = formatAction(I18N, a);
          return h("li", {}, h("div", {}, h("span", { class: "a-title", text: f.title }), h("span", { class: "a-detail", text: f.detail }), h("span", { class: "a-when", text: tr(`horizons.${a.horizon}`) })));
        }),
      ),
    ),
    renderSendBox(),
    h("p", { class: "disclaimer", text: tr("results.disclaimer") }),
    h("div", { class: "step-nav" }, h("button", { type: "button", class: "btn secondary", id: "btn-back", text: `← ${tr("nav.edit")}`, onClick: () => goTo(3) })),
  );
}

function renderSendBox() {
  const s = state.submit;
  const sending = s.status === "sending";
  return h(
    "section",
    { class: "panel send-box", "aria-labelledby": "h-send" },
    h("h2", { id: "h-send", text: tr("results.send.title") }),
    h("p", { text: tr("results.send.intro") }),
    CONFIG.copyToClient
      ? h(
          "div",
          { class: "check" },
          h("input", { type: "checkbox", id: "f-copy", checked: state.sendCopy, onChange: (e) => (state.sendCopy = e.target.checked) }),
          h("label", { for: "f-copy", text: tr("results.send.copy", { email: state.company.email }) }),
        )
      : null,
    h("p", { class: "mt" }, h("button", { type: "button", class: "btn", id: "btn-send", disabled: sending || undefined, "aria-busy": sending ? "true" : undefined, text: sending ? tr("results.send.sending") : tr("results.send.button"), onClick: submit })),
    s.status === "error"
      ? h("div", { class: "status-box err", role: "alert", id: "send-status", tabindex: "-1" }, h("h3", { text: tr("results.send.error_title") }), h("p", { text: s.message }))
      : null,
  );
}

function renderSent() {
  return h(
    "section",
    { class: "panel", "aria-labelledby": "step-title" },
    h("h2", { id: "step-title", class: "step-title", tabindex: "-1", text: tr("results.send.success_title") }),
    h("div", { class: "status-box ok", role: "status" }, h("p", { text: state.submit.message })),
    h("p", { class: "disclaimer", text: tr("results.disclaimer") }),
    h("div", { class: "step-nav" }, h("button", { type: "button", class: "btn", id: "btn-restart", text: tr("nav.restart"), onClick: () => { state = freshState(); render({ focus: "heading" }); } })),
  );
}

async function submit() {
  if (state.submit.status === "sending") return;
  state.submit = { status: "sending", message: "" };
  render({ focus: "btn-send" });
  const payload = {
    lang: LANG,
    company: { ...state.company },
    consent: state.consent,
    fax: state.hp,
    elapsedMs: Date.now() - state.startedAt,
    sendCopy: Boolean(CONFIG.copyToClient && state.sendCopy),
    tools: buildEntries(),
    useCases: [...state.useCases],
    governance: { ...state.governance },
  };
  let res;
  try {
    res = await fetch("/api/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } catch {
    res = null;
  }
  if (res && res.ok) {
    const email = state.company.email;
    const copied = payload.sendCopy;
    // Wipe every answer from memory; only the confirmation remains.
    state = freshState();
    state.step = STEPS.length - 1;
    state.maxStep = state.step;
    state.submit = { status: "sent", message: tr("results.send.success", { copy: copied ? tr("results.send.success_copy", { email }) : "" }) };
    lastResult = null;
    render({ focus: "heading" });
    return;
  }
  const status = res ? res.status : 0;
  // The server reports which step failed (e.g. "smtp · EAUTH:535") — shown so it can be passed on to support.
  let detail = status ? `HTTP ${status}` : "network";
  if (res && status === 502) {
    const info = await res.json().catch(() => null);
    if (info && info.stage) detail += ` · ${info.stage}${info.code ? ` · ${info.code}` : ""}`;
  }
  const message =
    status === 429 ? tr("results.send.error_rate") : status === 400 ? tr("results.send.error_validation") : tr("results.send.error", { detail });
  state.submit = { status: "error", message };
  render({ focus: "send-status" });
}

// ── Navigation ──────────────────────────────────────────────────────────────
function validateStep(i) {
  return [validateCompany, validateTools, () => [], validateGovernance, () => []][i]();
}

function next() {
  const errs = validateStep(state.step);
  state.errors = errs;
  if (errs.length) {
    render({ focus: "errors" });
    return;
  }
  goTo(state.step + 1);
}

function goTo(i) {
  if (i < 0 || i >= STEPS.length) return;
  // Moving forward past unvalidated steps is not allowed.
  for (let s = 0; s < i; s++) {
    if (validateStep(s).length) {
      state.step = s;
      state.errors = validateStep(s);
      render({ focus: "errors" });
      return;
    }
  }
  state.errors = [];
  state.step = i;
  state.maxStep = Math.max(state.maxStep, i);
  if (i === STEPS.length - 1 && state.submit.status !== "sent") state.submit = { status: "idle", message: "" };
  render({ focus: "heading" });
  window.scrollTo({ top: document.getElementById("main").offsetTop - 8, behavior: "smooth" });
}

boot();
