# AI Sovereignty Scan — Oneview Logic B.V.

A self-assessment web app. A company enters its details and the AI tools it uses, per account tier. The app scores EU AI Act, GDPR and data-sovereignty risk per tool and overall, and shows a results dashboard. The app is available in English (`/en/`) and Dutch (`/nl/`).

Emails (all to **info@oneviewlogic.com**, `MAIL_TO`):
1. **Lead** — as soon as the visitor completes step 1, their company and contact details are emailed (`POST /api/lead`), even if they never finish the scan.
2. **Results** — when the results page opens, the answers, scores and a branded report (HTML + PDF) are emailed automatically (`POST /api/submit`). The same answers are never sent twice.

The visitor receives no copy. The results page tells them to contact info@oneviewlogic.com for more detail (with a `mailto:` button). Setting `SEND_COPY_TO_CLIENT=true` is still supported server-side but the UI no longer offers it.

```
public/          static frontend (vanilla JS, no build step)
  en/ nl/        language shells (index.html, privacy.html)
  assets/        app.js (UI), scoring.js (pure scoring engine, shared with server), i18n.js, styles.css
  i18n/          en.json, nl.json — every visible string
data/            tools.json (57 tool tiers), regulation.json (AI Act / GDPR / NL) — with sources + dates
server/          index.js (Express), submit.js (shared handler), validate.js, report.js + report-model.js,
                 report-template.js, pdf.js (Chromium PDF), pdf-doc.js (pdfmake PDF), mailer.js, kb.js
netlify/         functions/lead.mjs, submit.mjs, health.mjs, config.mjs (Netlify Functions)
scripts/         check-data.js (knowledge-base linter), verify-sources.md (refresh checklist)
tests/           scoring, i18n, server/API (real PDF + SMTP), Netlify functions, browser end-to-end (Playwright)
```

How it works: the browser computes a live preview. On submit, the server **re-validates every field**, **re-computes the score** with the same `scoring.js` (client-supplied scores are ignored), renders the report, converts it to PDF with headless Chromium and sends it over SMTP. Nothing is stored in the browser (no cookies or web storage) or on the server. Logs contain only method, path, status and duration.

## Run locally

Requirements: Node.js 20+ and a Chromium for PDF rendering.

```bash
cd ai-sovereignty-scan
npm install
npx playwright install chromium     # skip if you set CHROMIUM_PATH to an existing Chrome/Chromium
cp .env.example .env                # then fill in SMTP (see below)
npm start                           # http://localhost:3000  → redirects to /en/ or /nl/
```

`npm run dev` restarts the server on file changes.

### Tests

```bash
npm run check-data   # knowledge-base consistency (sources, dates, unverified fields)
npm test             # scoring engine, i18n completeness, validation, report, API (real PDF + local SMTP)
npm run test:e2e     # full browser run (Dutch UI → results → send → emails with PDF)
npm run test:all     # everything
```

The API and browser tests start a local SMTP capture server (Mailpit-style, via `smtp-server`), so they need no internet access and no real mailbox. Set `SCREENSHOT_DIR=/some/dir` to save screenshots from the browser test.

## SMTP configuration

All mail settings live in `.env` on the server and are never sent to the browser.

| Variable | Meaning |
|---|---|
| `SMTP_HOST`, `SMTP_PORT` | Mail server. Port 587 uses STARTTLS (required), 465 uses implicit TLS. |
| `SMTP_USER`, `SMTP_PASS` | SMTP credentials (use an app password or SMTP key, not a personal password). |
| `MAIL_FROM` | Sender, e.g. `"Oneview Logic AI Sovereignty Scan <scan@oneviewlogic.com>"`. Must be allowed by your SPF/DKIM. |
| `MAIL_TO` | Internal recipient; default `info@oneviewlogic.com`. |
| `SEND_COPY_TO_CLIENT` | Leave `false`: visitors contact info@ for details. (`true` would also email the submitter a copy if the client asks for one.) |
| `RATE_LIMIT_MAX` | Submissions per IP per 15 minutes (default 5). |
| `TRUST_PROXY` | Set to `1` behind one reverse proxy so rate limiting sees the real client IP. |
| `CHROMIUM_PATH` | Optional path to a Chrome/Chromium binary. |
| `PDF_ENGINE` | `chromium` (default: renders the HTML report) or `pdfmake` (pure JS, no browser needed). |

Good EU options: your Microsoft 365 or Google Workspace SMTP relay, or an EU-hosted transactional provider such as Brevo (FR), Mailjet (FR) or Scaleway TEM (FR). Set up SPF, DKIM and DMARC for the `MAIL_FROM` domain so the report doesn't land in spam.

To try email without a real mailbox, run Mailpit and point the app at it:

```bash
docker run -d -p 8025:8025 -p 1025:1025 axllent/mailpit
# .env: SMTP_HOST=localhost SMTP_PORT=1025 (leave SMTP_USER/SMTP_PASS empty) → open http://localhost:8025
```

Ethereal (`https://ethereal.email`) also works: create an account and copy its host, port, user and password into `.env`.

## Deploy on Netlify (no server to manage)

The repo is ready for Netlify: `netlify.toml` (at the repository root) builds the static UI into `ai-sovereignty-scan/dist` and deploys `/api/submit` and `/api/config` as **Netlify Functions**. On Netlify the PDF is rendered with **pdfmake** (pure JavaScript, no browser), because Chromium is too large and slow for serverless functions. The content and sections are the same as the Chromium PDF.

