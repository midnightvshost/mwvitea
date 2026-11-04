// Project inquiry endpoint for /api/inquiry.
//
// Flow: the estimate page posts the selected scope plus contact details.
// The Worker verifies Cloudflare Turnstile, applies simple spam checks, stores
// the inquiry in Supabase with the service role key, then emails the owner.
// The owner can reply directly because Reply-To is set to the visitor.

const MAX_REQUEST_BYTES = 16384;
const FETCH_TIMEOUT_MS = 8000;
const MIN_SUBMIT_MS = 1500;
const MAX_URLS = 3;
const BLOCK_SCORE = 6;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com',
  'dispostable.com',
  'getnada.com',
  'guerrillamail.com',
  'mailinator.com',
  'sharklasers.com',
  'tempmail.com',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
]);

// Kept intentionally short; extend with the terms you see in real spam.
const BAD_TERMS = [
  'asshole',
  'bastard',
  'bitch',
  'casino',
  'cialis',
  'crypto giveaway',
  'cunt',
  'dick',
  'escort',
  'fuck',
  'make money fast',
  'nude',
  'payday loan',
  'porn',
  'pussy',
  'shit',
  'slut',
  'viagra',
  'whore',
  'xxx',
];

const TERM_PATTERN = new RegExp(
  `\\b(?:${BAD_TERMS.map((term) =>
    term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  ).join('|')})\\b`,
  'gi'
);

class InquiryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'InquiryError';
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

function text(value, limit) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[013457@$!]/g, (char) => {
      const map = {
        0: 'o',
        1: 'i',
        3: 'e',
        4: 'a',
        5: 's',
        7: 't',
        '@': 'a',
        $: 's',
        '!': 'i',
      };
      return map[char] || char;
    })
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function spamSignals(name, email, company, message) {
  const combined = `${name} ${company} ${message}`;
  const normalized = normalizeForMatch(combined);
  const flags = [];
  let score = 0;

  const matches = normalized.match(TERM_PATTERN);
  if (matches) {
    flags.push('bad_language');
    score += matches.length * 3;
  }

  const urlCount = (combined.match(/https?:\/\//gi) || []).length;
  if (urlCount > MAX_URLS) {
    flags.push('too_many_links');
    score += urlCount;
  }

  const letters = combined.replace(/[^a-z]/gi, '');
  if (letters.length > 20) {
    const upper = combined.replace(/[^A-Z]/g, '').length;
    if (upper / letters.length > 0.7) {
      flags.push('all_caps');
      score += 1;
    }
  }

  const domain = (email.split('@')[1] || '').toLowerCase();
  if (DISPOSABLE_DOMAINS.has(domain)) {
    flags.push('disposable_email');
    score += 6;
  }

  return { score, flags };
}

function validateEmail(value) {
  const email = String(value || '').trim();
  if (
    email.length < 3 ||
    email.length > 254 ||
    /[\r\n]/.test(email) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
  ) {
    throw new InquiryError('Enter a valid email address.');
  }
  return email;
}

function validatePayload(payload) {
  const name = text(payload?.name, 80);
  if (name.length < 2) {
    throw new InquiryError('Please add your name.');
  }

  const email = validateEmail(payload?.email);
  if (!payload?.consent) {
    throw new InquiryError('Please accept the privacy policy to continue.');
  }

  const company = text(payload?.company, 120);
  const message = text(payload?.message, 1500);
  const scope = payload?.scope && typeof payload.scope === 'object' ? payload.scope : {};
  const features = Array.isArray(scope.features)
    ? scope.features.map((item) => text(item, 80)).filter(Boolean).slice(0, 25)
    : [];

  return {
    name,
    email,
    company,
    message,
    pages: text(scope.pages, 80),
    plan: text(scope.plan, 80),
    features,
    estimate: text(scope.estimate, 80),
    monthly: text(scope.monthly, 80),
    timeline: text(scope.timeline, 80),
    locale: ['en', 'ro', 'ru'].includes(payload?.locale) ? payload.locale : 'en',
  };
}

async function verifyTurnstile(request, env, token) {
  const secret = env?.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.warn('Turnstile secret is not configured; captcha verification is skipped.');
    return { ok: true, skipped: true };
  }
  if (!token) return { ok: false };

  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (ip) form.append('remoteip', ip);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false };
    const result = await response.json().catch(() => null);
    return { ok: Boolean(result && result.success), skipped: false };
  } catch (error) {
    console.error('Turnstile verification failed:', error?.message || error);
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

async function hashIp(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!ip) return null;

  const salt = env?.INQUIRY_HASH_SALT || 'midnight-webs';
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEmailBody(inquiry) {
  const rows = [
    ['Name', inquiry.name],
    ['Email', inquiry.email],
    ['Company', inquiry.company || '—'],
    ['Pages', inquiry.pages || '—'],
    ['Plan', inquiry.plan || '—'],
    ['Features', inquiry.features.length ? inquiry.features.join(', ') : '—'],
    ['Estimated build', inquiry.estimate || '—'],
    ['Monthly', inquiry.monthly || '—'],
    ['Delivery', inquiry.timeline || '—'],
    ['Notes', inquiry.message || '—'],
    ['Locale', inquiry.locale],
  ];

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>New project inquiry</title></head>
<body style="font-family:Arial,sans-serif;color:#1b2430;line-height:1.5">
  <h1 style="font-size:20px">New project inquiry</h1>
  <table style="border-collapse:collapse">
    <tbody>
      ${rows
        .map(
          ([label, value]) =>
            `<tr><th style="text-align:left;padding:6px 12px 6px 0;vertical-align:top;border-bottom:1px solid #e2e8f2">${escapeHtml(
              label
            )}</th><td style="padding:6px 0;border-bottom:1px solid #e2e8f2">${escapeHtml(
              value
            ).replace(/\n/g, '<br>')}</td></tr>`
        )
        .join('')}
    </tbody>
  </table>
  <p style="color:#5b6577;font-size:12px">Reply to this email to answer the sender directly.</p>
</body></html>`;

  const plain = rows.map(([label, value]) => `${label}: ${value}`).join('\n');

  return { html, plain };
}

async function sendNotification(env, inquiry) {
  const apiKey = env?.RESEND_API_KEY;
  const to = env?.MAIL_TO;
  if (!apiKey || !to) {
    console.warn('Inquiry email is not configured; notification skipped.');
    return false;
  }

  const from = env?.MAIL_FROM || 'Midnight Webs <onboarding@resend.dev>';
  const { html, plain } = buildEmailBody(inquiry);
  const subject = `New project request - ${text(inquiry.name, 60)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: inquiry.email,
        subject,
        html,
        text: plain,
      }),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      console.error('Inquiry email failed:', response.status, detail);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Inquiry email request failed:', error?.message || error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function persistInquiry(env, inquiry, spam, request) {
  const supabaseUrl = env?.SUPABASE_URL;
  const serviceRoleKey = env?.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Inquiry storage is not configured.');
    return false;
  }

  let endpoint;
  try {
    endpoint = new URL('/rest/v1/inquiries', supabaseUrl);
  } catch {
    console.error('Inquiry storage URL is invalid.');
    return false;
  }

  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    console.error('Inquiry storage must use a public HTTPS URL.');
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers = {
      apikey: serviceRoleKey,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    };
    if (!serviceRoleKey.startsWith('sb_secret_')) {
      headers.Authorization = `Bearer ${serviceRoleKey}`;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        name: inquiry.name,
        email: inquiry.email,
        company: inquiry.company || null,
        message: inquiry.message || null,
        pages: inquiry.pages || null,
        plan: inquiry.plan || null,
        features: inquiry.features,
        estimate: inquiry.estimate || null,
        monthly: inquiry.monthly || null,
        timeline: inquiry.timeline || null,
        locale: inquiry.locale,
        status: 'new',
        spam_score: spam.score,
        flags: spam.flags,
        ip_hash: await hashIp(request, env),
        user_agent: text(request.headers.get('user-agent'), 300) || null,
        source: 'estimate',
      }),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      console.error('Inquiry storage failed:', response.status, detail);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Inquiry storage request failed:', error?.message || error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function handleInquiryConfig(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ ok: false, error: 'Method Not Allowed' }, 405, {
      Allow: 'GET, HEAD',
    });
  }

  const body = {
    ok: true,
    siteKey: env?.TURNSTILE_SITE_KEY || '',
  };

  return request.method === 'HEAD'
    ? new Response(null, { headers: JSON_HEADERS })
    : json(body);
}

