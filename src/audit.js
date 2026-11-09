// Lightweight surface-level website audit used by /api/audit.
//
// The Worker fetches one public HTML page, then checks response timing,
// compression, cache headers, SEO tags, security headers and mobile basics.
// Successful audit results are stored in Supabase using a server-side secret.

const MAX_REQUEST_BYTES = 4096;
const FETCH_TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

const GROUP_WEIGHTS = {
  performance: 0.3,
  seo: 0.3,
  security: 0.25,
  mobile: 0.15,
};

const STATUS_VALUE = { pass: 1, warn: 0.5, fail: 0 };

// Plain-English explanation and step-by-step fix shown for every issue.
// Keys match the check ids used in analyze().
const GUIDES = {
  ttfb: {
    why: 'Time to first byte measures how fast the server starts responding. Slow TTFB delays everything else on the page.',
    steps: [
      'Run the audit again with caching enabled to separate server speed from network latency.',
      'Put the site behind a CDN such as Cloudflare so the HTML is served from an edge close to the visitor.',
      'Cache rendered HTML at the edge or with a reverse proxy for a few minutes.',
      'Profile slow database queries and API calls on the origin, then add indexes and short-lived caches.',
      'Aim for TTFB under 500 ms and re-run the audit after each change.',
    ],
  },
  load: {
    why: 'This is how long the browser waited to receive the HTML. Render-blocking resources in the head make the page feel slower.',
    steps: [
      'Add defer to non-critical scripts, for example <script src="app.js" defer></script>.',
      'Use async only for independent scripts such as analytics.',
      'Inline critical CSS and load the rest with a preload or a media query.',
      'Combine and reduce the number of stylesheets loaded in the head.',
      'Load third-party widgets below the fold or after user interaction.',
    ],
  },
  size: {
    why: 'Large HTML documents take longer to download and parse, especially on mobile networks.',
    steps: [
      'Remove unused markup, hidden sections and duplicated components.',
      'Move inline script and style blocks into cacheable files.',
      'Trim long data blobs such as base64 images and inline JSON from the HTML.',
      'Aim for under 100 KB of HTML per page.',
    ],
  },
  compression: {
    why: 'Compression shrinks the HTML on the wire, often by 60 to 80 percent.',
    steps: [
      'Enable Brotli (preferred) or gzip in your server or CDN.',
      'On Cloudflare: Speed then Optimization then Brotli.',
      'On nginx: turn on gzip or brotli for text/html and other text types.',
      'Confirm responses now include Content-Encoding: br or gzip.',
    ],
  },
  caching: {
    why: 'Cache headers let browsers and CDNs reuse responses instead of downloading them again.',
    steps: [
      'For HTML send Cache-Control: public, max-age=300, stale-while-revalidate=60.',
      'For hashed assets send Cache-Control: public, max-age=31536000, immutable.',
      'Add ETag or Last-Modified so browsers can revalidate cheaply.',
      'Avoid no-store on pages you want cached.',
    ],
  },
  status: {
    why: 'Non-2xx responses and redirect chains waste time and can hide broken pages.',
    steps: [
      'Open the final URL and fix any server error shown.',
      'Update internal links that point to old URLs.',
      'Redirect HTTP to HTTPS and non-canonical hosts with a single 301.',
      'Remove redirect chains so the page resolves in one hop.',
    ],
  },
  title: {
    why: 'The title is the clickable headline in search results and browser tabs.',
    steps: [
      'Add a unique <title> inside the head of the page.',
      'Keep it 10 to 60 characters and lead with the main phrase.',
      'Include the brand at the end if it fits.',
      'Make every page title distinct.',
    ],
  },
  description: {
    why: 'The meta description is the snippet search engines often show under the title.',
    steps: [
      'Add <meta name="description" content="..."> inside the head.',
      'Write 50 to 160 characters that describe the page and include a benefit.',
      'Keep it unique per page and avoid duplicate descriptions.',
    ],
  },
  h1: {
    why: 'The H1 tells search engines and screen readers what the page is about.',
    steps: [
      'Add exactly one <h1> that matches the page topic.',
      'If there are multiple H1s, demote the extras to <h2>.',
      'Do not rely on a logo or image as the only H1.',
    ],
  },
  canonical: {
    why: 'A canonical URL tells search engines which version of a page to index.',
    steps: [
      'Add <link rel="canonical" href="https://example.com/page/"> in the head.',
      'Point it at the preferred absolute HTTPS URL.',
      'Keep it self-referencing on unique pages.',
      'Make it consistent with the URLs in sitemap.xml.',
    ],
  },
  lang: {
    why: 'The lang attribute helps search engines, screen readers and translation tools.',
    steps: [
      'Add lang to the html element, for example <html lang="en">.',
      'Use the correct code on each localized page (en, ro, ru).',
      'For mixed-language passages, add lang to the inner elements.',
    ],
  },
  'open-graph': {
    why: 'Open Graph tags control the preview shown when the page is shared.',
    steps: [
      'Add og:title, og:description and og:image meta tags.',
      'Use an absolute HTTPS image URL around 1200 by 630 pixels.',
      'Keep og:title under 60 characters and og:description under 200.',
      'Test the result with a link preview tool before sharing.',
    ],
  },
  'structured-data': {
    why: 'JSON-LD helps search engines understand your business, products and articles.',
    steps: [
      'Add a <script type="application/ld+json"> block with schema.org JSON.',
      'Use Organization or LocalBusiness on the homepage.',
      'Add Article, Product or FAQPage where relevant.',
      'Validate the markup with the Google Rich Results Test.',
    ],
  },
  'image-alt': {
    why: 'Alt text makes images accessible and gives search engines context.',
    steps: [
      'Add alt to every image, for example <img src="hero.png" alt="Team meeting">.',
      'Describe the image briefly, under about 125 characters.',
      'Use alt="" for purely decorative images.',
      'Avoid starting alt text with the words image of.',
    ],
  },
  indexability: {
    why: 'A noindex directive removes the page from search results.',
    steps: [
      'Find <meta name="robots" content="noindex"> and remove noindex.',
      'Check for an X-Robots-Tag response header that also sets noindex.',
      'Confirm robots.txt does not block the page.',
      'Request re-indexing after the fix.',
    ],
  },
  https: {
    why: 'HTTPS encrypts traffic and is required for trust, SEO and modern browser APIs.',
    steps: [
      'Install a TLS certificate, for example from Let\'s Encrypt or your host.',
      'Redirect all HTTP traffic to HTTPS with a 301.',
      'Update internal links and assets to use https://.',
      'Enable HSTS once HTTPS is stable.',
    ],
  },
  hsts: {
    why: 'HSTS tells browsers to always use HTTPS for your domain.',
    steps: [
      'Send Strict-Transport-Security: max-age=31536000; includeSubDomains.',
      'Start with a short max-age to test safely.',
      'Only add preload after every subdomain uses HTTPS.',
      'Confirm the header is present on HTTPS responses.',
    ],
  },
  csp: {
    why: 'A Content Security Policy limits which scripts and resources can run, reducing XSS risk.',
    steps: [
      'Start in report-only mode with Content-Security-Policy-Report-Only.',
      'List trusted sources for scripts, styles, images and fonts.',
      'Remove unsafe-inline by moving inline code to files or using nonces.',
      'Review the reports, then enforce with Content-Security-Policy.',
    ],
  },
  nosniff: {
    why: 'nosniff stops browsers from guessing content types, blocking some attacks.',
    steps: [
      'Send X-Content-Type-Options: nosniff on every response.',
      'Make sure files are served with the correct Content-Type header.',
    ],
  },
  frame: {
    why: 'Frame protection stops other sites from embedding yours in clickjacking attacks.',
    steps: [
      'Send X-Frame-Options: SAMEORIGIN, or',
      'Use CSP frame-ancestors \'self\' for finer control.',
      'Only allow external embedders if you truly need them.',
    ],
  },
  referrer: {
    why: 'Referrer-Policy controls how much URL information leaks to other sites.',
    steps: [
      'Send Referrer-Policy: strict-origin-when-cross-origin.',
      'Use no-referrer on sensitive pages.',
      'Verify the header on the live response.',
    ],
  },
  'mixed-content': {
    why: 'Loading http resources on an https page is blocked or warned about by browsers.',
    steps: [
      'Change every http:// resource URL to https://.',
      'Update CSS url(), srcset and poster attributes as well.',
      'Check that third-party widgets support HTTPS.',
      'Reload with the browser console open and fix remaining warnings.',
    ],
  },
  viewport: {
    why: 'The viewport tag makes the page scale correctly on phones and tablets.',
    steps: [
      'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
      'Do not disable zoom with user-scalable=no.',
      'Test at 360 pixels wide and in landscape.',
    ],
  },
  charset: {
    why: 'A charset declaration prevents garbled characters for non-ASCII text.',
    steps: [
      'Add <meta charset="utf-8"> as the first tag in the head.',
      'Save source files as UTF-8.',
      'Also send charset=utf-8 in the Content-Type header.',
    ],
  },
  favicon: {
    why: 'A favicon makes the site look complete in tabs, bookmarks and search results.',
    steps: [
      'Add <link rel="icon" href="/favicon.ico" sizes="any">.',
      'Provide a 32 by 32 PNG and a 180 by 180 apple-touch-icon.',
      'Reference the icons in the head of the page.',
    ],
  },
  'theme-color': {
    why: 'Theme color tints the browser UI on mobile for a more polished look.',
    steps: [
      'Add <meta name="theme-color" content="#050914">.',
      'Match the main color of your brand.',
      'Optionally add media variants for dark and light mode.',
    ],
  },
  doctype: {
    why: 'The HTML5 doctype makes browsers render the page in standards mode.',
    steps: [
      'Make <!doctype html> the very first line of the document.',
      'Remove anything before it, including comments or server output.',
      'Validate the page with the W3C validator.',
    ],
  },
};

