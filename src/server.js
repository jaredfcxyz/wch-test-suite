import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { XMLParser } from 'fast-xml-parser';
import pLimit from 'p-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4173;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
});

function normalizeSiteInput(input) {
  const maybe = input?.trim();
  if (!maybe) throw new Error('URL is required');

  const withProtocol = /^https?:\/\//i.test(maybe) ? maybe : `https://${maybe}`;
  const url = new URL(withProtocol);

  const rawPath = url.pathname || '/';
  let basePath = rawPath.replace(/\/+$/, '');
  if (!basePath) basePath = '/';

  return {
    origin: `${url.protocol}//${url.host}`,
    basePath,
    normalized: `${url.protocol}//${url.host}${basePath === '/' ? '' : basePath}`,
  };
}

function joinPath(basePath, suffix) {
  const base = basePath === '/' ? '' : basePath;
  const cleanSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${base}${cleanSuffix}`;
}

async function fetchText(url) {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': 'SitemapCopyVerifier/1.2.2 (+OpenClaw)',
      Accept: 'application/xml,text/xml,text/plain,*/*',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  }

  return await res.text();
}

async function fetchMeta(url, method = 'HEAD') {
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      headers: {
        'User-Agent': 'SitemapCopyVerifier/1.2.2 (+OpenClaw)',
      },
    });

    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 400,
      contentType: res.headers.get('content-type') || '',
      body: method === 'GET' ? await res.text() : null,
    };
  } catch {
    return { status: null, ok: false, contentType: '', body: null };
  }
}

async function discoverSitemapUrls(site) {
  const candidates = new Set([
    `${site.origin}/sitemap.xml`,
    `${site.origin}${joinPath(site.basePath, '/sitemap.xml')}`,
  ]);

  const robotsCandidates = [
    `${site.origin}${joinPath(site.basePath, '/robots.txt')}`,
    `${site.origin}/robots.txt`,
  ];

  for (const robotsUrl of robotsCandidates) {
    try {
      const robots = await fetchText(robotsUrl);
      const lines = robots.split(/\r?\n/);
      for (const line of lines) {
        const match = line.match(/^\s*Sitemap:\s*(\S+)/i);
        if (match?.[1]) candidates.add(match[1].trim());
      }
    } catch {
      // robots.txt optional
    }
  }

  return [...candidates];
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

async function collectSitemapUrls(site) {
  const startSitemaps = await discoverSitemapUrls(site);
  const seenSitemaps = new Set();
  const foundUrls = new Set();
  const queue = [...startSitemaps];

  while (queue.length) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);

    try {
      const xml = await fetchText(sitemapUrl);
      const json = parser.parse(xml);

      if (json?.sitemapindex?.sitemap) {
        const nested = asArray(json.sitemapindex.sitemap)
          .map((x) => x?.loc)
          .filter(Boolean);

        for (const u of nested) {
          if (!seenSitemaps.has(u)) queue.push(u);
        }
      }

      if (json?.urlset?.url) {
        const urls = asArray(json.urlset.url)
          .map((x) => x?.loc)
          .filter(Boolean);

        for (const u of urls) foundUrls.add(u);
      }
    } catch {
      // Keep going even if one sitemap fails.
    }
  }

  return {
    sitemapFiles: [...seenSitemaps],
    urls: [...foundUrls],
  };
}

function keyFromUrl(rawUrl, siteBasePath = '/', options = {}) {
  const { includeQuery = true } = options;
  const u = new URL(rawUrl);
  let pathname = u.pathname.replace(/\/+$/, '') || '/';

  if (siteBasePath && siteBasePath !== '/' && pathname.startsWith(siteBasePath)) {
    const stripped = pathname.slice(siteBasePath.length);
    pathname = stripped ? (stripped.startsWith('/') ? stripped : `/${stripped}`) : '/';
  }

  const search = includeQuery ? (u.search || '') : '';
  return `${pathname}${search}`;
}

async function checkUrlAvailability(url) {
  const head = await fetchMeta(url, 'HEAD');
  if (head.ok) return { status: head.status, ok: true };
  const get = await fetchMeta(url, 'GET');
  return { status: get.status, ok: get.ok };
}

function getRefType(attr, url) {
  const pathname = new URL(url).pathname.toLowerCase();
  if (attr === 'src') return 'asset';
  if (/\.(css|js|mjs|png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|otf|pdf|mp4|webm|json|xml)$/i.test(pathname)) {
    return 'asset';
  }
  return 'link';
}

function normalizeRef(candidate, pageUrl, site) {
  if (!candidate) return null;
  const c = candidate.trim();
  if (!c || c.startsWith('#')) return null;
  if (/^(mailto:|tel:|javascript:|data:)/i.test(c)) return null;

  try {
    const u = new URL(c, pageUrl);
    if (!/^https?:$/i.test(u.protocol)) return null;
    if (`${u.protocol}//${u.host}` !== site.origin) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function extractRefsFromHtml(html, pageUrl, site) {
  const refs = [];
  const rx = /(href|src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const attr = (m[1] || '').toLowerCase();
    const raw = m[2] || '';
    const normalized = normalizeRef(raw, pageUrl, site);
    if (!normalized) continue;
    refs.push({ url: normalized, type: getRefType(attr, normalized) });
  }
  return refs;
}


