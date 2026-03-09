# WCH Test Suite — Sitemap Copy Verifier

A web app that verifies whether one site is a valid copy of another by comparing sitemap URLs, checking page availability, and validating internal links + assets.

## What it does

- Accepts two site URLs:
  - **Site A** (source)
  - **Site B** (target copy)
- Supports Site B in a subdirectory root (example: `/hi_hi_hi/`)
- Discovers sitemap files from:
  - `/sitemap.xml`
  - `robots.txt` (`Sitemap:` entries)
  - nested sitemap indexes
- Compares sitemap entries using normalized path keys
- Verifies HTTP availability for both sides (HEAD with GET fallback)
- Crawls HTML pages to extract internal:
  - links (`href`)
  - assets (`src` and common static file types)
- Reports status codes for everything (200, 301, 404, 403, etc.)
- Saves URL inputs in browser localStorage so refresh keeps values

## Stack

- Node.js + Express
- fast-xml-parser
- p-limit
- Vanilla HTML/CSS/JS frontend

## Local development

```bash
cd sitemap-copy-verifier
npm install
npm start
```

Default URL: `http://localhost:4173`

Health endpoint:

```bash
GET /health
```

## API

### Compare two sites

`POST /api/compare`

Payload:

```json
{
  "urlA": "https://anmoljin-test.webflow.io",
  "urlB": "https://jared-preprod.hellowes.com/hi_hi_hi/"
}
```

Response includes:

- `summary` + `rows` (sitemap URL comparison)
- `referencesSummary` + `referenceRows` (links/assets comparison)
- per-item statuses for Site A / Site B

## Render deployment

A `render.yaml` is included.

### Option A: Blueprint Deploy

1. Push this folder to GitHub.
2. In Render: **New + → Blueprint**.
3. Select the repo.
4. Deploy.

### Option B: Web Service

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- (If repo root is above project folder) Root Directory: `sitemap-copy-verifier`

## Notes

- A `403` may indicate bot/firewall restrictions rather than a true missing page.
- For links/assets, matching ignores query params to reduce false mismatches from cache-busting tokens.