class AuditError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AuditError';
    this.status = status;
  }
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function fail(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

function isPrivateHost(hostname) {
  let host = String(hostname || '').toLowerCase();

  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) return true;

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa')
  ) {
    return true;
  }

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }

  if (host.includes(':')) {
    if (
      host === '::' ||
      host === '::1' ||
      host.startsWith('::ffff:') ||
      host.startsWith('fe80:') ||
      host.startsWith('fc') ||
      host.startsWith('fd')
    ) {
      return true;
    }
    return false;
  }

  // Single-label hosts are almost always internal.
  return !host.includes('.');
}

function validatePublicUrl(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AuditError('Only http and https URLs can be audited.');
  }
  if (url.port) {
    throw new AuditError('Only standard web ports (80 and 443) are supported.');
  }
  if (url.username || url.password) {
    throw new AuditError('URLs containing usernames or passwords are not supported.');
  }
  if (isPrivateHost(url.hostname)) {
    throw new AuditError('Private and local addresses cannot be audited.');
  }

  url.hash = '';
  return url;
}

function normalizeTarget(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new AuditError('Enter a website URL to audit.');
  }

  let value = raw.trim();
  if (value.length > MAX_URL_LENGTH) {
    throw new AuditError('That URL is too long to audit.');
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AuditError('That does not look like a valid URL.');
  }

  return validatePublicUrl(url);
}

function resolveRedirect(location, base) {
  let next;
  try {
    next = new URL(location, base);
  } catch {
    throw new AuditError('The site returned an invalid redirect.', 502);
  }

  try {
    return validatePublicUrl(next);
  } catch (error) {
    if (error instanceof AuditError) {
      throw new AuditError('That site redirected to an address that cannot be audited.', 502);
    }
    throw error;
  }
}

async function discardBody(response) {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {}
}

async function fetchPage(startUrl, signal) {
  let current = startUrl;
  let redirects = 0;
  let redirectMs = 0;

  for (;;) {
    // fetch() resolves once response headers arrive, so this measures the
    // server response time (TTFB) for the request that produced the headers.
    const requestStarted = performance.now();
    const response = await fetch(current.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent':
          'MidnightWebsAudit/1.0 (+https://www.midnightwebs.com/web-audit/)',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const responseMs = performance.now() - requestStarted;

    if (response.status < 300 || response.status >= 400) {
      return {
        response,
        finalUrl: current.toString(),
        redirects,
        redirectMs,
        ttfb: responseMs,
      };
    }

    const location = response.headers.get('location');
    if (!location) {
      return {
        response,
        finalUrl: current.toString(),
        redirects,
        redirectMs,
        ttfb: responseMs,
      };
    }

    redirects += 1;
    if (redirects > MAX_REDIRECTS) {
      await discardBody(response);
      throw new AuditError('That site redirected too many times.', 502);
    }

    let next;
    try {
      next = resolveRedirect(location, current);
    } catch (error) {
      await discardBody(response);
      throw error;
    }

    redirectMs += responseMs;
    await discardBody(response);
    current = next;
  }
}

function attrsOf(tag) {
  const body = String(tag)
    .replace(/^<\s*[a-z0-9-]+/i, '')
    .replace(/\/?>\s*$/, '');

  const attrs = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;

  while ((match = re.exec(body))) {
    const name = match[1].toLowerCase();
    if (!name || name in attrs) continue;
    attrs[name] = match[2] ?? match[3] ?? match[4] ?? '';
  }

  return attrs;
}

function decodeCodePoint(value) {
  const point = Number(value);
  if (!Number.isFinite(point) || point < 0 || point > 0x10ffff) return '';
  try {
    return String.fromCodePoint(point);
  } catch {
    return '';
  }
}

function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => decodeCodePoint(code))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => decodeCodePoint(parseInt(code, 16)));
}

