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
  const storageStatus = document.querySelector('#auditStorageStatus');
  const scoreEl = document.querySelector('#auditScore');
  const scoreValue = document.querySelector('#auditScoreValue');
  const verdictEl = document.querySelector('#auditVerdict');
  const verdictCopy = document.querySelector('#auditVerdictCopy');
  const factsEl = document.querySelector('#auditFacts');
  const categoriesEl = document.querySelector('#auditCategories');
  const detailsEl = document.querySelector('#auditDetails');
  const againBtn = document.querySelector('#auditAgain');

  const GROUP_LABELS = {
    performance: 'Performance',
    seo: 'SEO',
    security: 'Security',
    mobile: 'Mobile',
  };

  const GROUP_ORDER = ['performance', 'seo', 'security', 'mobile'];
  const STATUS_LABELS = { pass: 'Pass', warn: 'Improve', fail: 'Fix' };
  const LOADING_MESSAGES = [
    'Fetching the page…',
    'Measuring response time…',
    'Checking SEO tags…',
    'Reviewing security headers…',
  ];

  let loadingTimer = null;
  let requestController = null;

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
    const score = Number(data.scores.overall) || 0;
    const verdict = verdictFor(score, data.counts);

    scoreEl.style.setProperty('--score', String(score));
    scoreEl.style.setProperty('--score-color', scoreColor(score));
    scoreValue.textContent = String(score);
    verdictEl.textContent = verdict.title;
    verdictCopy.textContent = verdict.copy;

    resultsUrl.textContent = data.finalUrl;
    storageStatus.className = `audit-storage-status ${data.storageSaved ? 'saved' : 'failed'}`;
    storageStatus.textContent = data.storageSaved
      ? 'Saved to the audit database.'
      : 'Audit completed, but the database save failed. Check the Cloudflare Worker logs.';
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

  againBtn.addEventListener('click', () => {
    resultsEl.hidden = true;
    setError('');
    document.querySelector('.audit-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    input.focus({ preventScroll: true });
    input.select();
  });
})();
