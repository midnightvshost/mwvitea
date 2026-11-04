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
  const recommendationsEl = document.querySelector('#auditRecommendations');
  const recommendationsList = document.querySelector('#auditRecommendationsList');
  const recommendationsCount = document.querySelector('#auditRecommendationsCount');
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
    'Collecting real code and image examples…',
  ];

  let loadingTimer = null;
  let requestController = null;
  let lastAudit = null;
  let logoJpeg = null;

  async function getLogoJpeg() {
    if (logoJpeg) return logoJpeg;

    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load logo.'));
      img.src = LOGO_URL;
    });

    const maxWidth = 360;
    const scale = Math.min(1, maxWidth / image.naturalWidth);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const base64 = dataUrl.split(',')[1] || '';
    if (!base64) throw new Error('Could not prepare logo.');

    logoJpeg = { bytes: atob(base64), width, height };
    return logoJpeg;
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

  function evidenceText(item) {
    if (!item) return '';
    const parts = [];
    if (item.text) parts.push(String(item.text));
    if (item.type === 'image' && item.src) parts.push(`Image URL: ${item.src}`);
    if (!parts.length) return '';
    return item.label ? `${item.label}: ${parts.join(' - ')}` : parts.join(' - ');
  }

  function checkEvidenceLines(check) {
    if (!check.evidence || !check.evidence.length) return [];
    return check.evidence.map(evidenceText).filter(Boolean);
  }

  function reportFileName(data) {
    let host = 'website';
    try {
      host = new URL(data.finalUrl || data.target).hostname || host;
    } catch {}
    const safeHost = host.replace(/[^a-z0-9.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'website';
    const stamp = new Date().toISOString().slice(0, 10);
    return `midnight-webs-audit-${safeHost}-${stamp}.pdf`;
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

  const PDF_WIDTH = 595.28;
  const PDF_HEIGHT = 841.89;
  const PDF_MARGIN = 48;
  const PDF_HEADER = 58;
  const PDF_FOOTER = 30;

  let measureContext = null;

  function pdfRgb(hex) {
    const value = String(hex || '#000000').replace('#', '');
    const r = parseInt(value.slice(0, 2), 16) / 255;
    const g = parseInt(value.slice(2, 4), 16) / 255;
    const b = parseInt(value.slice(4, 6), 16) / 255;
    return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`;
  }

  function pdfTextWidth(text, size, bold) {
    if (!measureContext) {
      measureContext = document.createElement('canvas').getContext('2d');
    }
    if (!measureContext) {
      return String(text || '').length * size * (bold ? 0.56 : 0.5);
    }
    measureContext.font = `${bold ? '700' : '400'} ${size}px Helvetica, Arial, sans-serif`;
    return measureContext.measureText(String(text || '')).width;
  }

  function pdfEncode(text) {
    const value = String(text == null ? '' : text)
      .replace(/\r\n?/g, '\n')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\u2026/g, '...')
      .replace(/[\u2022\u00b7]/g, '-')
      .replace(/\u00a0/g, ' ');

    let out = '';
    for (const char of value) {
      const code = char.codePointAt(0);
      if (code < 32) {
        out += ' ';
      } else if (code <= 126) {
        out += char === '\\' || char === '(' || char === ')' ? `\\${char}` : char;
      } else if (code <= 255) {
        out += `\\${code.toString(8).padStart(3, '0')}`;
      } else {
        out += '?';
      }
    }
    return out;
  }

  function pdfWrap(text, maxWidth, size, bold) {
    const lines = [];
    const blocks = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');

    for (const block of blocks) {
      const words = block.split(/\s+/).filter(Boolean);
      if (!words.length) {
        lines.push('');
        continue;
      }

      let line = '';
      for (let word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (pdfTextWidth(candidate, size, bold) <= maxWidth) {
          line = candidate;
          continue;
        }

        if (line) {
          lines.push(line);
          line = '';
        }

        while (word.length > 1 && pdfTextWidth(word, size, bold) > maxWidth) {
          let cut = word.length - 1;
          while (cut > 1 && pdfTextWidth(word.slice(0, cut), size, bold) > maxWidth) {
            cut -= 1;
          }
          lines.push(word.slice(0, cut));
          word = word.slice(cut);
        }
        line = word;
      }

      if (line) lines.push(line);
    }

    return lines.length ? lines : [''];
  }

  function pdfPushText(commands, text, x, y, size, bold, color, align) {
    const width = pdfTextWidth(text, size, bold);
    let drawX = x;
    if (align === 'right') drawX = x - width;
    if (align === 'center') drawX = x - width / 2;
    commands.push(
      `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${pdfRgb(color)} rg 1 0 0 1 ${drawX.toFixed(2)} ${y.toFixed(
        2
      )} Tm (${pdfEncode(text)}) Tj ET`
    );
  }

  function pdfRect(commands, x, y, width, height, fill, stroke) {
    if (fill) {
      commands.push(
        `${pdfRgb(fill)} rg ${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f`
      );
    }
    if (stroke) {
      commands.push(
        `${pdfRgb(stroke)} RG 0.5 w ${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(
          2
        )} ${height.toFixed(2)} re S`
      );
    }
  }

  function assemblePdf(pages, logo) {
    const objects = [];
    const catalogNum = 1;
    const pagesNum = 2;
    const regularFontNum = 3;
    const boldFontNum = 4;
    let nextNum = 5;
    let imageNum = 0;

    if (logo) imageNum = nextNum++;

    const pageNums = [];
    const contentNums = [];
    for (let i = 0; i < pages.length; i += 1) {
      pageNums.push(nextNum++);
      contentNums.push(nextNum++);
    }

    objects[catalogNum] = `${catalogNum} 0 obj\n<< /Type /Catalog /Pages ${pagesNum} 0 R >>\nendobj\n`;
    objects[pagesNum] = `${pagesNum} 0 obj\n<< /Type /Pages /Kids [${pageNums
      .map((num) => `${num} 0 R`)
      .join(' ')}] /Count ${pages.length} >>\nendobj\n`;
    objects[regularFontNum] =
      `${regularFontNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`;
    objects[boldFontNum] =
      `${boldFontNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n`;

    if (logo) {
      objects[imageNum] =
        `${imageNum} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.bytes.length} >>\nstream\n` +
        logo.bytes +
        `\nendstream\nendobj\n`;
    }

    const resources = `/Font << /F1 ${regularFontNum} 0 R /F2 ${boldFontNum} 0 R >>${
      logo ? ` /XObject << /Im1 ${imageNum} 0 R >>` : ''
    }`;

    pages.forEach((target, index) => {
      const content = `${target.commands.join('\n')}\n`;
      objects[contentNums[index]] = `${contentNums[index]} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`;
      objects[pageNums[index]] =
        `${pageNums[index]} 0 obj\n<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${PDF_WIDTH} ${PDF_HEIGHT}] /Resources << ${resources} >> /Contents ${contentNums[index]} 0 R >>\nendobj\n`;
    });

    const header = `%PDF-1.4\n%\xE2\xE3\xCF\xD3\n`;
    let body = header;
    const offsets = [0];

    for (let i = 1; i < objects.length; i += 1) {
      offsets[i] = body.length;
      body += objects[i] || '';
    }

    const xrefOffset = body.length;
    let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objects.length; i += 1) {
      xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }

    body += `${xref}trailer\n<< /Size ${objects.length} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    const bytes = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i += 1) {
      bytes[i] = body.charCodeAt(i) & 0xff;
    }
    return bytes;
  }

  function buildAuditPdf(data, logo) {
    const contentWidth = PDF_WIDTH - PDF_MARGIN * 2;
    const contentTop = PDF_HEIGHT - PDF_HEADER - 24;
    const contentBottom = PDF_FOOTER + 16;
    const pages = [];
    let page = null;

    const score = Number(data.scores?.overall) || 0;
    const counts = data.counts || { pass: 0, warn: 0, fail: 0 };
    const verdict = verdictFor(score, counts);
    const checkedAt = data.checkedAt ? new Date(data.checkedAt) : new Date();
    const checkedLabel = Number.isNaN(checkedAt.getTime())
      ? String(data.checkedAt || '')
      : checkedAt.toLocaleString();

    function drawHeader(target) {
      const commands = target.commands;
      pdfRect(commands, 0, PDF_HEIGHT - PDF_HEADER, PDF_WIDTH, PDF_HEADER, '#0a142e', null);

      if (logo) {
        const logoWidth = 86;
        const logoHeight = logoWidth * (logo.height / logo.width);
        const logoY = PDF_HEIGHT - PDF_HEADER + (PDF_HEADER - logoHeight) / 2;
        commands.push(
          `q ${logoWidth.toFixed(2)} 0 0 ${logoHeight.toFixed(2)} ${PDF_MARGIN.toFixed(
            2
          )} ${logoY.toFixed(2)} cm /Im1 Do Q`
        );
      } else {
        pdfPushText(commands, 'MIDNIGHT WEBS', PDF_MARGIN, PDF_HEIGHT - PDF_HEADER + 23, 10, true, '#ffffff');
      }

      pdfPushText(
        commands,
        'WEBSITE AUDIT REPORT',
        PDF_WIDTH - PDF_MARGIN,
        PDF_HEIGHT - PDF_HEADER + 24,
        7.5,
        false,
        '#8fb4ff',
        'right'
      );
    }

    function newPage() {
      const firstPage = pages.length === 0;
      page = { commands: [], y: contentTop };
      pages.push(page);
      if (firstPage) drawHeader(page);
    }

    function ensureSpace(height) {
      if (page.y - height < contentBottom) {
        newPage();
        return true;
      }
      return false;
    }

    function paragraph(text, options = {}) {
      const size = options.size || 9.5;
      const bold = Boolean(options.bold);
      const color = options.color || '#1b2430';
      const lineHeight = options.lineHeight || Math.round(size * 1.45 * 10) / 10;
      const gapAfter = options.gapAfter == null ? 6 : options.gapAfter;
      const x = options.x == null ? PDF_MARGIN : options.x;
      const maxWidth = options.maxWidth == null ? contentWidth : options.maxWidth;
      const lines = pdfWrap(text, maxWidth, size, bold);

      ensureSpace(lines.length * lineHeight + gapAfter);
      for (const line of lines) {
        pdfPushText(page.commands, line, x, page.y - size, size, bold, color);
        page.y -= lineHeight;
      }
      page.y -= gapAfter;
    }

    function heading(text, options = {}) {
      const size = options.size || 13;
      const gapBefore = options.gapBefore == null ? 14 : options.gapBefore;
      const gapAfter = options.gapAfter == null ? 6 : options.gapAfter;

      ensureSpace(gapBefore + size + gapAfter);
      page.y -= gapBefore;
      pdfPushText(page.commands, text, PDF_MARGIN, page.y - size, size, true, options.color || '#16294f');
      page.y -= size + gapAfter;
    }

    function drawTableHeader(headers, widths, size, lineHeight, padding) {
      const headerLines = headers.map((header, index) =>
        pdfWrap(header, widths[index] * contentWidth - padding * 2, size, true)
      );
      const headerHeight = Math.max(...headerLines.map((lines) => lines.length)) * lineHeight + padding * 2;

      ensureSpace(headerHeight);
      const top = page.y;
      let x = PDF_MARGIN;

      for (let i = 0; i < headers.length; i += 1) {
        const width = widths[i] * contentWidth;
        pdfRect(page.commands, x, top - headerHeight, width, headerHeight, '#eef2f9', '#c9d2e0');
        headerLines[i].forEach((line, lineIndex) => {
          pdfPushText(
            page.commands,
            line,
            x + padding,
            top - padding - size - lineIndex * lineHeight,
            size,
            true,
            '#16294f'
          );
        });
        x += width;
      }

      page.y = top - headerHeight;
    }

    function table(headers, rows, widths) {
      const size = 8.2;
      const lineHeight = 10;
      const padding = 4.5;

      drawTableHeader(headers, widths, size, lineHeight, padding);

      for (const row of rows) {
        const cells = row.map((cell) => (typeof cell === 'string' ? { text: cell } : cell));
        const wrapped = cells.map((cell, index) =>
          pdfWrap(cell.text, widths[index] * contentWidth - padding * 2, size, Boolean(cell.bold))
        );
        const rowHeight = Math.max(...wrapped.map((lines) => lines.length)) * lineHeight + padding * 2;

        if (ensureSpace(rowHeight)) {
          drawTableHeader(headers, widths, size, lineHeight, padding);
        }

        const top = page.y;
        let x = PDF_MARGIN;

        for (let i = 0; i < cells.length; i += 1) {
          const width = widths[i] * contentWidth;
          const cell = cells[i];
          pdfRect(page.commands, x, top - rowHeight, width, rowHeight, '#ffffff', '#c9d2e0');
          wrapped[i].forEach((line, lineIndex) => {
            pdfPushText(
              page.commands,
              line,
              x + padding,
              top - padding - size - lineIndex * lineHeight,
              size,
              Boolean(cell.bold),
              cell.color || '#1b2430'
            );
          });
          x += width;
        }

        page.y = top - rowHeight;
      }

      page.y -= 10;
    }

    function keyValueTable(rows) {
      const size = 8.6;
      const lineHeight = 10.5;
      const padding = 5;
      const labelWidth = contentWidth * 0.32;
      const valueWidth = contentWidth - labelWidth;

      for (const [label, value] of rows) {
        const labelLines = pdfWrap(label, labelWidth - padding * 2, size, true);
        const valueLines = pdfWrap(value, valueWidth - padding * 2, size, false);
        const rowHeight = Math.max(labelLines.length, valueLines.length) * lineHeight + padding * 2;

        ensureSpace(rowHeight);
        const top = page.y;
        pdfRect(page.commands, PDF_MARGIN, top - rowHeight, labelWidth, rowHeight, '#f7f9fc', '#c9d2e0');
        pdfRect(
          page.commands,
          PDF_MARGIN + labelWidth,
          top - rowHeight,
          valueWidth,
          rowHeight,
          '#ffffff',
          '#c9d2e0'
        );

        labelLines.forEach((line, index) => {
          pdfPushText(
            page.commands,
            line,
            PDF_MARGIN + padding,
            top - padding - size - index * lineHeight,
            size,
            true,
            '#16294f'
          );
        });
        valueLines.forEach((line, index) => {
          pdfPushText(
            page.commands,
            line,
            PDF_MARGIN + labelWidth + padding,
            top - padding - size - index * lineHeight,
            size,
            false,
            '#1b2430'
          );
        });

        page.y = top - rowHeight;
      }

      page.y -= 10;
    }

    function statusColor(status) {
      if (status === 'pass') return '#1a7f4b';
      if (status === 'warn') return '#9a6a00';
      if (status === 'fail') return '#b42318';
      return '#1b2430';
    }

    newPage();

    pdfPushText(page.commands, 'Website audit report', PDF_MARGIN, page.y - 24, 24, true, '#0d1a33');
    page.y -= 32;
    paragraph(data.finalUrl || data.target || '', { size: 9, color: '#5b6577', lineHeight: 12, gapAfter: 2 });
    paragraph(`Generated ${checkedLabel}`, { size: 9, color: '#5b6577', lineHeight: 12, gapAfter: 18 });

    const cardHeight = 66;
    ensureSpace(cardHeight + 16);
    const cardTop = page.y;
    pdfRect(page.commands, PDF_MARGIN, cardTop - cardHeight, contentWidth, cardHeight, '#f7f9fc', '#c9d2e0');
    pdfPushText(page.commands, `${score}/100`, PDF_MARGIN + 16, cardTop - 38, 24, true, '#16294f');
    pdfPushText(page.commands, verdict.title, PDF_MARGIN + 130, cardTop - 24, 13, true, '#0d1a33');
    pdfPushText(page.commands, verdict.copy, PDF_MARGIN + 130, cardTop - 43, 8.5, false, '#5b6577');
    page.y = cardTop - cardHeight - 16;

    heading('Statistics', { gapBefore: 0 });
    keyValueTable([
      ['Overall score', `${score} / 100`],
      ['Verdict', verdict.title],
      ['Checks passed', String(counts.pass)],
      ['Checks to improve', String(counts.warn)],
      ['Checks to fix', String(counts.fail)],
    ]);

    heading('Category scores');
    table(
      ['Category', 'Score', 'Assessment'],
      GROUP_ORDER.map((group) => {
        const groupScore = Number(data.scores?.[group]) || 0;
        return [GROUP_LABELS[group], `${groupScore} / 100`, categoryCopy(groupScore)];
      }),
      [0.28, 0.16, 0.56]
    );

    heading('Audit details');
    keyValueTable([
      ['Requested URL', data.target || '-'],
      ['Final URL', data.finalUrl || '-'],
      ['Checked at', checkedLabel],
      ['HTTP status', `HTTP ${data.metrics.status}`],
      ['Server response (TTFB)', `${Number(data.metrics.ttfbMs) || 0} ms`],
      ['Page download time', `${Number(data.metrics.totalMs) || 0} ms`],
      ['HTML size', formatBytes(data.metrics.htmlBytes)],
      ['HTML read limit reached', data.metrics.htmlTruncated ? 'Yes' : 'No'],
      ['Content type', data.metrics.contentType || '-'],
      ['Served over HTTPS', data.metrics.pageIsHttps ? 'Yes' : 'No'],
      ['Redirected', data.metrics.redirected ? 'Yes' : 'No'],
      ['Server', data.metrics.server || '-'],
      ['Content encoding', data.metrics.contentEncoding || '-'],
      ['Compression', data.metrics.compressed ? 'Enabled' : 'Not detected'],
      ['Cache-Control', data.metrics.cacheControl || '-'],
    ]);

    heading('Page information');
    keyValueTable([
      ['Title', data.page.title || '-'],
      ['Meta description', data.page.description || '-'],
      ['Page language', data.page.lang || '-'],
      ['Canonical URL', data.page.canonical || '-'],
      ['Meta robots', data.page.robots || '-'],
      ['Viewport', data.page.viewport || '-'],
      ['Theme color', data.page.themeColor || '-'],
      ['H1 headings', data.page.h1Count == null ? '-' : String(data.page.h1Count)],
      ['H2 headings', data.page.h2Count == null ? '-' : String(data.page.h2Count)],
      ['Images', data.page.imageCount == null ? '-' : String(data.page.imageCount)],
      ['Images missing alt text', data.page.imagesMissingAlt == null ? '-' : String(data.page.imagesMissingAlt)],
      ['Word count', data.page.wordCount == null ? '-' : String(data.page.wordCount)],
      ['Links', data.page.linkCount == null ? '-' : String(data.page.linkCount)],
      [
        'Open Graph tags',
        data.page.openGraph && data.page.openGraph.length ? data.page.openGraph.join(', ') : '-',
      ],
      ['Structured data (JSON-LD)', data.page.hasJsonLd ? 'Yes' : 'No'],
    ]);

    for (const group of GROUP_ORDER) {
      const checks = (data.checks || []).filter((check) => check.group === group);
      if (!checks.length) continue;

      heading(`${GROUP_LABELS[group]} - ${Number(data.scores?.[group]) || 0}/100`, { size: 13 });
      table(
        ['Check', 'Result', 'What we found and examples'],
        checks.map((check) => {
          const found = [check.detail || '-'];
          if (check.status !== 'pass') found.push(...checkEvidenceLines(check));
          return [
            { text: check.label || '-', bold: true },
            {
              text: STATUS_LABELS[check.status] || check.status || '-',
              bold: true,
              color: statusColor(check.status),
            },
            { text: found.join('\n') },
          ];
        }),
        [0.22, 0.1, 0.68]
      );
    }

    const fixes = (data.checks || [])
      .filter((check) => check.status !== 'pass' && check.fix)
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'fail' ? -1 : 1;
        return (b.weight || 0) - (a.weight || 0);
      });

    if (fixes.length) {
      heading('Recommended fixes');
      table(
        ['Priority', 'Check', 'What to do'],
        fixes.map((check) => {
          const example = checkEvidenceLines(check)[0];
          return [
            {
              text: check.status === 'fail' ? 'Fix first' : 'Improve',
              bold: true,
              color: statusColor(check.status),
            },
            { text: check.label || '-', bold: true },
            {
              text: [check.fix, example ? `Example: ${example}` : '']
                .filter(Boolean)
                .join('\n'),
            },
          ];
        }),
        [0.14, 0.26, 0.6]
      );
    }

    pages.forEach((target, index) => {
      const commands = target.commands;
      commands.push(
        `${pdfRgb('#c9d2e0')} RG 0.5 w ${PDF_MARGIN.toFixed(2)} ${PDF_FOOTER.toFixed(2)} m ${(
          PDF_WIDTH - PDF_MARGIN
        ).toFixed(2)} ${PDF_FOOTER.toFixed(2)} l S`
      );
      pdfPushText(
        commands,
        'Generated by Midnight Webs - midnightwebs.com/web-audit',
        PDF_MARGIN,
        PDF_FOOTER - 12,
        7.5,
        false,
        '#5b6577'
      );
      if (index > 0) {
        pdfPushText(
          commands,
          'Midnight Webs Network',
          PDF_WIDTH / 2,
          PDF_FOOTER - 12,
          7.5,
          false,
          '#5b6577',
          'center'
        );
      }
      pdfPushText(
        commands,
        `Page ${index + 1} of ${pages.length}`,
        PDF_WIDTH - PDF_MARGIN,
        PDF_FOOTER - 12,
        7.5,
        false,
        '#5b6577',
        'right'
      );
    });

    return assemblePdf(pages, logo);
  }

  function isAppleMobile() {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  }

  function triggerDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    if (isAppleMobile()) {
      link.target = '_blank';
      link.rel = 'noopener';
    }
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function savePdf(bytes, fileName) {
    const blob = new Blob([bytes], { type: 'application/pdf' });

    if (
      isAppleMobile() &&
      typeof File === 'function' &&
      typeof navigator.share === 'function' &&
      typeof navigator.canShare === 'function'
    ) {
      try {
        const file = new File([blob], fileName, { type: 'application/pdf' });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: 'Website audit report' }).catch((error) => {
            if (error && error.name === 'AbortError') return;
            triggerDownload(blob, fileName);
          });
          return;
        }
      } catch {}
    }

    triggerDownload(blob, fileName);
  }

  async function downloadReport() {
    if (!lastAudit) return;

    const originalText = downloadBtn.textContent;
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Preparing PDF...';

    try {
      const logo = logoJpeg || (await getLogoJpeg().catch(() => null));
      const bytes = buildAuditPdf(lastAudit, logo);
      savePdf(bytes, reportFileName(lastAudit));
    } catch (error) {
      console.error(error);
      setError('The PDF report could not be created. Please try again.');
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = originalText;
    }
  }

  function renderFacts(data) {
    clear(factsEl);

    const counts = data.counts || { pass: 0, warn: 0, fail: 0 };
    const issues = (Number(counts.warn) || 0) + (Number(counts.fail) || 0);
    const facts = [
      { label: 'Final URL', value: data.finalUrl, link: true },
      { label: 'HTTP status', value: `HTTP ${data.metrics.status}` },
      { label: 'Response time', value: `${data.metrics.ttfbMs} ms` },
      { label: 'HTML size', value: formatBytes(data.metrics.htmlBytes) },
      { label: 'Checks passed', value: String(counts.pass || 0), tone: 'pass' },
      {
        label: 'Issues found',
        value: String(issues),
        tone: issues ? 'warn' : 'pass',
      },
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
        const value = el('span', 'audit-fact-value', fact.value);
        if (fact.tone) value.classList.add(`is-${fact.tone}`);
        card.appendChild(value);
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

  function renderEvidence(check) {
    if (check.status === 'pass' || !check.evidence || !check.evidence.length) return null;

    const wrap = el('div', 'audit-evidence');
    wrap.appendChild(el('p', 'audit-evidence-label', 'What we found in your code'));

    const list = el('ul', 'audit-evidence-list');
    for (const item of check.evidence) {
      const entry = el('li', 'audit-evidence-item');
      if (item.label) entry.appendChild(el('span', 'audit-evidence-item-label', item.label));

      if (item.type === 'image') {
        if (item.src) {
          const frame = el('div', 'audit-evidence-image');
          const image = document.createElement('img');
          image.src = item.src;
          image.alt = item.alt || 'Image from the audited page';
          image.loading = 'lazy';
          image.decoding = 'async';
          image.referrerPolicy = 'no-referrer';
          image.addEventListener('error', () => {
            frame.hidden = true;
          });
          frame.appendChild(image);
          entry.appendChild(frame);
        } else {
          entry.appendChild(
            el('span', 'audit-evidence-note', 'The image source could not be resolved.')
          );
        }
      }

      if (item.text) {
        entry.appendChild(el('code', 'audit-evidence-code', item.text));
      }

      list.appendChild(entry);
    }

    wrap.appendChild(list);
    return wrap;
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

        const evidence = renderEvidence(check);
        if (evidence) item.appendChild(evidence);

        list.appendChild(item);
      }

      section.appendChild(list);
      detailsEl.appendChild(section);
    }
  }

  function renderRecommendations(data) {
    clear(recommendationsList);

    const fixes = (data.checks || [])
      .filter((check) => check.status !== 'pass' && check.fix)
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'fail' ? -1 : 1;
        return (b.weight || 0) - (a.weight || 0);
      });

    if (!fixes.length) {
      recommendationsEl.hidden = true;
      recommendationsCount.textContent = '';
      return;
    }

    const failCount = fixes.filter((check) => check.status === 'fail').length;
    recommendationsCount.textContent = `${failCount} to fix · ${fixes.length - failCount} to improve`;

    for (const check of fixes) {
      const item = el('li', `audit-recommendation is-${check.status}`);
      const head = el('div', 'audit-recommendation-head');
      head.appendChild(el('h4', null, check.label));
      head.appendChild(el('span', 'audit-status', STATUS_LABELS[check.status] || check.status));
      item.appendChild(head);
      item.appendChild(el('p', 'audit-recommendation-fix', check.fix));
      item.appendChild(el('p', 'audit-recommendation-detail', check.detail));
      recommendationsList.appendChild(item);
    }

    recommendationsEl.hidden = false;
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
    renderRecommendations(data);

    resultsEl.hidden = false;
    resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    resultsTitle.focus({ preventScroll: true });
    getLogoJpeg().catch(() => null);
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