function cleanText(value) {
  return decodeEntities(value).replace(/\s+/g, ' ').trim();
}

function truncate(value, length = 120) {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function firstMatch(value, re) {
  const match = String(value).match(re);
  return match ? match[1] : '';
}

const MAX_EVIDENCE = 6;
const MAX_EVIDENCE_TEXT = 220;

function compactMarkup(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function lineNumberAt(html, index) {
  if (!Number.isFinite(index) || index < 0) return 0;
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (html.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function collectTags(html, pattern) {
  return [...String(html).matchAll(pattern)].map((match) => ({
    raw: match[0],
    attrs: attrsOf(match[0]),
    index: match.index,
  }));
}

// Replace HTML comments with spaces while keeping the same length and line
// breaks. This keeps match indexes aligned with the original HTML, so evidence
// line numbers stay correct, but tags inside comments are no longer counted.
function maskComments(html) {
  return String(html).replace(/<!--[\s\S]*?-->/g, (match) =>
    match.replace(/[^\n]/g, ' ')
  );
}

function firstSrcsetUrl(value) {
  const first = String(value || '').split(',')[0].trim();
  return first ? first.split(/\s+/)[0] : '';
}

function absoluteAssetUrl(value, base) {
  if (!value) return '';
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

function codeEvidence(html, raw, index, label) {
  const line = lineNumberAt(html, index);
  return {
    type: 'code',
    label: label || (line ? `HTML line ${line}` : 'HTML snippet'),
    text: truncate(compactMarkup(raw), MAX_EVIDENCE_TEXT),
    ...(line ? { line } : {}),
  };
}

function imageEvidence(html, raw, attrs, index, base, label) {
  const source = attrs.src || firstSrcsetUrl(attrs.srcset);
  return {
    ...codeEvidence(html, raw, index, label),
    type: 'image',
    src: absoluteAssetUrl(source, base) || undefined,
    alt: attrs.alt || '',
  };
}

function headerEvidence(label, value) {
  return {
    type: 'code',
    label,
    text: truncate(compactMarkup(value), MAX_EVIDENCE_TEXT),
  };
}

function evidenceList(items, total = 0) {
  const list = items.filter(Boolean).slice(0, MAX_EVIDENCE);
  if (total > list.length) {
    list.push(headerEvidence('More examples', `${total - list.length} more were found but not shown.`));
  }
  return list;
}

function inlineAssets(html) {
  const assets = [];

  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!match[1].trim()) continue;
    const opening = match[0].match(/^<script\b[^>]*>/i);
    assets.push({
      kind: 'script',
      bytes: match[1].length,
      raw: opening ? opening[0] : '<script>',
      index: match.index,
    });
  }
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    if (!match[1].trim()) continue;
    const opening = match[0].match(/^<style\b[^>]*>/i);
    assets.push({
      kind: 'style',
      bytes: match[1].length,
      raw: opening ? opening[0] : '<style>',
      index: match.index,
    });
  }

  return assets.sort((a, b) => b.bytes - a.bytes).slice(0, 3);
}

function inlineAssetTotals(html) {
  let scriptBytes = 0;
  let styleBytes = 0;
  let scriptCount = 0;
  let styleCount = 0;

  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!match[1].trim()) continue;
    scriptBytes += match[1].length;
    scriptCount += 1;
  }
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    if (!match[1].trim()) continue;
    styleBytes += match[1].length;
    styleCount += 1;
  }

  return { scriptBytes, styleBytes, scriptCount, styleCount };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function readLimited(response, limit) {
  if (!response.body) return { bytes: new Uint8Array(0), size: 0, truncated: false };

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (size + value.byteLength > limit) {
        const remaining = Math.max(0, limit - size);
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        size = limit;
        truncated = true;
        await reader.cancel();
        break;
      }

      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return { bytes, size, truncated };
}

