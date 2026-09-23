// Shared i18n helpers (browser + server). Pure functions, no DOM.

/** Look up a dotted key; returns the key itself if missing (visible in tests). */
export function lookup(dict, key) {
  const v = key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), dict);
  return v === undefined ? key : v;
}

/** Replace {name} placeholders. */
export function interpolate(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined || params[k] === null ? m : String(params[k])));
}

export function t(dict, key, params) {
  return interpolate(lookup(dict, key), params);
}

export function fmtDate(iso, lang) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  return new Intl.DateTimeFormat(lang === "nl" ? "nl-NL" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}

function listJoin(items, lang) {
  if (!items.length) return "";
  try {
    return new Intl.ListFormat(lang === "nl" ? "nl" : "en", { style: "long", type: "conjunction" }).format(items);
  } catch {
    return items.join(", ");
  }
}

/** Turn raw reason/action params into display strings. */
export function renderParams(dict, params = {}, lang = dict?.meta?.lang || "en") {
  const out = { ...params };
  if (Array.isArray(params.useCases)) out.useCases = listJoin(params.useCases.map((u) => lookup(dict, `usecases.items.${u}.label`)), lang);
  if (Array.isArray(params.fields)) out.count = params.fields.length;
  if (params.band) out.band = lookup(dict, `bands.${params.band}`);
  if (params.jurisdiction) out.jurisdiction = lookup(dict, `jurisdictions.${params.jurisdiction}`);
  for (const k of ["date", "date2"]) if (params[k]) out[k] = fmtDate(params[k], lang);
  if (params.tools === "") out.tools = "—";
  return out;
}

export function formatReason(dict, reason) {
  const m = /^gov_(.+)_(missing|partial)$/.exec(reason.code);
  if (m) {
    const question = lookup(dict, `governance.questions.${m[1]}`).replace(/\?$/, "");
    return t(dict, `reasons.gov_${m[2]}`, { question });
  }
  return t(dict, `reasons.${reason.code}`, renderParams(dict, reason.params));
}

export function formatAction(dict, action) {
  const p = renderParams(dict, action.params);
  return { title: t(dict, `actions.${action.code}.title`, p), detail: t(dict, `actions.${action.code}.detail`, p) };
}

export function formatFinding(dict, finding) {
  return t(dict, `findings.${finding.code}`, renderParams(dict, finding.params));
}

/** Tier label shown in tables: the tier type (translated). */
export function tierTypeLabel(dict, tierType) {
  return tierType ? lookup(dict, `tools.tier_types.${tierType}`) : "?";
}