function compareKeyForRef(url, type, site) {
  if (type === 'asset') {
    const u = new URL(url);
    const parts = (u.pathname || '/').split('/').filter(Boolean);
    return (parts.pop() || '/').toLowerCase();
  }
  return keyFromUrl(url, site.basePath, { includeQuery: false });
}

async function collectSiteReferences(site, sitemapUrls) {
  const refMap = new Map();
  const limiter = pLimit(8);

  await Promise.all(
    sitemapUrls.map((pageUrl) =>
      limiter(async () => {
        const page = await fetchMeta(pageUrl, 'GET');
        if (!page.ok || !/text\/html/i.test(page.contentType) || !page.body) return;

        const refs = extractRefsFromHtml(page.body, pageUrl, site);
        for (const r of refs) {
          // For refs we compare by path (ignore query) to avoid false "missing" results
          // caused by environment-specific cache-busting params.
          const normalizedKey = compareKeyForRef(r.url, r.type, site);
          const key = `${r.type}:${normalizedKey}`;
          if (!refMap.has(key)) {
            refMap.set(key, { key: normalizedKey, type: r.type, urls: new Set([r.url]) });
          } else {
            refMap.get(key).urls.add(r.url);
          }
        }
      })
    )
  );

  return [...refMap.values()].map((r) => ({ ...r, urls: [...r.urls] }));
}

function summarizeStatusCodes(rows, statusFieldA, statusFieldB) {
  const tally = {};
  for (const r of rows) {
    const a = r[statusFieldA];
    const b = r[statusFieldB];
    if (a != null) tally[a] = (tally[a] || 0) + 1;
    if (b != null) tally[b] = (tally[b] || 0) + 1;
  }
  return tally;
}

async function checkBestAvailability(urlCandidates = []) {
  if (!urlCandidates.length) return { status: null, ok: false, url: null };

  let best = { status: null, ok: false, url: urlCandidates[0] };
  for (const u of urlCandidates) {
    const result = await checkUrlAvailability(u);
    if (result.ok) return { ...result, url: u };
    if (best.status == null && result.status != null) best = { ...result, url: u };
  }

  return best;
}

