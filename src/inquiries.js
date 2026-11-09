// Project inquiry endpoint for /api/inquiry.
//
// Flow: the estimate page posts the selected scope plus contact details.
// The Worker verifies Cloudflare Turnstile, applies simple spam checks, stores
// the inquiry in Supabase with the service role key, then emails the owner and
// sends the visitor a confirmation. Both emails are sent through Gmail SMTP so
// they come from the real contact.midnightwebs@gmail.com mailbox.

import { connect } from 'cloudflare:sockets';

const MAX_REQUEST_BYTES = 16384;
const FETCH_TIMEOUT_MS = 8000;
const SMTP_TIMEOUT_MS = 15000;
const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 465;
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

const CONFIRMATION_COPY = {
  en: {
    subject: 'Confirmation - we received your request',
    heading: 'We received your request',
    greeting: (name) => `Hi ${name},`,
    intro:
      'Thank you for contacting Midnight Webs. We have received your project request and will reply to this email as soon as possible, usually within 1-2 business days.',
    summary: 'Here is a summary of your request:',
    labels: {
      pages: 'Pages',
      plan: 'Monthly plan',
      features: 'Features',
      estimate: 'Estimated build',
      monthly: 'Monthly',
      timeline: 'Delivery',
      notes: 'Notes',
    },
    outro: 'If you need to add or change anything, just reply to this email.',
    signature: 'Midnight Webs',
  },
  ro: {
    subject: 'Confirmare - am primit solicitarea ta',
    heading: 'Am primit solicitarea ta',
    greeting: (name) => `Salut ${name},`,
    intro:
      'Îți mulțumim că ai contactat Midnight Webs. Am primit solicitarea ta de proiect și îți vom răspunde pe acest email cât mai curând posibil, de obicei în 1-2 zile lucrătoare.',
    summary: 'Iată un rezumat al solicitării:',
    labels: {
      pages: 'Pagini',
      plan: 'Plan lunar',
      features: 'Funcționalități',
      estimate: 'Cost estimat',
      monthly: 'Lunar',
      timeline: 'Livrare',
      notes: 'Note',
    },
    outro: 'Dacă vrei să adaugi sau să modifici ceva, răspunde direct la acest email.',
    signature: 'Midnight Webs',
  },
  ru: {
    subject: 'Подтверждение - мы получили ваш запрос',
    heading: 'Мы получили ваш запрос',
    greeting: (name) => `Здравствуйте, ${name}!`,
    intro:
      'Спасибо, что связались с Midnight Webs. Мы получили ваш запрос на проект и ответим на это письмо в ближайшее время, обычно в течение 1-2 рабочих дней.',
    summary: 'Краткая информация о вашем запросе:',
    labels: {
      pages: 'Страницы',
      plan: 'Ежемесячный план',
      features: 'Функции',
      estimate: 'Ориентировочная стоимость',
      monthly: 'В месяц',
      timeline: 'Срок',
      notes: 'Примечания',
    },
    outro: 'Если хотите что-то добавить или изменить, просто ответьте на это письмо.',
    signature: 'Midnight Webs',
  },
};

function confirmationRows(inquiry, copy) {
  return [
    [copy.labels.pages, inquiry.pages],
    [copy.labels.plan, inquiry.plan],
    [copy.labels.features, inquiry.features.join(', ')],
    [copy.labels.estimate, inquiry.estimate],
    [copy.labels.monthly, inquiry.monthly],
    [copy.labels.timeline, inquiry.timeline],
    [copy.labels.notes, inquiry.message],
  ].filter(([, value]) => String(value || '').trim());
}