function analyze({ target, response, body, ttfb, total, finalUrl, redirects = 0, redirectMs = 0 }) {
  const html = new TextDecoder('utf-8', { fatal: false }).decode(body.bytes);
  // Comments are masked (same length, same line breaks) so tags inside them are
  // not counted while evidence indexes still point at the original source.
  const scanHtml = maskComments(html);
  const headers = response.headers;
  const resolvedFinalUrl = finalUrl || response.url || target.toString();
  const pageIsHttps = resolvedFinalUrl.toLowerCase().startsWith('https://');
  const status = response.status;
  const contentType = (headers.get('content-type') || '').toLowerCase();

  const titleMatch = scanHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? cleanText(titleMatch[1]) : '';
  const htmlTagMatch = scanHtml.match(/<html\b[^>]*>/i);
  const htmlTag = htmlTagMatch ? htmlTagMatch[0] : '';
  const lang = htmlTag ? (attrsOf(htmlTag).lang || '') : '';

  const metaTags = collectTags(scanHtml, /<meta\b[^>]*>/gi);
  const metaMap = {};
  const metaByKey = {};
  let metaCharset = false;
  for (const meta of metaTags) {
    const attrs = meta.attrs;
    if ('charset' in attrs) metaCharset = true;
    const key = (attrs.name || attrs.property || attrs['http-equiv'] || '').toLowerCase();
    if (key && attrs.content !== undefined && !(key in metaMap)) {
      metaMap[key] = attrs.content;
      metaByKey[key] = meta;
    }
  }

  const linkTags = collectTags(scanHtml, /<link\b[^>]*>/gi);
  const canonicalTag = linkTags.find((link) =>
    (link.attrs.rel || '').toLowerCase().split(/\s+/).includes('canonical')
  );
  const canonical = canonicalTag?.attrs.href || '';
  const iconTags = linkTags.filter((link) =>
    /(^|\s)icon(\s|$)/i.test(link.attrs.rel || '')
  );
  const icons = iconTags.map((link) => link.attrs);
  const stylesheetTags = linkTags.filter((link) =>
    (link.attrs.rel || '').toLowerCase().split(/\s+/).includes('stylesheet')
  );

  const imageTags = collectTags(scanHtml, /<img\b[^>]*>/gi);
  const imagesMissingAltTags = imageTags.filter((image) => !('alt' in image.attrs));
  const imagesMissingAlt = imagesMissingAltTags.length;

  const scriptTags = collectTags(scanHtml, /<script\b[^>]*>/gi);
  const externalScriptTags = scriptTags.filter((script) => 'src' in script.attrs);
  const hasJsonLdTag = scriptTags.find((script) =>
    (script.attrs.type || '').toLowerCase().includes('application/ld+json')
  );
  const hasJsonLd = Boolean(hasJsonLdTag);

  const h1Tags = collectTags(scanHtml, /<h1\b[^>]*>/gi);
  const h1Blocks = collectTags(scanHtml, /<h1\b[^>]*>[\s\S]*?<\/h1>/gi);
  const h1Count = h1Tags.length;
  const h2Count = (scanHtml.match(/<h2\b/gi) || []).length;
  const linkCount = (scanHtml.match(/<a\b/gi) || []).length;

  const visibleText = scanHtml
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
  const wordCount = visibleText.trim().split(/\s+/).filter(Boolean).length;

  const charset = metaCharset || /charset=/i.test(contentType);
  const doctype = /<!doctype\s+html/i.test(scanHtml.slice(0, 500));
  const description = cleanText(metaMap.description || '');
  const viewport = cleanText(metaMap.viewport || '');
  const robots = cleanText(metaMap.robots || '');
  const themeColor = cleanText(metaMap['theme-color'] || '');

  const openGraph = ['og:title', 'og:description', 'og:image'].filter(
    (key) => metaMap[key] && metaMap[key].trim()
  );

  const contentEncoding = headers.get('content-encoding') || '';
  const contentLength = Number(headers.get('content-length') || 0);
  const cacheControl = headers.get('cache-control') || '';
  const etag = headers.get('etag') || '';
  const lastModified = headers.get('last-modified') || '';
  const expires = headers.get('expires') || '';
  const hsts = headers.get('strict-transport-security') || '';
  const csp = headers.get('content-security-policy') || '';
  const nosniff = /nosniff/i.test(headers.get('x-content-type-options') || '');
  const frameOptions =
    headers.get('x-frame-options') || (/frame-ancestors/i.test(csp) ? 'CSP frame-ancestors' : '');
  const referrerPolicy = headers.get('referrer-policy') || '';

  // fetch() decodes the body, so body.size is the decoded HTML size while
  // Content-Length is the size on the wire. Comparing the two only makes sense
  // when the body was fully read.
  const transferBytes = contentLength > 0 ? contentLength : null;
  const compressed =
    /br|gzip|deflate|zstd/i.test(contentEncoding) ||
    (transferBytes !== null &&
      !body.truncated &&
      body.size - transferBytes > 512 &&
      body.size > transferBytes * 1.1);

  const serverHeader = headers.get('server') || '';
  const nosniffHeader = headers.get('x-content-type-options') || '';

  const headMatch = scanHtml.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  const headHtml = headMatch ? headMatch[1] : '';
  const headOffset = headMatch ? headMatch.index + headMatch[0].indexOf(headHtml) : 0;
  const headScriptTags = collectTags(headHtml, /<script\b[^>]*>/gi);
  const headStylesheetTags = collectTags(headHtml, /<link\b[^>]*>/gi).filter((link) =>
    (link.attrs.rel || '').toLowerCase().split(/\s+/).includes('stylesheet')
  );
  const headBlockingScripts = headScriptTags.filter(
    (script) => !('async' in script.attrs) && !('defer' in script.attrs)
  );
  const renderBlockingCount = headBlockingScripts.length + headStylesheetTags.length;
  const inlineAssetExamples = inlineAssets(scanHtml);
  const largestInlineAsset = inlineAssetExamples[0];
  const inlineTotals = inlineAssetTotals(scanHtml);
  const inlineBytes = inlineTotals.scriptBytes + inlineTotals.styleBytes;
  const downloadMs = Math.max(0, total - ttfb - redirectMs);

  const mixedContentTags = [];
  if (pageIsHttps) {
    for (const tag of collectTags(
      scanHtml,
      /<(?:script|img|iframe|link|source|video|audio|embed)\b[^>]*>/gi
    )) {
      if (/(?:src|srcset|href|poster)\s*=\s*["']http:\/\//i.test(tag.raw)) {
        mixedContentTags.push(tag);
      }
    }
  }
  const mixedContent = mixedContentTags.length;

  const ttfbEvidence = [
    serverHeader ? headerEvidence('Server', serverHeader) : null,
    headerEvidence(
      'Timing',
      `TTFB ${Math.round(ttfb)} ms; redirects ${Math.round(redirectMs)} ms; total ${Math.round(total)} ms`
    ),
    cacheControl ? headerEvidence('Cache-Control', cacheControl) : null,
  ];

  const loadEvidence = [
    headerEvidence(
      'Transfer',
      `${formatBytes(body.size)} of HTML in ${Math.round(total)} ms (download ${Math.round(
        downloadMs
      )} ms after TTFB)`
    ),
    ...headBlockingScripts.slice(0, 2).map((script) =>
      codeEvidence(html, script.raw, script.index + headOffset, 'Render-blocking script in <head>')
    ),
    ...headStylesheetTags.slice(0, 2).map((link) =>
      codeEvidence(html, link.raw, link.index + headOffset, 'Render-blocking stylesheet in <head>')
    ),
  ];

  const sizeEvidence = [
    body.truncated
      ? headerEvidence(
          'Read limit',
          `The HTML was larger than ${formatBytes(MAX_HTML_BYTES)}; only the first part was analyzed.`
        )
      : null,
    ...inlineAssetExamples.map((asset) =>
      codeEvidence(html, asset.raw, asset.index, `${formatBytes(asset.bytes)} inline <${asset.kind}>`)
    ),
    ...(!inlineAssetExamples.length
      ? [headerEvidence('Inline code', 'No inline <script> or <style> blocks were found.')]
      : []),
  ];

  const compressionEvidence = [
    contentEncoding ? headerEvidence('Content-Encoding', contentEncoding) : null,
    transferBytes !== null
      ? headerEvidence(
          'Transfer size',
          `Content-Length ${formatBytes(transferBytes)}; decoded HTML ${formatBytes(body.size)}`
        )
      : headerEvidence('Transfer size', `Decoded HTML ${formatBytes(body.size)}; no Content-Length returned`),
    !compressed
      ? headerEvidence(
          'Missing header',
          'No Content-Encoding: br, gzip, deflate or zstd header was returned.'
        )
      : null,
  ];

  const statusEvidence = [
    headerEvidence('Response', `HTTP ${status}${response.redirected ? ' after redirects' : ''}`),
    redirects > 0 ? headerEvidence('Redirects followed', String(redirects)) : null,
  ];

  const titleEvidence = titleMatch
    ? [codeEvidence(html, titleMatch[0], titleMatch.index, 'Title tag')]
    : [headerEvidence('Missing element', 'No <title>...</title> element was found.')];

  const descriptionEvidence = metaByKey.description
    ? [codeEvidence(html, metaByKey.description.raw, metaByKey.description.index, 'Meta description')]
    : [headerEvidence('Missing tag', 'No <meta name="description" content="..."> tag was found.')];

  const h1Evidence = h1Count
    ? evidenceList(
        (h1Blocks.length ? h1Blocks : h1Tags)
          .slice(0, MAX_EVIDENCE)
          .map((tag, index) =>
            codeEvidence(html, tag.raw, tag.index, `<h1> heading #${index + 1}`)
          ),
        h1Count
      )
    : [headerEvidence('Missing element', 'No <h1>...</h1> heading was found.')];

  const canonicalEvidence = canonicalTag
    ? [codeEvidence(html, canonicalTag.raw, canonicalTag.index, 'Canonical link')]
    : [headerEvidence('Missing tag', 'No <link rel="canonical" href="..."> tag was found.')];

  const langEvidence = htmlTag
    ? [codeEvidence(html, htmlTag, htmlTagMatch.index, 'HTML element')]
    : [headerEvidence('Missing element', 'No <html lang="..."> element was found.')];

  const openGraphEvidence = ['og:title', 'og:description', 'og:image'].map((key) => {
    const tag = metaByKey[key];
    return tag
      ? codeEvidence(html, tag.raw, tag.index, key)
      : headerEvidence('Missing tag', `No <meta property="${key}" content="..."> tag was found.`);
  });

  const structuredDataEvidence = hasJsonLdTag
    ? [codeEvidence(html, hasJsonLdTag.raw, hasJsonLdTag.index, 'JSON-LD script')]
    : [
        headerEvidence(
          'Missing element',
          'No <script type="application/ld+json"> block was found.'
        ),
      ];

  const imageAltEvidence =
    imageTags.length === 0
      ? [headerEvidence('Images', 'No <img> tags were found on the page.')]
      : evidenceList(
          imagesMissingAltTags.slice(0, MAX_EVIDENCE).map((image) =>
            imageEvidence(
              html,
              image.raw,
              image.attrs,
              image.index,
              resolvedFinalUrl,
              'Missing alt attribute'
            )
          ),
          imagesMissingAltTags.length
        );

  const robotsTag = metaByKey.robots || metaByKey.googlebot;
  const indexabilityEvidence = robotsTag
    ? [codeEvidence(html, robotsTag.raw, robotsTag.index, 'Meta robots')]
    : [headerEvidence('Missing directive', 'No noindex directive was found in meta robots.')];

  const httpsEvidence = [headerEvidence('Final URL', resolvedFinalUrl)];

  const hstsEvidence = hsts
    ? [headerEvidence('Strict-Transport-Security', hsts)]
    : [headerEvidence('Missing header', 'Strict-Transport-Security was not returned.')];

  const cspEvidence = csp
    ? [headerEvidence('Content-Security-Policy', csp)]
    : [headerEvidence('Missing header', 'Content-Security-Policy was not returned.')];

  const nosniffEvidence = nosniff
    ? [headerEvidence('X-Content-Type-Options', nosniffHeader)]
    : [headerEvidence('Missing header', 'X-Content-Type-Options: nosniff was not returned.')];

  const frameEvidence = frameOptions
    ? [headerEvidence('Frame protection', frameOptions)]
    : [
        headerEvidence(
          'Missing header',
          'No X-Frame-Options or CSP frame-ancestors directive was returned.'
        ),
      ];

  const referrerEvidence = referrerPolicy
    ? [headerEvidence('Referrer-Policy', referrerPolicy)]
    : [headerEvidence('Missing header', 'Referrer-Policy was not returned.')];

  const mixedContentEvidence = !pageIsHttps
    ? [
        headerEvidence(
          'Not applicable',
          'The final page is served over HTTP, so mixed content was not evaluated.'
        ),
      ]
    : mixedContentTags.length
      ? evidenceList(
          mixedContentTags.slice(0, MAX_EVIDENCE).map((tag) => {
            const isImage = /^<img\b/i.test(tag.raw);
            return isImage
              ? imageEvidence(
                  html,
                  tag.raw,
                  tag.attrs,
                  tag.index,
                  resolvedFinalUrl,
                  'Insecure image over HTTP'
                )
              : codeEvidence(html, tag.raw, tag.index, 'Insecure resource over HTTP');
          }),
          mixedContentTags.length
        )
      : [headerEvidence('Checked', 'No http:// resources were found in the HTML.')];

  const viewportEvidence = metaByKey.viewport
    ? [codeEvidence(html, metaByKey.viewport.raw, metaByKey.viewport.index, 'Viewport meta tag')]
    : [headerEvidence('Missing tag', 'No <meta name="viewport" ...> tag was found.')];

  const charsetTag = metaTags.find((meta) => 'charset' in meta.attrs) || metaByKey['content-type'];
  const charsetEvidence = charsetTag
    ? [codeEvidence(html, charsetTag.raw, charsetTag.index, 'Charset declaration')]
    : /charset=/i.test(contentType)
      ? [headerEvidence('Content-Type', contentType)]
      : [
          headerEvidence(
            'Missing declaration',
            'No <meta charset="utf-8"> tag or charset in Content-Type was found.'
          ),
        ];

  const faviconEvidence = icons.length
    ? evidenceList(
        iconTags.slice(0, MAX_EVIDENCE).map((tag) =>
          codeEvidence(html, tag.raw, tag.index, 'Favicon link')
        ),
        icons.length
      )
    : [headerEvidence('Missing tag', 'No <link rel="icon" ...> tag was found.')];

  const themeColorEvidence = metaByKey['theme-color']
    ? [
        codeEvidence(
          html,
          metaByKey['theme-color'].raw,
          metaByKey['theme-color'].index,
          'Theme color meta tag'
        ),
      ]
    : [headerEvidence('Missing tag', 'No <meta name="theme-color" ...> tag was found.')];

  const firstTagEnd = html.indexOf('>');
  const doctypeSnippet = firstTagEnd >= 0 ? html.slice(0, firstTagEnd + 1) : html.slice(0, 160);
  const doctypeEvidence = doctype
    ? [codeEvidence(html, doctypeSnippet, 0, 'Document type')]
    : [headerEvidence('Missing doctype', 'The document does not start with <!doctype html>.')];

  const checks = [];
  const add = (group, id, label, state, detail, fix, weight = 10, evidence = []) => {
    const guide = state !== 'pass' ? GUIDES[id] : null;
    checks.push({
      group,
      id,
      label,
      status: state,
      detail,
      fix,
      weight,
      evidence: evidence.filter(Boolean),
      ...(guide ? { why: guide.why, steps: guide.steps } : {}),
    });
  };

  add(
    'performance',
    'ttfb',
    'Server response time',
    ttfb <= 500 ? 'pass' : ttfb <= 1200 ? 'warn' : 'fail',
    `${Math.round(ttfb)} ms to first byte`,
    'Use a CDN and server-side caching to cut response time.',
    25,
    ttfbEvidence
  );
  add(
    'performance',
    'load',
    'Page download time',
    total <= 1500 ? 'pass' : total <= 3500 ? 'warn' : 'fail',
    `${Math.round(total)} ms total (${Math.round(ttfb)} ms TTFB${
      redirectMs >= 1 ? `, ${Math.round(redirectMs)} ms redirects` : ''
    }, ${Math.round(downloadMs)} ms download)${
      renderBlockingCount
        ? `; ${renderBlockingCount} render-blocking resource${renderBlockingCount === 1 ? '' : 's'} in <head>`
        : ''
    }`,
    'Reduce page weight and load non-critical scripts with defer or async, for example <script src="app.js" defer></script>.',
    20,
    loadEvidence
  );
  add(
    'performance',
    'size',
    'HTML page size',
    body.size <= 100 * 1024 ? 'pass' : body.size <= 300 * 1024 ? 'warn' : 'fail',
    `${formatBytes(body.size)} of HTML${body.truncated ? ' (read limit reached)' : ''}${
      transferBytes !== null && transferBytes < body.size
        ? ` (${formatBytes(transferBytes)} transferred)`
        : ''
    }${
      largestInlineAsset
        ? `; largest inline <${largestInlineAsset.kind}> is ${formatBytes(largestInlineAsset.bytes)}`
        : ''
    }${inlineBytes ? `; ${formatBytes(inlineBytes)} of inline code in total` : ''}`,
    'Remove unused markup and move inline code into cached files, for example <script src="app.js" defer></script>.',
    15,
    sizeEvidence
  );
  add(
    'performance',
    'compression',
    'Compression',
    compressed ? 'pass' : 'warn',
    compressed
      ? contentEncoding
        ? `Served with ${contentEncoding}`
        : 'Transfer size suggests compression is enabled'
      : 'No compression detected on the HTML response',
    'Enable Brotli or gzip on your server or CDN.',
    15,
    compressionEvidence
  );

  const cacheSignals = [];
  if (cacheControl) cacheSignals.push('Cache-Control');
  if (etag) cacheSignals.push('ETag');
  if (lastModified) cacheSignals.push('Last-Modified');
  if (expires) cacheSignals.push('Expires');

  const cacheEvidence = [
    cacheControl ? headerEvidence('Cache-Control', cacheControl) : null,
    etag ? headerEvidence('ETag', etag) : null,
    lastModified ? headerEvidence('Last-Modified', lastModified) : null,
    expires ? headerEvidence('Expires', expires) : null,
    !cacheSignals.length
      ? headerEvidence(
          'Missing headers',
          'No Cache-Control, ETag, Last-Modified or Expires header was returned.'
        )
      : null,
  ];

  add(
    'performance',
    'caching',
    'Cache headers',
    cacheSignals.length ? 'pass' : 'warn',
    cacheSignals.length
      ? `Found ${cacheSignals.join(', ')}`
      : 'No cache or revalidation headers found',
    'Send Cache-Control: public, max-age=300 for HTML and Cache-Control: public, max-age=31536000, immutable for hashed assets.',
    10,
    cacheEvidence
  );
  add(
    'performance',
    'status',
    'HTTP status',
    status >= 200 && status < 300 ? 'pass' : status < 400 ? 'warn' : 'fail',
    `Final response returned HTTP ${status}${
      redirects > 0 ? ` after ${redirects} redirect${redirects === 1 ? '' : 's'}` : ''
    }`,
    'Fix broken pages and unnecessary redirects.',
    10,
    statusEvidence
  );

  const titleState =
    !title ? 'fail' : title.length >= 10 && title.length <= 60 ? 'pass' : 'warn';
  add(
    'seo',
    'title',
    'Title tag',
    titleState,
    title ? `“${truncate(title, 90)}” (${title.length} characters)` : 'No <title> tag found',
    'Write a unique 10–60 character title that includes your main phrase.',
    20,
    titleEvidence
  );

  const descriptionState =
    !description
      ? 'fail'
      : description.length >= 50 && description.length <= 160
        ? 'pass'
        : 'warn';
  add(
    'seo',
    'description',
    'Meta description',
    descriptionState,
    description
      ? `“${truncate(description, 90)}” (${description.length} characters)`
      : 'No meta description found',
    'Add a 50–160 character description that earns the click.',
    20,
    descriptionEvidence
  );

  add(
    'seo',
    'h1',
    'Primary heading',
    h1Count === 1 ? 'pass' : 'warn',
    h1Count === 0
      ? 'No <h1> heading found'
      : `${h1Count} <h1> heading${h1Count === 1 ? '' : 's'} found`,
    'Use exactly one descriptive <h1> per page.',
    15,
    h1Evidence
  );

  add(
    'seo',
    'canonical',
    'Canonical URL',
    canonical ? 'pass' : 'warn',
    canonical ? truncate(canonical, 100) : 'No canonical link found',
    'Add <link rel="canonical" href="https://example.com/your-page/"> to the preferred version of the page.',
    10,
    canonicalEvidence
  );

  add(
    'seo',
    'lang',
    'Page language',
    lang ? 'pass' : 'warn',
    lang ? `Language declared as “${lang}”` : 'No lang attribute on the <html> element',
    'Declare the page language, for example <html lang="en">.',
    10,
    langEvidence
  );

  add(
    'seo',
    'open-graph',
    'Social sharing tags',
    openGraph.length === 3 ? 'pass' : 'warn',
    openGraph.length
      ? `Found ${openGraph.join(', ')}`
      : 'No Open Graph title, description or image found',
    'Add <meta property="og:title">, <meta property="og:description"> and <meta property="og:image"> tags for better link previews.',
    10,
    openGraphEvidence
  );

  add(
    'seo',
    'structured-data',
    'Structured data',
    hasJsonLd ? 'pass' : 'warn',
    hasJsonLd ? 'JSON-LD structured data found' : 'No JSON-LD structured data found',
    'Add schema.org JSON-LD for your business, products or articles.',
    5,
    structuredDataEvidence
  );

  add(
    'seo',
    'image-alt',
    'Image alt text',
    imageTags.length === 0
      ? 'pass'
      : imagesMissingAlt === 0
        ? 'pass'
        : imagesMissingAlt / imageTags.length > 0.5
          ? 'fail'
          : 'warn',
    imageTags.length === 0
      ? 'No images found'
      : `${imagesMissingAlt} of ${imageTags.length} images missing an alt attribute`,
    'Add short alt text to meaningful images and an empty alt to decorative ones, for example <img src="hero.png" alt="Team meeting">.',
    10,
    imageAltEvidence
  );

  add(
    'seo',
    'indexability',
    'Search indexability',
    /noindex/i.test(robots) ? 'fail' : 'pass',
    /noindex/i.test(robots)
      ? `Meta robots says “${truncate(robots, 80)}”`
      : robots
        ? `Meta robots: “${truncate(robots, 80)}”`
        : 'No noindex directive found',
    'Remove noindex if this page should appear in search results.',
    10,
    indexabilityEvidence
  );

  add(
    'security',
    'https',
    'HTTPS',
    pageIsHttps ? 'pass' : 'fail',
    pageIsHttps ? 'The page is served over HTTPS' : 'The final page is served over HTTP',
    'Serve every page over HTTPS and redirect HTTP visitors.',
    30,
    httpsEvidence
  );

  add(
    'security',
    'hsts',
    'HSTS',
    hsts ? 'pass' : 'warn',
    hsts ? 'Strict-Transport-Security header present' : 'No HSTS header found',
    'Add Strict-Transport-Security: max-age=31536000; includeSubDomains once HTTPS is stable.',
    20,
    hstsEvidence
  );

  add(
    'security',
    'csp',
    'Content Security Policy',
    csp ? 'pass' : 'warn',
    csp ? 'Content-Security-Policy header present' : 'No Content-Security-Policy header found',
    `Add Content-Security-Policy: default-src 'self'; script-src 'self' to limit script sources.`,
    20,
    cspEvidence
  );

  add(
    'security',
    'nosniff',
    'MIME sniffing protection',
    nosniff ? 'pass' : 'warn',
    nosniff ? 'X-Content-Type-Options: nosniff is set' : 'No nosniff header found',
    'Send X-Content-Type-Options: nosniff.',
    10,
    nosniffEvidence
  );

  add(
    'security',
    'frame',
    'Clickjacking protection',
    frameOptions ? 'pass' : 'warn',
    frameOptions
      ? `Protected with ${frameOptions}`
      : 'No X-Frame-Options or CSP frame-ancestors directive found',
    'Add X-Frame-Options: SAMEORIGIN or a CSP frame-ancestors rule.',
    10,
    frameEvidence
  );

  add(
    'security',
    'referrer',
    'Referrer policy',
    referrerPolicy ? 'pass' : 'warn',
    referrerPolicy
      ? `Referrer-Policy: ${truncate(referrerPolicy, 80)}`
      : 'No Referrer-Policy header found',
    'Add Referrer-Policy: strict-origin-when-cross-origin.',
    10,
    referrerEvidence
  );

  add(
    'security',
    'mixed-content',
    'Mixed content',
    !pageIsHttps ? 'warn' : mixedContent === 0 ? 'pass' : 'fail',
    !pageIsHttps
      ? 'Not applicable until the page uses HTTPS'
      : mixedContent === 0
        ? 'No insecure resources detected'
        : `${mixedContent} insecure resource${mixedContent === 1 ? '' : 's'} found`,
    'Change every http:// resource URL to https:// and confirm the page loads with no mixed-content warnings.',
    15,
    mixedContentEvidence
  );

  add(
    'mobile',
    'viewport',
    'Mobile viewport',
    /width\s*=\s*device-width/i.test(viewport)
      ? 'pass'
      : viewport
        ? 'warn'
        : 'fail',
    viewport ? truncate(viewport, 100) : 'No viewport meta tag found',
    'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
    30,
    viewportEvidence
  );

  add(
    'mobile',
    'charset',
    'Character encoding',
    charset ? 'pass' : 'warn',
    charset ? 'A character encoding is declared' : 'No charset declaration found',
    'Declare UTF-8 with <meta charset="utf-8">.',
    20,
    charsetEvidence
  );

  add(
    'mobile',
    'favicon',
    'Favicon',
    icons.length ? 'pass' : 'warn',
    icons.length ? `${icons.length} icon link${icons.length === 1 ? '' : 's'} found` : 'No favicon link found',
    'Add <link rel="icon" href="/favicon.ico"> so your site looks complete in tabs and bookmarks.',
    15,
    faviconEvidence
  );

  add(
    'mobile',
    'theme-color',
    'Browser theme color',
    themeColor ? 'pass' : 'warn',
    themeColor ? `Theme color set to ${truncate(themeColor, 40)}` : 'No theme-color meta tag found',
    'Add <meta name="theme-color" content="#050914"> that matches your brand.',
    5,
    themeColorEvidence
  );

  add(
    'mobile',
    'doctype',
    'HTML doctype',
    doctype ? 'pass' : 'warn',
    doctype ? 'HTML5 doctype found' : 'No HTML5 doctype found',
    'Start the document with <!doctype html>.',
    10,
    doctypeEvidence
  );

  const scores = {};
  for (const group of Object.keys(GROUP_WEIGHTS)) {
    const items = checks.filter((check) => check.group === group);
    const weight = items.reduce((sum, check) => sum + check.weight, 0);
    const earned = items.reduce(
      (sum, check) => sum + STATUS_VALUE[check.status] * check.weight,
      0
    );
    scores[group] = weight ? Math.round((earned / weight) * 100) : 0;
  }
  scores.overall = Math.round(
    Object.entries(GROUP_WEIGHTS).reduce(
      (sum, [group, weight]) => sum + scores[group] * weight,
      0
    )
  );

  return {
    ok: true,
    target: target.toString(),
    finalUrl: resolvedFinalUrl,
    checkedAt: new Date().toISOString(),
    scores,
    counts: {
      pass: checks.filter((check) => check.status === 'pass').length,
      warn: checks.filter((check) => check.status === 'warn').length,
      fail: checks.filter((check) => check.status === 'fail').length,
    },
    metrics: {
      ttfbMs: Math.round(ttfb),
      redirectMs: Math.round(redirectMs),
      downloadMs: Math.round(downloadMs),
      totalMs: Math.round(total),
      htmlBytes: body.size,
      transferBytes,
      htmlTruncated: body.truncated,
      status,
      contentType,
      pageIsHttps,
      redirected: redirects > 0 || response.redirected,
      redirects,
      server: headers.get('server') || null,
      contentEncoding: contentEncoding || null,
      cacheControl: cacheControl || null,
      compressed,
      renderBlockingCount,
      inlineBytes,
      inlineScriptBytes: inlineTotals.scriptBytes,
      inlineStyleBytes: inlineTotals.styleBytes,
    },
    page: {
      title,
      description,
      lang,
      canonical,
      viewport,
      robots,
      themeColor,
      h1Count,
      h2Count,
      imageCount: imageTags.length,
      imagesMissingAlt,
      wordCount,
      linkCount,
      hasJsonLd,
      openGraph,
      scriptCount: scriptTags.length,
      externalScriptCount: externalScriptTags.length,
      stylesheetCount: stylesheetTags.length,
      inlineScriptCount: inlineTotals.scriptCount,
      inlineStyleCount: inlineTotals.styleCount,
    },
    checks,
  };
}

export async function handleAuditRequest(request, env, ctx) {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Method Not Allowed' }, 405, { Allow: 'POST' });
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return fail('Send the URL as JSON.', 415);
  }

  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    return fail('Request body is too large.', 413);
  }

  const raw = await request.text();
  if (raw.length > MAX_REQUEST_BYTES) {
    return fail('Request body is too large.', 413);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return fail('Invalid JSON body.');
  }

  let target;
  try {
    target = normalizeTarget(payload?.url);
  } catch (error) {
    if (error instanceof AuditError) return fail(error.message, error.status);
    return fail('That URL could not be audited.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const started = performance.now();

  let response;
  let body;
  let ttfb;
  let finalUrl;
  let redirects = 0;
  let redirectMs = 0;

  try {
    const page = await fetchPage(target, controller.signal);
    response = page.response;
    finalUrl = page.finalUrl;
    redirects = page.redirects;
    redirectMs = page.redirectMs;

    // TTFB for the final response only, so redirects do not inflate it.
    ttfb = page.ttfb;
    body = await readLimited(response, MAX_HTML_BYTES);
  } catch (error) {
    if (error instanceof AuditError) return fail(error.message, error.status);
    if (error?.name === 'AbortError') {
      return fail('The site took too long to respond. Try again or test another page.', 504);
    }
    return fail('We could not reach that site. Check the URL and try again.', 502);
  } finally {
    clearTimeout(timer);
  }

  const total = performance.now() - started;
  const responseType = (response.headers.get('content-type') || '').toLowerCase();
  const preview = new TextDecoder('utf-8', { fatal: false })
    .decode(body.bytes.subarray(0, 256))
    .trim()
    .toLowerCase();
  const looksHtml =
    responseType.includes('text/html') ||
    responseType.includes('application/xhtml') ||
    preview.startsWith('<!doctype html') ||
    preview.startsWith('<html');

  if (!looksHtml) {
    return fail(
      `That URL returned ${responseType || 'an unknown content type'} instead of an HTML page.`,
      422
    );
  }

  try {
    const result = analyze({
      target,
      response,
      body,
      ttfb,
      total,
      finalUrl,
      redirects,
      redirectMs,
    });
    await persistAudit(result, env);
    return json(result);
  } catch (error) {
    console.error('Audit analysis failed:', error);
    return fail('The page was reached, but the audit could not be completed.', 500);
  }
}

function sanitizeUrlForStorage(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function sanitizeTextForStorage(value) {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => {
    const cleaned = match.replace(/[.,;:!?]+$/, '');
    const suffix = match.slice(cleaned.length);
    const sanitized = sanitizeUrlForStorage(cleaned);
    return sanitized ? `${sanitized}${suffix}` : cleaned;
  });
}

function sanitizeForStorage(value) {
  if (typeof value === 'string') return sanitizeTextForStorage(value);
  if (Array.isArray(value)) return value.map(sanitizeForStorage);
  if (value && typeof value === 'object') {
    const sanitized = {};
    for (const [key, item] of Object.entries(value)) {
      sanitized[key] = sanitizeForStorage(item);
    }
    return sanitized;
  }
  return value;
}

async function persistAudit(result, env) {
  const supabaseUrl = env?.SUPABASE_URL;
  const serviceRoleKey = env?.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl) {
    console.error('Audit storage is not configured: SUPABASE_URL is missing.');
    return false;
  }
  if (!serviceRoleKey) {
    console.error('Audit storage is not configured: SUPABASE_SERVICE_ROLE_KEY is missing.');
    return false;
  }

  let base;
  try {
    base = new URL(supabaseUrl);
  } catch {
    console.error('Audit storage URL is invalid.');
    return false;
  }

  if (
    base.protocol !== 'https:' ||
    base.port ||
    base.username ||
    base.password ||
    isPrivateHost(base.hostname)
  ) {
    console.error('Audit storage URL must be a public HTTPS URL.');
    return false;
  }

  let endpoint;
  try {
    endpoint = new URL('/rest/v1/audits', base);
  } catch {
    console.error('Audit storage URL is invalid.');
    return false;
  }

  const safeResult = sanitizeForStorage(result);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const headers = {
      apikey: serviceRoleKey,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    };
    // New Supabase secret API keys are not JWTs, so they must not be sent as
    // Authorization: Bearer. Legacy service_role keys are JWTs and still use it.
    if (!serviceRoleKey.startsWith('sb_secret_')) {
      headers.Authorization = `Bearer ${serviceRoleKey}`;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        target_url: safeResult.target,
        final_url: safeResult.finalUrl,
        result: safeResult,
        created_at: safeResult.checkedAt,
      }),
    });
    if (response.status >= 300 && response.status < 400) {
      console.error('Audit storage request was redirected.');
      return false;
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      console.error('Audit storage request failed with status:', response.status, detail);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Audit storage request failed:', error?.message || 'network error');
    return false;
  } finally {
    clearTimeout(timer);
  }
}
