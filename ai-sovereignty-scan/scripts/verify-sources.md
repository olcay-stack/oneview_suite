# Refreshing the knowledge base (`data/tools.json`, `data/regulation.json`)

The scan is only as good as its facts. Vendor terms change often: Mistral, GitHub and Microsoft all changed training or residency defaults in 2026. Re-verify **at least quarterly**, and immediately when one of the triggers below happens.

## Ground rules

1. **Every fact needs a source.** Each tier and each regulation item has `source_urls` and `last_verified` (YYYY-MM-DD). Prefer primary sources: EUR-Lex, europa.eu, autoriteitpersoonsgegevens.nl, vendor legal, privacy and trust pages. Only use secondary sources (law firms, press) when the primary source is paywalled or unreachable.
2. **Never guess.** If you cannot confirm a value, set it to `null` and add the field path (e.g. `admin_controls.sso`) to `unverified_fields`. The scoring engine then treats it as worst case.
3. **When sources disagree,** store the stricter value, set `"status": "conflicting"` and explain in `note`.
4. Only facts go in the JSON. Point values and weights live in `public/assets/scoring.js`.
5. After editing, run:
   ```bash
   npm run check-data   # schema: nulls ↔ unverified_fields, alternatives exist, sources + dates present
   npm run test:all     # scoring, i18n, server and browser end-to-end tests
   ```
   Then update `meta.as_of` in both files. The UI and report show this date.

## Triggers for an immediate update

- A new EU act or Official Journal publication touching the AI Act or GDPR (e.g. adoption of the broader **Digital Omnibus** GDPR changes, which were still a proposal on 2026-09-23).
- A CJEU ruling in **Latombe (C-703/25 P)** or any other ruling on the EU-US Data Privacy Framework.
- Adoption or entry into force of the Dutch **Uitvoeringswet AI-verordening**.
- A vendor changing its terms or privacy policy (watch for emails such as "Updates to our Consumer Terms") or launching or removing EU data residency.
- A DPA fine, ban or investigation involving a listed vendor (AP, Garante, Irish DPC, CNIL, Berlin DPA).
- Changes to the GPAI Code of Practice signatory list (Commission Signatory Taskforce page).
- M&A that changes jurisdiction (e.g. **Cohere / Aleph Alpha**: set `parent_jurisdiction` to `other` once the deal closes).

## Regulation checklist (`regulation.json`)

| Item | Where to check |
|---|---|
| AI Act application dates, Omnibus (Reg. 2026/1744) | EUR-Lex (`eli/reg/2024/1689`, `eli/reg/2026/1744`), AI Act Service Desk (ai-act-service-desk.ec.europa.eu) |
| Art. 50 guidance / Code of Practice on AI-generated content | digital-strategy.ec.europa.eu |
| GPAI Code of Practice signatories | digital-strategy.ec.europa.eu → "Signatory Taskforce" |
| Penalties (Art. 99), SME/SMC relief | EUR-Lex consolidated text |
| NL supervision and implementing law | autoriteitpersoonsgegevens.nl, rdi.nl, internetconsultatie.nl/uaiv, tweedekamer.nl |
| EU-US DPF status | curia.europa.eu (C-703/25 P), commission.europa.eu adequacy page, dataprivacyframework.gov |
| New SCCs for Art. 3(2) importers | commission.europa.eu → Standard Contractual Clauses |
| Digital Omnibus (GDPR) | European Parliament Legislative Train, Council press releases |

## Per-tier checklist (`tools.json`)

For each vendor, and **each tier separately** (free / paid personal / business / enterprise / API / cloud):

- [ ] `hq_country`, `parent_jurisdiction` (US / EU / CN / other / self). Check for ownership changes.
- [ ] `eu_data_residency.storage` and `.inference`: `none` | `optional` | `default`. Storage-only residency is **not** inference residency. Check for "flex routing", "global" deployments, and subprocessors (e.g. Anthropic models inside M365 Copilot) that are excluded from the residency promise.
- [ ] `trains_on_customer_data`: `yes_default` | `opt_out` | `no_default` | `never`. Re-read the consumer privacy policy and look for carve-outs (e.g. "flagged for safety review").
- [ ] `data_retention`: default period, whether it is configurable, whether ZDR is available (and who it's for).
- [ ] `dpa_available` (GDPR Art. 28), `transfer_mechanism` (DPF self-certification is searchable at dataprivacyframework.gov; SCCs are usually in the DPA), `subprocessor_list_public`.
- [ ] `admin_controls`: SSO, audit logs, user management, export/deletion. Check which *plan* includes each one.
- [ ] `certifications`: ISO 27001 / 27701 / 42001, SOC 2 Type II, C5. Check the trust portal and the certificate scope (which products it covers).
- [ ] `gpai_code_of_practice` for the underlying model provider (vendor level).
- [ ] `known_regulatory_actions`: fines, bans and investigations with date, authority, status and source. Record an annulment or appeal outcome as a status change; don't delete the entry. Only enforcement or formal proceedings belong here (testimony and press go in `note`).
- [ ] `lower_risk_alternatives`: tier ids that exist in the file.
- [ ] Update `source_urls`, `last_verified` and `status`, and clear `unverified_fields` for anything you confirmed.

## Adding a new tool

1. Add the vendor (or reuse one) and a product with one object per tier. Copy an existing tier as a template.
2. Fill every field; use `null` plus `unverified_fields` where needed.
3. Run `npm run check-data` and `npm test`. The i18n test also checks that the engine has a translated reason for every code it emits.
4. The UI picks up new vendors, products and tiers automatically. No code changes are needed.

## Fields currently marked unverified

Run `npm run check-data` for the live list (111 fields across 57 tiers as of 2026-09-23). Tiers not fully verified: DeepSeek API, Otter Business, Mistral Pro and Team (conflicting sources), and "Other tool" (unverified by design).