app.post('/api/compare', async (req, res) => {
  try {
    const siteInputA = normalizeSiteInput(req.body?.urlA);
    const siteInputB = normalizeSiteInput(req.body?.urlB);

    const [siteA, siteB] = await Promise.all([
      collectSitemapUrls(siteInputA),
      collectSitemapUrls(siteInputB),
    ]);

    const mapA = new Map(siteA.urls.map((u) => [keyFromUrl(u, siteInputA.basePath), u]));
    const mapB = new Map(siteB.urls.map((u) => [keyFromUrl(u, siteInputB.basePath), u]));
    const allKeys = [...new Set([...mapA.keys(), ...mapB.keys()])].sort();

    const limiter = pLimit(12);
    const rows = await Promise.all(
      allKeys.map((key) =>
        limiter(async () => {
          const urlA = mapA.get(key) || null;
          const urlB = mapB.get(key) || null;

          const [checkA, checkB] = await Promise.all([
            urlA ? checkUrlAvailability(urlA) : Promise.resolve({ status: null, ok: false }),
            urlB ? checkUrlAvailability(urlB) : Promise.resolve({ status: null, ok: false }),
          ]);

          return {
            key,
            urlA,
            urlB,
            inA: Boolean(urlA),
            inB: Boolean(urlB),
            statusA: checkA.status,
            statusB: checkB.status,
            availableA: checkA.ok,
            availableB: checkB.ok,
            copySuccess: Boolean(urlA && urlB && checkA.ok && checkB.ok),
          };
        })
      )
    );

    const [refsA, refsB] = await Promise.all([
      collectSiteReferences(siteInputA, siteA.urls),
      collectSiteReferences(siteInputB, siteB.urls),
    ]);

    const refMapA = new Map(refsA.map((r) => [`${r.type}:${r.key}`, r.urls]));
    const refMapB = new Map(refsB.map((r) => [`${r.type}:${r.key}`, r.urls]));
    const allRefKeys = [...new Set([...refMapA.keys(), ...refMapB.keys()])].sort();

    const referenceRows = await Promise.all(
      allRefKeys.map((typedKey) =>
        limiter(async () => {
          const [type, key] = typedKey.split(':');
          const urlsA = refMapA.get(typedKey) || [];
          const urlsB = refMapB.get(typedKey) || [];

          const [checkA, checkB] = await Promise.all([
            urlsA.length ? checkBestAvailability(urlsA) : Promise.resolve({ status: null, ok: false, url: null }),
            urlsB.length ? checkBestAvailability(urlsB) : Promise.resolve({ status: null, ok: false, url: null }),
          ]);

          const urlA = checkA.url || urlsA[0] || null;
          const urlB = checkB.url || urlsB[0] || null;

          return {
            type,
            key,
            urlA,
            urlB,
            inA: Boolean(urlsA.length),
            inB: Boolean(urlsB.length),
            statusA: checkA.status,
            statusB: checkB.status,
            availableA: checkA.ok,
            availableB: checkB.ok,
            copySuccess: Boolean(urlA && urlB && checkA.ok && checkB.ok),
          };
        })
      )
    );

    const summary = {
      totalKeys: allKeys.length,
      onlyInA: rows.filter((r) => r.inA && !r.inB).length,
      onlyInB: rows.filter((r) => !r.inA && r.inB).length,
      presentInBoth: rows.filter((r) => r.inA && r.inB).length,
      copySuccess: rows.filter((r) => r.copySuccess).length,
      failedAvailability: rows.filter((r) => (r.inA && !r.availableA) || (r.inB && !r.availableB)).length,
      statusCodes: summarizeStatusCodes(rows, 'statusA', 'statusB'),
    };

    const referencesSummary = {
      totalRefs: allRefKeys.length,
      totalLinks: referenceRows.filter((r) => r.type === 'link').length,
      totalAssets: referenceRows.filter((r) => r.type === 'asset').length,
      onlyInA: referenceRows.filter((r) => r.inA && !r.inB).length,
      onlyInB: referenceRows.filter((r) => !r.inA && r.inB).length,
      presentInBoth: referenceRows.filter((r) => r.inA && r.inB).length,
      copySuccess: referenceRows.filter((r) => r.copySuccess).length,
      failedAvailability: referenceRows.filter((r) => (r.inA && !r.availableA) || (r.inB && !r.availableB)).length,
      statusCodes: summarizeStatusCodes(referenceRows, 'statusA', 'statusB'),
    };

    res.json({
      input: {
        siteA: siteInputA.normalized,
        siteB: siteInputB.normalized,
        basePathA: siteInputA.basePath,
        basePathB: siteInputB.basePath,
      },
      sitemaps: {
        siteA: siteA.sitemapFiles,
        siteB: siteB.sitemapFiles,
      },
      summary,
      rows,
      referencesSummary,
      referenceRows,
    });
  } catch (error) {
    res.status(400).json({
      error: error?.message || 'Unknown error while comparing sites',
    });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'wch-test-suite', version: '1.2.2' });
});

app.listen(PORT, () => {
  console.log(`Sitemap Copy Verifier running at http://localhost:${PORT}`);
});
