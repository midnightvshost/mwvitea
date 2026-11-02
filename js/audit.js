(() => {
  const form = document.querySelector('#auditForm');
  if (!form) return;

  const input = document.querySelector('#auditUrl');
  const submit = document.querySelector('#auditSubmit');
  const errorEl = document.querySelector('#auditError');
  const loadingEl = document.querySelector('#auditLoading');
  const loadingText = document.querySelector('#auditLoadingText');
  const resultsEl = document.querySelector('#auditResults');
  const resultsTitle = document.querySelector('#auditResultsTitle');
  const resultsUrl = document.querySelector('#auditResultsUrl');
  const scoreEl = document.querySelector('#auditScore');
  const scoreValue = document.querySelector('#auditScoreValue');
  const verdictEl = document.querySelector('#auditVerdict');
  const verdictCopy = document.querySelector('#auditVerdictCopy');
  const factsEl = document.querySelector('#auditFacts');
  const categoriesEl = document.querySelector('#auditCategories');
  const detailsEl = document.querySelector('#auditDetails');
  const againBtn = document.querySelector('#auditAgain');
  const downloadBtn = document.querySelector('#auditDownload');

  const GROUP_LABELS = {
    performance: 'Performance',
    seo: 'SEO',
    security: 'Security',
    mobile: 'Mobile',
  };

  const GROUP_ORDER = ['performance', 'seo', 'security', 'mobile'];
  const STATUS_LABELS = { pass: 'Pass', warn: 'Improve', fail: 'Fix' };
  const LOGO_URL = '/assets/img/logowhite.png';
  const LOADING_MESSAGES = [
    'Fetching the page…',
    'Measuring response time…',
    'Checking SEO tags…',
    'Reviewing security headers…',
  ];

  let loadingTimer = null;
  let requestController = null;
  let lastAudit = null;
  let logoDataUrl = '';

  async function getLogoDataUrl() {
    if (logoDataUrl) return logoDataUrl;

    const response = await fetch(LOGO_URL, { cache: 'force-cache' });
    if (!response.ok) return '';

    const blob = await response.blob();
    logoDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Could not read logo.'));
      reader.readAsDataURL(blob);
    });

    return logoDataUrl;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setError(message) {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }

  function startLoading() {
    let index = 0;
    form.setAttribute('aria-busy', 'true');
    loadingText.textContent = LOADING_MESSAGES[0];
    loadingEl.hidden = false;
    window.clearInterval(loadingTimer);
    loadingTimer = window.setInterval(() => {
      index = (index + 1) % LOADING_MESSAGES.length;
      loadingText.textContent = LOADING_MESSAGES[index];
    }, 1800);
  }

  function stopLoading() {
    window.clearInterval(loadingTimer);
    loadingTimer = null;
    loadingEl.hidden = true;
    form.removeAttribute('aria-busy');
  }

  function normalizeUrl(raw) {
    let value = String(raw || '').trim();
    if (!value) throw new Error('Enter a website URL to audit.');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;

    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error('That does not look like a valid URL.');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Only http and https URLs can be audited.');
    }
    if (!url.hostname.includes('.') && !url.hostname.includes(':')) {
      throw new Error('Enter a full domain, for example example.com.');
    }

    return url.toString();
  }

  function scoreColor(score) {
    if (score >= 80) return '#5ee1a5';
    if (score >= 50) return '#f5c56b';
    return '#ff8080';
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function categoryCopy(score) {
    if (score >= 80) return 'Strong foundations.';
    if (score >= 60) return 'Mostly solid, with a few fixes.';
    if (score >= 40) return 'Several improvements are worth making.';
    return 'Needs attention.';
  }

  function verdictFor(score, counts) {
    let title = 'Needs attention';
    if (score >= 90) title = 'Excellent shape';
    else if (score >= 75) title = 'Good foundations';
    else if (score >= 50) title = 'Needs some work';

    return {
      title,
      copy: `${counts.pass} passed · ${counts.warn} to improve · ${counts.fail} to fix.`,
    };
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function reportValue(value, fallback = '&mdash;') {
    const text = value == null ? '' : String(value).trim();
    return text ? escapeHtml(text) : fallback;
  }

  function reportRows(rows) {
    return rows
      .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`)
      .join('');
  }

  function reportFileName(data) {
    let host = 'website';
    try {
      host = new URL(data.finalUrl || data.target).hostname || host;
    } catch {}
    const safeHost = host.replace(/[^a-z0-9.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'website';
    const stamp = new Date().toISOString().slice(0, 10);
    return `midnight-webs-audit-${safeHost}-${stamp}.doc`;
  }

  function buildReportDocument(data, logo) {
    const score = Number(data.scores.overall) || 0;
    const verdict = verdictFor(score, data.counts);
    const checkedAt = data.checkedAt ? new Date(data.checkedAt) : new Date();
    const checkedLabel = Number.isNaN(checkedAt.getTime())
      ? reportValue(data.checkedAt)
      : escapeHtml(checkedAt.toLocaleString());

    const summaryRows = reportRows([
      ['Overall score', `<strong>${score} / 100</strong>`],
      ['Verdict', reportValue(verdict.title)],
      ['Checks passed', String(data.counts.pass)],
      ['Checks to improve', String(data.counts.warn)],
      ['Checks to fix', String(data.counts.fail)],
    ]);

    const categoryRows = GROUP_ORDER.map((group) => {
      const groupScore = Number(data.scores[group]) || 0;
      return `<tr><td>${escapeHtml(GROUP_LABELS[group])}</td><td>${groupScore} / 100</td><td>${escapeHtml(
        categoryCopy(groupScore)
      )}</td></tr>`;
    }).join('');

    const metricRows = reportRows([
      ['Requested URL', reportValue(data.target)],
      ['Final URL', reportValue(data.finalUrl)],
      ['Checked at', checkedLabel],
      ['HTTP status', `HTTP ${reportValue(data.metrics.status)}`],
      ['Server response (TTFB)', `${Number(data.metrics.ttfbMs) || 0} ms`],
      ['Page download time', `${Number(data.metrics.totalMs) || 0} ms`],
      ['HTML size', escapeHtml(formatBytes(data.metrics.htmlBytes))],
      ['HTML read limit reached', data.metrics.htmlTruncated ? 'Yes' : 'No'],
      ['Content type', reportValue(data.metrics.contentType)],
      ['Served over HTTPS', data.metrics.pageIsHttps ? 'Yes' : 'No'],
      ['Redirected', data.metrics.redirected ? 'Yes' : 'No'],
      ['Server', reportValue(data.metrics.server)],
      ['Content encoding', reportValue(data.metrics.contentEncoding)],
      ['Compression', data.metrics.compressed ? 'Enabled' : 'Not detected'],
      ['Cache-Control', reportValue(data.metrics.cacheControl)],
    ]);

    const pageRows = reportRows([
      ['Title', reportValue(data.page.title)],
      ['Meta description', reportValue(data.page.description)],
      ['Page language', reportValue(data.page.lang)],
      ['Canonical URL', reportValue(data.page.canonical)],
      ['Meta robots', reportValue(data.page.robots)],
      ['Viewport', reportValue(data.page.viewport)],
      ['Theme color', reportValue(data.page.themeColor)],
      ['H1 headings', reportValue(data.page.h1Count)],
      ['H2 headings', reportValue(data.page.h2Count)],
      ['Images', reportValue(data.page.imageCount)],
      ['Images missing alt text', reportValue(data.page.imagesMissingAlt)],
      ['Word count', reportValue(data.page.wordCount)],
      ['Links', reportValue(data.page.linkCount)],
      [
        'Open Graph tags',
        data.page.openGraph && data.page.openGraph.length
          ? escapeHtml(data.page.openGraph.join(', '))
          : '&mdash;',
      ],
      ['Structured data (JSON-LD)', data.page.hasJsonLd ? 'Yes' : 'No'],
    ]);

    const checkSections = GROUP_ORDER.map((group) => {
      const checks = data.checks.filter((check) => check.group === group);
      if (!checks.length) return '';

      const rows = checks
        .map(
          (check) => `<tr>
            <td>${reportValue(check.label)}</td>
            <td class="status status-${escapeHtml(check.status)}">${escapeHtml(
              STATUS_LABELS[check.status] || check.status
            )}</td>
            <td>${reportValue(check.detail)}</td>
            <td>${check.status !== 'pass' && check.fix ? reportValue(check.fix) : '&mdash;'}</td>
          </tr>`
        )
        .join('');

      return `<h2>${escapeHtml(GROUP_LABELS[group])} &mdash; ${Number(data.scores[group]) || 0}/100</h2>
        <table>
          <thead>
            <tr><th>Check</th><th>Result</th><th>What we found</th><th>Recommended fix</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    }).join('');

    return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>Website audit - ${reportValue(data.finalUrl)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
  @page { size: A4; margin: 2cm; }
  body { font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-size: 11pt; color: #1b2430; line-height: 1.5; }
  h1 { margin: 0 0 4pt; font-size: 24pt; color: #0d1a33; }
  h2 { margin: 20pt 0 6pt; font-size: 15pt; color: #16294f; page-break-after: avoid; }
  p { margin: 0 0 8pt; }
  .brand { margin: 0 0 2pt; font-size: 10pt; letter-spacing: 1.5pt; text-transform: uppercase; color: #4a68a6; }
  .meta { margin: 0 0 14pt; color: #5b6577; font-size: 10pt; }
  .masthead { width: 100%; border-collapse: collapse; margin: 0 0 20pt; background: #0a142e; }
  .masthead td { border: none; padding: 16pt 18pt; vertical-align: middle; background: #0a142e; }
  .masthead-logo { width: 150pt; }
  .masthead-logo img { display: block; }
  .masthead-text { text-align: right; color: #aebfe4; font-size: 8pt; letter-spacing: 1.4pt; text-transform: uppercase; }
  .score { margin: 10pt 0 14pt; font-size: 13pt; }
  .score strong { font-size: 20pt; color: #16294f; }
  table { width: 100%; border-collapse: collapse; margin: 6pt 0 14pt; }
  th, td { border: 1px solid #c9d2e0; padding: 6pt 8pt; text-align: left; vertical-align: top; font-size: 10pt; }
  thead th { background: #eef2f9; color: #16294f; }
  tbody th { width: 32%; background: #f7f9fc; font-weight: 600; }
  .status { font-weight: 700; white-space: nowrap; }
  .status-pass { color: #1a7f4b; }
  .status-warn { color: #9a6a00; }
  .status-fail { color: #b42318; }
  tr { page-break-inside: avoid; }
  .footer { margin-top: 18pt; padding-top: 8pt; border-top: 1px solid #c9d2e0; color: #5b6577; font-size: 9pt; }
</style>
</head>
<body>
  <table class="masthead"><tr>
    <td class="masthead-logo">${
      logo ? `<img src="${logo}" alt="Midnight Webs" width="150">` : ''
    }</td>
    <td class="masthead-text">Website audit report</td>
  </tr></table>
  <h1>Website audit report</h1>
  <p class="meta">${escapeHtml(data.finalUrl)}<br>Generated ${checkedLabel}</p>

  <div class="score"><strong>${score}/100</strong> &mdash; ${escapeHtml(verdict.title)}</div>
  <p>${escapeHtml(verdict.copy)}</p>

  <h2>Summary</h2>
  <table><tbody>${summaryRows}</tbody></table>

  <h2>Category scores</h2>
  <table>
    <thead><tr><th>Category</th><th>Score</th><th>Assessment</th></tr></thead>
    <tbody>${categoryRows}</tbody>
  </table>

  <h2>Audit details</h2>
  <table><tbody>${metricRows}</tbody></table>

  <h2>Page information</h2>
  <table><tbody>${pageRows}</tbody></table>

  ${checkSections}

  <p class="footer">Generated by Midnight Webs &mdash; midnightwebs.com/web-audit &mdash; ${checkedLabel}</p>
</body>
</html>`;
  }

  async function downloadReport() {
    if (!lastAudit) return;

    const logo = await getLogoDataUrl().catch(() => '');
    const html = buildReportDocument(lastAudit, logo);
    const blob = new Blob(['\ufeff', html], { type: 'application/msword;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = reportFileName(lastAudit);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function renderFacts(data) {
    clear(factsEl);

    const facts = [
      { label: 'Final URL', value: data.finalUrl, link: true },
      { label: 'HTTP status', value: `HTTP ${data.metrics.status}` },
      { label: 'Response time', value: `${data.metrics.ttfbMs} ms` },
      { label: 'HTML size', value: formatBytes(data.metrics.htmlBytes) },
    ];

    for (const fact of facts) {
      const card = el('div', 'audit-fact');
      card.appendChild(el('span', 'audit-fact-label', fact.label));
      if (fact.link) {
        const link = el('a', 'audit-fact-value is-link', fact.value);
        link.href = fact.value;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        card.appendChild(link);
      } else {
        card.appendChild(el('span', 'audit-fact-value', fact.value));
      }
      factsEl.appendChild(card);
    }
  }

  function renderCategories(scores) {
    clear(categoriesEl);

    for (const group of GROUP_ORDER) {
      const score = Number(scores[group]) || 0;
      const card = el('div', 'audit-category');
      const head = el('div', 'audit-category-head');
      head.appendChild(el('span', 'audit-category-name', GROUP_LABELS[group]));
      head.appendChild(el('span', 'audit-category-score', String(score)));
      card.appendChild(head);

      const bar = el('div', 'audit-bar');
      const fill = el('span');
      fill.style.setProperty('--value', String(score));
      fill.style.setProperty('--bar-color', scoreColor(score));
      bar.appendChild(fill);
      card.appendChild(bar);
      card.appendChild(el('p', 'audit-category-copy', categoryCopy(score)));
      categoriesEl.appendChild(card);
    }
  }

  function renderDetails(data) {
    clear(detailsEl);

    for (const group of GROUP_ORDER) {
      const checks = data.checks.filter((check) => check.group === group);
      if (!checks.length) continue;

      const section = el('section', 'audit-group');
      const head = el('div', 'audit-group-head');
      head.appendChild(el('h3', null, GROUP_LABELS[group]));

      const scoreLabel = el('span', 'audit-group-score');
      scoreLabel.appendChild(document.createTextNode('Score '));
      const strong = el('strong', null, `${data.scores[group]}/100`);
      scoreLabel.appendChild(strong);
      head.appendChild(scoreLabel);
      section.appendChild(head);

      const list = el('ul', 'audit-check-list');
      for (const check of checks) {
        const item = el('li', `audit-check is-${check.status}`);
        const itemHead = el('div', 'audit-check-head');
        itemHead.appendChild(el('h4', null, check.label));
        itemHead.appendChild(el('span', 'audit-status', STATUS_LABELS[check.status] || check.status));
        item.appendChild(itemHead);
        item.appendChild(el('p', 'audit-check-detail', check.detail));

        if (check.status !== 'pass' && check.fix) {
          item.appendChild(el('p', 'audit-check-fix', check.fix));
        }

        list.appendChild(item);
      }

      section.appendChild(list);
      detailsEl.appendChild(section);
    }
  }

  function render(data) {
    lastAudit = data;
    const score = Number(data.scores.overall) || 0;
    const verdict = verdictFor(score, data.counts);

    scoreEl.style.setProperty('--score', String(score));
    scoreEl.style.setProperty('--score-color', scoreColor(score));
    scoreValue.textContent = String(score);
    verdictEl.textContent = verdict.title;
    verdictCopy.textContent = verdict.copy;

    resultsUrl.textContent = data.finalUrl;
    renderFacts(data);
    renderCategories(data.scores);
    renderDetails(data);

    resultsEl.hidden = false;
    resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    resultsTitle.focus({ preventScroll: true });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    let target;
    try {
      target = normalizeUrl(input.value);
    } catch (error) {
      setError(error.message);
      input.focus();
      return;
    }

    setError('');
    resultsEl.hidden = true;

    requestController = new AbortController();
    const timeout = window.setTimeout(() => requestController.abort(), 20000);

    submit.disabled = true;
    input.disabled = true;
    startLoading();

    try {
      const response = await fetch('/api/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target }),
        signal: requestController.signal,
      });

      let payload = null;
      const contentType = response.headers?.get?.('content-type') || '';
      if (!contentType || contentType.includes('application/json')) {
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
      }

      if (response.status === 429) {
        throw new Error('Too many audits in a minute. Please wait a moment and try again.');
      }
      if (!payload) {
        if (response.status === 404) {
          throw new Error('The audit API is not running on this server. Use Wrangler or the deployed Cloudflare site, then try again.');
        }
        throw new Error(`The audit API returned HTTP ${response.status} instead of JSON. Please try again.`);
      }
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'The audit could not be completed. Please try another URL.');
      }

      render(payload);
    } catch (error) {
      if (error?.name === 'AbortError') {
        setError('The audit timed out. Try a faster page or a different URL.');
      } else {
        setError(error?.message || 'Something went wrong. Please try again.');
      }
    } finally {
      window.clearTimeout(timeout);
      requestController = null;
      stopLoading();
      submit.disabled = false;
      input.disabled = false;
    }
  });

  downloadBtn.addEventListener('click', downloadReport);

  againBtn.addEventListener('click', () => {
    resultsEl.hidden = true;
    lastAudit = null;
    setError('');
    document.querySelector('.audit-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    input.focus({ preventScroll: true });
    input.select();
  });
})();