function buildConfirmation(inquiry) {
  const copy = CONFIRMATION_COPY[inquiry.locale] || CONFIRMATION_COPY.en;
  const rows = confirmationRows(inquiry, copy);
  const title = escapeHtml(copy.heading);

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f4f6fb">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px;font-family:Arial,sans-serif;color:#1b2430;line-height:1.6">
    <div style="padding:28px;background:#ffffff;border:1px solid #e2e8f2;border-radius:8px">
      <p style="margin:0 0 6px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#5b6577">Midnight Webs</p>
      <h1 style="margin:0 0 20px;font-size:22px;color:#0a1230">${title}</h1>
      <p style="margin:0 0 12px">${escapeHtml(copy.greeting(inquiry.name))}</p>
      <p style="margin:0 0 20px">${escapeHtml(copy.intro)}</p>
      <p style="margin:0 0 10px;font-weight:bold">${escapeHtml(copy.summary)}</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:22px">
        <tbody>
          ${rows
            .map(
              ([label, value]) =>
                `<tr><th style="text-align:left;padding:8px 12px 8px 0;vertical-align:top;border-bottom:1px solid #e2e8f2;font-size:13px">${escapeHtml(
                  label
                )}</th><td style="padding:8px 0;border-bottom:1px solid #e2e8f2;font-size:13px">${escapeHtml(
                  value
                ).replace(/\n/g, '<br>')}</td></tr>`
            )
            .join('')}
        </tbody>
      </table>
      <p style="margin:0 0 20px">${escapeHtml(copy.outro)}</p>
      <p style="margin:0;color:#5b6577;font-size:13px">${escapeHtml(
        copy.signature
      )}<br><a href="https://www.midnightwebs.com" style="color:#3e63e0">www.midnightwebs.com</a></p>
    </div>
  </div>
</body></html>`;

  const plain = [
    copy.heading,
    '',
    copy.greeting(inquiry.name),
    '',
    copy.intro,
    '',
    copy.summary,
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    copy.outro,
    '',
    copy.signature,
    'https://www.midnightwebs.com',
  ].join('\n');

  return { subject: copy.subject, html, text: plain };
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(String(value == null ? '' : value));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function wrapBase64(value) {
  return value.replace(/(.{76})/g, '$1\r\n');
}

function headerSafe(value) {
  return String(value == null ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
}

function encodeDisplayName(value) {
  const name = headerSafe(value);
  if (/^[\x20-\x7e]*$/.test(name) && !/[()<>@,;:\\".\[\]]/.test(name)) {
    return name;
  }
  return `=?UTF-8?B?${base64Utf8(name)}?=`;
}

function encodeSubject(value) {
  const subject = headerSafe(value);
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${base64Utf8(subject)}?=`;
}

