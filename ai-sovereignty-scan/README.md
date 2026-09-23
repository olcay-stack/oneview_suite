# AI Sovereignty Scan — Oneview Logic B.V.

A self-assessment web app. A company enters its details and the AI tools it uses, per account tier. The app scores EU AI Act, GDPR and data-sovereignty risk per tool and overall, and shows a results dashboard. It then emails a branded report (HTML + PDF) to **info@oneviewlogic.com**, with an optional copy to the submitter. The app is available in English (`/en/`) and Dutch (`/nl/`).

```
public/          static frontend (vanilla JS, no build step)
  en/ nl/        language shells (index.html, privacy.html)
  assets/        app.js (UI), scoring.js (pure scoring engine, shared with server), i18n.js, styles.css
  i18n/          en.json, nl.json — every visible string
data/            tools.json (57 tool tiers), regulation.json (AI Act / GDPR / NL) — with sources + dates
server/          index.js (Express), validate.js, report.js + report-template.html, pdf.js, mailer.js
scripts/         check-data.js (knowledge-base linter), verify-sources.md (refresh checklist)
tests/           scoring, i18n, server/API (real PDF + SMTP), browser end-to-end (Playwright)
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
| `SEND_COPY_TO_CLIENT` | `true` shows the "send me a copy" checkbox and allows the copy. `false` hides it. |
| `RATE_LIMIT_MAX` | Submissions per IP per 15 minutes (default 5). |
| `TRUST_PROXY` | Set to `1` behind one reverse proxy so rate limiting sees the real client IP. |
| `CHROMIUM_PATH` | Optional path to a Chrome/Chromium binary. |

Good EU options: your Microsoft 365 or Google Workspace SMTP relay, or an EU-hosted transactional provider such as Brevo (FR), Mailjet (FR) or Scaleway TEM (FR). Set up SPF, DKIM and DMARC for the `MAIL_FROM` domain so the report doesn't land in spam.

To try email without a real mailbox, run Mailpit and point the app at it:

```bash
docker run -d -p 8025:8025 -p 1025:1025 axllent/mailpit
# .env: SMTP_HOST=localhost SMTP_PORT=1025 (leave SMTP_USER/SMTP_PASS empty) → open http://localhost:8025
```

Ethereal (`https://ethereal.email`) also works: create an account and copy its host, port, user and password into `.env`.

## Deploy (EU hosting)

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