1. In Netlify: **Add new site → Import an existing project → GitHub → `oneview_suite`**. Build settings are read from `netlify.toml`; leave them empty in the UI.
2. **Site configuration → Environment variables:** add `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `MAIL_TO=info@oneviewlogic.com`, `SEND_COPY_TO_CLIENT=true`. Mark `SMTP_PASS` as secret. Redeploy after adding them.
3. Open `https://<your-site>.netlify.app/` (it redirects to `/nl/` or `/en/`), run a test scan and check that the report arrives at info@.
4. Optional: **Domain management → Add a domain**, e.g. `scan.oneviewlogic.com`. Netlify issues the TLS certificate automatically.

Good to know:
- Function limits: each submission runs well within Netlify's 10-second limit (pdfmake + SMTP take about 1–3 s). Use an SMTP provider that answers quickly.
- Rate limiting uses Netlify's built-in function rate limit (3 submissions per minute per IP; see `netlify/functions/submit.mjs`), plus the honeypot and minimum fill time.
- The security headers (CSP etc.) and the language redirect on `/` are set in `netlify.toml`.
- Netlify runs on US-headquartered infrastructure (AWS). Its EU edge serves the pages, but functions run in the region configured for the site (**Site configuration → Functions → Region**, if your plan offers it; choose Frankfurt `eu-central-1`). For a fully EU-sovereign setup use the Docker/VPS option below.
- To build locally the way Netlify does: `npx netlify-cli build --offline` (from the repository root).

### Troubleshooting "HTTP 502"

A 502 means the report was built but could not be delivered. The error message in the UI shows the failing step and code, e.g. `HTTP 502 · smtp · EAUTH:535`. The same line appears in **Logs → Functions → submit** as `submit failed: stage=… code=…`.

| Shown | Meaning / fix |
|---|---|
| `config · SMTP_HOST_MISSING` / `SMTP_PASS_MISSING` | The function doesn't see the variable. In **Environment variables**, make sure the scope includes **Functions** (not only Builds), then **redeploy**. |
| `smtp · EAUTH:535` | Wrong username/password. Microsoft 365: SMTP AUTH must be enabled for the mailbox. Gmail/Workspace: use an **app password**. |
| `smtp · ETIMEDOUT` / `ESOCKET` / `ECONNECTION` | Host or port wrong or blocked. Use port **587** (STARTTLS) or **465** (TLS). Port 25 is blocked on Netlify. |
| `config · SMTP_USER_MISSING` or `smtp · EENVELOPE:530` | No login was attempted because the function can't see `SMTP_USER`. Check the variable name and its **Functions** scope, then redeploy. |
| `smtp · EENVELOPE:550/553/554` | The sender isn't allowed: `MAIL_FROM` must be the SMTP account or a verified sender/domain. |
| `pdf · …` | PDF rendering failed. Send the log line to the developer. |

`GET /api/health` shows which mail settings the function can see (true/false only, never the values). To test the SMTP login itself, set a `DIAG_TOKEN` environment variable and open `/api/health?verify=<DIAG_TOKEN>`. It returns `"smtpVerify": "ok"` or the error code, plus a `trace`: each step (config → dns → connect → login) with its status, the SMTP server's reply text at the failing step, a masked `SMTP_USER` (`in***@example.com`), facts about `SMTP_PASS` (length, spaces, whether it looks like a 16-letter Google app password — never the password itself), whether `MAIL_FROM` matches `SMTP_USER`, and a `hint`.

## Deploy (EU hosting, Docker/VPS)

The app is a single Node process that needs Chromium, so a container or a small VPS is the easiest route. Choose an EU-headquartered provider and region to stay consistent with the product's message, for example Hetzner (DE/FI), Scaleway (FR), OVHcloud (FR) or a Dutch provider such as TransIP or Leaseweb.

### Option A — Docker (any EU VPS or container platform)

```bash
cd ai-sovereignty-scan
docker build -t ai-sovereignty-scan .
docker run -d --name scan --restart unless-stopped --env-file .env -p 127.0.0.1:3000:3000 ai-sovereignty-scan
```

The image is based on Microsoft's Playwright image, which includes Chromium and its system libraries. It runs as a non-root user and has a `/healthz` health check. Scaleway Serverless Containers and OVHcloud work too if you want a managed platform. Give the container at least 1 GB of RAM.

### Option B — plain VPS (Ubuntu 24.04)

```bash
sudo apt install -y nodejs npm            # or NodeSource for Node 22
git clone <repo> && cd oneview_suite/ai-sovereignty-scan
npm ci --omit=dev && npx playwright install --with-deps chromium
cp .env.example .env && nano .env
# systemd unit: ExecStart=/usr/bin/node /opt/oneview_suite/ai-sovereignty-scan/server/index.js
#               EnvironmentFile=/opt/oneview_suite/ai-sovereignty-scan/.env, User=scan, Restart=always
```

### Reverse proxy and TLS

Put Caddy or nginx in front for HTTPS and set `TRUST_PROXY=1`. Minimal Caddyfile:

```
scan.oneviewlogic.com {
  reverse_proxy 127.0.0.1:3000
}
```

The app already sends a strict Content-Security-Policy and other security headers (helmet). The proxy only needs to add HSTS if you want it. To embed the scan on the main website, link to it rather than using an iframe, because `frame-ancestors 'none'` blocks framing.

## Refreshing the knowledge base

Vendor terms change often. Follow **`scripts/verify-sources.md`**, then run `npm run test:all`. Adding a new tool or tier only needs JSON; the UI, scoring and report pick it up automatically.

## Disclaimer

The scan is an indicative self-assessment, not legal advice. Facts were verified as of 23 September 2026. See `data/*.json` for the source and verification date of every fact.