function dotStuff(value) {
  return value.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

function buildMimeMessage({ fromName, from, to, replyTo, subject, html, text }) {
  const boundary = `mw_${crypto.randomUUID().replace(/-/g, '')}`;
  const domain = from.split('@')[1] || 'midnightwebs.com';
  const headers = [
    `From: ${encodeDisplayName(fromName)} <${from}>`,
    `To: ${to}`,
    `Reply-To: ${replyTo}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(base64Utf8(text)),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(base64Utf8(html)),
    `--${boundary}--`,
  ];

  return `${headers.join('\r\n')}\r\n\r\n${body.join('\r\n')}`;
}

class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
    this.buffer = '';
  }

  async readLine() {
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index !== -1) {
        const line = this.buffer.slice(0, index).replace(/\r$/, '');
        this.buffer = this.buffer.slice(index + 1);
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error('SMTP connection closed unexpectedly.');
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  async readResponse() {
    const lines = [];
    while (true) {
      const line = await this.readLine();
      lines.push(line);
      if (/^\d{3} /.test(line)) {
        return { code: Number(line.slice(0, 3)), lines };
      }
      if (!/^\d{3}-/.test(line)) {
        throw new Error(`Unexpected SMTP response: ${line}`);
      }
    }
  }

  async write(value) {
    await this.writer.write(this.encoder.encode(value));
  }

  async command(value) {
    await this.write(`${value}\r\n`);
    return this.readResponse();
  }

  async close() {
    try {
      await this.writer.close();
    } catch {}
    try {
      await this.reader.cancel();
    } catch {}
    try {
      this.socket.close();
    } catch {}
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function sendSmtpMail({ user, password, fromName, to, replyTo, subject, html, text }) {
  const fromAddress = headerSafe(user);
  const toAddress = headerSafe(to);
  const replyAddress = headerSafe(replyTo);
  const appPassword = String(password == null ? '' : password).replace(/\s+/g, '');
  const socket = connect(
    { hostname: SMTP_HOST, port: SMTP_PORT },
    { secureTransport: 'on', allowHalfOpen: false }
  );
  const session = new SmtpSession(socket);

  try {
    const greeting = await withTimeout(
      session.readResponse(),
      SMTP_TIMEOUT_MS,
      'SMTP greeting'
    );
    if (greeting.code !== 220) {
      throw new Error(`SMTP greeting failed: ${greeting.lines.join(' ')}`);
    }

    const ehlo = await withTimeout(
      session.command(`EHLO ${fromAddress.split('@')[1] || 'midnightwebs.com'}`),
      SMTP_TIMEOUT_MS,
      'SMTP EHLO'
    );
    if (ehlo.code !== 250) {
      throw new Error(`SMTP EHLO failed: ${ehlo.lines.join(' ')}`);
    }

    const authStart = await withTimeout(
      session.command('AUTH LOGIN'),
      SMTP_TIMEOUT_MS,
      'SMTP AUTH'
    );
    if (authStart.code !== 334) {
      throw new Error(`SMTP AUTH failed: ${authStart.lines.join(' ')}`);
    }

    const authUser = await withTimeout(
      session.command(base64Utf8(fromAddress)),
      SMTP_TIMEOUT_MS,
      'SMTP AUTH user'
    );
    if (authUser.code !== 334) {
      throw new Error(`SMTP AUTH user failed: ${authUser.lines.join(' ')}`);
    }

    const authPassword = await withTimeout(
      session.command(base64Utf8(appPassword)),
      SMTP_TIMEOUT_MS,
      'SMTP AUTH password'
    );
    if (authPassword.code !== 235) {
      throw new Error('SMTP authentication failed. Check GMAIL_APP_PASSWORD.');
    }

    const mailFrom = await withTimeout(
      session.command(`MAIL FROM:<${fromAddress}>`),
      SMTP_TIMEOUT_MS,
      'SMTP MAIL FROM'
    );
    if (mailFrom.code !== 250) {
      throw new Error(`SMTP MAIL FROM failed: ${mailFrom.lines.join(' ')}`);
    }

    const rcptTo = await withTimeout(
      session.command(`RCPT TO:<${toAddress}>`),
      SMTP_TIMEOUT_MS,
      'SMTP RCPT TO'
    );
    if (rcptTo.code !== 250 && rcptTo.code !== 251) {
      throw new Error(`SMTP RCPT TO failed: ${rcptTo.lines.join(' ')}`);
    }

    const data = await withTimeout(
      session.command('DATA'),
      SMTP_TIMEOUT_MS,
      'SMTP DATA'
    );
    if (data.code !== 354) {
      throw new Error(`SMTP DATA failed: ${data.lines.join(' ')}`);
    }

    const message = buildMimeMessage({
      fromName,
      from: fromAddress,
      to: toAddress,
      replyTo: replyAddress,
      subject,
      html,
      text,
    });

    await withTimeout(
      session.write(`${dotStuff(message)}\r\n.\r\n`),
      SMTP_TIMEOUT_MS,
      'SMTP message'
    );

    const queued = await withTimeout(
      session.readResponse(),
      SMTP_TIMEOUT_MS,
      'SMTP message result'
    );
    if (queued.code !== 250) {
      throw new Error(`SMTP message was rejected: ${queued.lines.join(' ')}`);
    }

    try {
      await withTimeout(session.command('QUIT'), SMTP_TIMEOUT_MS, 'SMTP QUIT');
    } catch {}
  } finally {
    await session.close();
  }
}

async function sendNotification(env, inquiry) {
  const user = env?.GMAIL_USER;
  const password = env?.GMAIL_APP_PASSWORD;
  const to = env?.MAIL_TO;
  if (!user || !password || !to) {
    console.warn('Inquiry email is not configured; notification skipped.');
    return false;
  }

  const { html, plain } = buildEmailBody(inquiry);

  try {
    await sendSmtpMail({
      user,
      password,
      fromName: env?.MAIL_FROM_NAME || 'Midnight Webs',
      to,
      replyTo: inquiry.email,
      subject: `New project request - ${text(inquiry.name, 60)}`,
      html,
      text: plain,
    });
    return true;
  } catch (error) {
    console.error('Inquiry notification failed:', error?.message || error);
    return false;
  }
}

async function sendConfirmation(env, inquiry) {
  const user = env?.GMAIL_USER;
  const password = env?.GMAIL_APP_PASSWORD;
  if (!user || !password) {
    console.warn('Confirmation email is not configured; skipping.');
    return false;
  }

  const { subject, html, text: plain } = buildConfirmation(inquiry);

  try {
    await sendSmtpMail({
      user,
      password,
      fromName: env?.MAIL_FROM_NAME || 'Midnight Webs',
      to: inquiry.email,
      replyTo: user,
      subject,
      html,
      text: plain,
    });
    return true;
  } catch (error) {
    console.error('Confirmation email failed:', error?.message || error);
    return false;
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

export async function handleInquiryRequest(request, env, ctx) {
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

  const stored = await persistInquiry(env, inquiry, spam, request);
  if (!stored) {
    console.error('Inquiry was not stored in Supabase.');
    return fail('We could not save your request. Please try again.', 500);
  }

  const emails = Promise.all([
    sendNotification(env, inquiry),
    sendConfirmation(env, inquiry),
  ]);

  if (ctx?.waitUntil) {
    ctx.waitUntil(emails);
  } else {
    await emails;
  }

  return json({ ok: true, stored: true });
}