export async function handleInquiryRequest(request, env) {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Method Not Allowed' }, 405, {
      Allow: 'POST',
    });
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return fail('Send the inquiry as JSON.', 415);
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

  // Honeypot and too-fast submissions are dropped silently.
  if (payload?.website) return json({ ok: true, stored: false, ignored: true });
  const elapsedMs = Number(payload?.elapsedMs) || 0;
  if (elapsedMs > 0 && elapsedMs < MIN_SUBMIT_MS) return json({ ok: true, stored: false, ignored: true });

  const captcha = await verifyTurnstile(request, env, payload?.turnstileToken);
  if (!captcha.ok) {
    return fail('Please complete the verification and try again.', 400);
  }

  let inquiry;
  try {
    inquiry = validatePayload(payload);
  } catch (error) {
    if (error instanceof InquiryError) return fail(error.message, error.status);
    return fail('That inquiry could not be read.');
  }

  const spam = spamSignals(
    inquiry.name,
    inquiry.email,
    inquiry.company,
    inquiry.message
  );

  if (spam.score >= BLOCK_SCORE) {
    return fail(
      'Your message was flagged by our spam filter. Please rephrase it and try again.',
      422
    );
  }

  const [stored, emailed] = await Promise.all([
    persistInquiry(env, inquiry, spam, request),
    sendNotification(env, inquiry),
  ]);

  if (!stored) {
    console.error(`Inquiry was not stored in Supabase${emailed ? '; email notification was sent.' : ' and no notification was sent.'}`);
    return fail('We could not save your request. Please try again.', 500);
  }

  return json({ ok: true, stored: true });
}
