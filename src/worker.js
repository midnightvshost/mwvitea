// Cloudflare Worker for Midnight Webs.
//
// Routing model (see wrangler.jsonc):
//   - Static assets are served by the ASSETS binding *before* this Worker runs.
//   - Only /api/* and /status* invoke this Worker (assets.run_worker_first).
//   - Unmatched routes are handled by assets.not_found_handling = "404-page",
//     which serves 404.html with a real 404 status.
//
// API rate limiting is implemented in rate-limiter.js using Cloudflare's
// Rate Limiting binding (API_RATE_LIMITER in wrangler.jsonc).

import { enforceApiRateLimit } from './rate-limiter.js';
import { handleAuditRequest } from './audit.js';
import { handleInquiryConfig, handleInquiryRequest } from './inquiries.js';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

const DISCORD_WEBHOOK_ENV_KEYS = [
  'DISCORD_WEBHOOK_URL',
  'DISCORD_STATUS_WEBHOOK_URL',
  'DISCORD_WEBHOOK',
];

function normalizeWebhookUrl(value) {
  if (!value) return null;

  // Secrets are sometimes pasted with surrounding quotes or whitespace.
  const raw = String(value).trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function resolveWebhookUrl(env) {
  for (const key of DISCORD_WEBHOOK_ENV_KEYS) {
    const url = normalizeWebhookUrl(env?.[key]);
    if (url) return url;
  }
  return null;
}

const STATUS_PROBE_TIMEOUT_MS = 5000;

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function formatEdgeLocation(request) {
  const colo = request.cf?.colo;
  const country = request.cf?.country;
  if (colo && country) return `${colo} · ${country}`;
  return colo || country || 'Unknown';
}

// Loads the public site so the webhook reports a real page-load time instead
// of only echoing the status endpoint's own response.
async function probeSite(env, origin) {
  const started = Date.now();

  try {
    let response;

    if (env?.ASSETS && typeof env.ASSETS.fetch === 'function') {
      // Use the asset binding directly. Fetching the public URL from inside the
      // Worker can hit Cloudflare error 1042 (same-zone Worker subrequest),
      // which would report a false outage.
      response = await env.ASSETS.fetch(
        new Request(new URL('/', origin).toString(), {
          method: 'GET',
          headers: { Accept: 'text/html' },
        })
      );
    } else {
      response = await fetch(new URL('/', origin).toString(), {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': 'MidnightWebs-StatusMonitor/1.0',
          Accept: 'text/html',
        },
        signal: timeoutSignal(STATUS_PROBE_TIMEOUT_MS),
      });
    }

    // Read the body so the measurement covers the full response, not just TTFB.
    await response.arrayBuffer().catch(() => {});

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText || '',
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: '',
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildStatusPayload({ origin, request, statusData, probe }) {
  const unix = Math.floor(new Date(statusData.timestamp).getTime() / 1000);
  const httpLine = probe.status
    ? `${probe.status}${probe.statusText ? ` ${probe.statusText}` : ''}`
    : 'No response';
  const latencyLine = probe.ok
    ? `${probe.latencyMs} ms`
    : `${probe.latencyMs} ms (failed)`;

  const embed = {
    title: probe.ok
      ? '🟢 Midnight Webs — All Systems Operational'
      : '🔴 Midnight Webs — Performance Issue Detected',
    description: probe.ok
      ? 'Automated health check completed successfully. The website, API and supporting services are online and responding within normal parameters.'
      : 'Automated health check reported a problem reaching the website. The team has been alerted and is investigating.',
    color: probe.ok ? 0x2ecc71 : 0xe74c3c,
    fields: [
      {
        name: 'Status',
        value: probe.ok ? '🟢 Operational' : '🔴 Degraded',
        inline: true,
      },
      { name: 'Load Time', value: latencyLine, inline: true },
      { name: 'HTTP Response', value: httpLine, inline: true },
      { name: 'Endpoint', value: '`GET /api/status`', inline: true },
      { name: 'Edge Location', value: formatEdgeLocation(request), inline: true },
      { name: 'Checked', value: `<t:${unix}:F>`, inline: true },
    ],
    footer: { text: 'Midnight Webs • Automated Status Monitor' },
    timestamp: statusData.timestamp,
  };

  if (origin.startsWith('https://')) {
    embed.footer.icon_url = `${origin}/assets/img/brand-mark-120.png`;
  }

  if (probe.error) {
    embed.description += `\n\n**Probe error:** ${String(probe.error).slice(0, 300)}`;
  }

  return {
    username: 'Midnight Webs Status',
    embeds: [embed],
  };
}

// Returns a result object so callers can report why delivery failed instead of
// silently swallowing the error (which made the webhook look like it "works").
async function sendDiscordWebhook(env, payload) {
  const webhookUrl = resolveWebhookUrl(env);

  if (!webhookUrl) {
    console.error(
      'Discord status webhook is not configured. Set DISCORD_WEBHOOK_URL as a Worker secret (`wrangler secret put DISCORD_WEBHOOK_URL`). .dev.vars is local-only and is not deployed.'
    );
    return {
      ok: false,
      configured: false,
      error: 'DISCORD_WEBHOOK_URL is not configured in this environment',
    };
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(
        `Discord status webhook failed: HTTP ${response.status}${detail ? ` - ${detail}` : ''}`
      );
      return {
        ok: false,
        configured: true,
        status: response.status,
        error: detail || `Discord responded with HTTP ${response.status}`,
      };
    }

    return { ok: true, configured: true, status: response.status };
  } catch (e) {
    console.error('Discord status webhook error:', e);
    return {
      ok: false,
      configured: true,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      const limited = await enforceApiRateLimit(request, env);
      if (limited) return limited;
    }

    if (url.pathname === '/api/health' || url.pathname === '/api/health/') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ error: 'Method Not Allowed' }, 405, { Allow: 'GET, HEAD' });
      }
      const body = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        checks: { site: 'ok' },
      };
      return request.method === 'HEAD'
        ? new Response(null, { headers: JSON_HEADERS })
        : json(body);
    }

    if (url.pathname === '/api/status' || url.pathname === '/api/status/') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ error: 'Method Not Allowed' }, 405, { Allow: 'GET, HEAD' });
      }
      const statusData = {
        status: 'operational',
        timestamp: new Date().toISOString(),
        service: 'midnight-webs',
      };
      // `?debug=1` awaits the check and returns the result, which makes it easy
      // to verify the production secret is configured correctly.
      const debug = url.searchParams.get('debug') === '1';

      const deliver = async () => {
        const probe = await probeSite(env, url.origin);
        const payload = buildStatusPayload({
          origin: url.origin,
          request,
          statusData,
          probe,
        });
        const webhook = await sendDiscordWebhook(env, payload);
        return { probe, webhook };
      };

      if (debug) {
        const { probe, webhook } = await deliver();
        statusData.probe = probe;
        statusData.webhook = webhook;
      } else {
        // Do not block the response on the site probe or webhook.
        ctx.waitUntil(deliver());
      }

      return request.method === 'HEAD'
        ? new Response(null, { headers: JSON_HEADERS })
        : json(statusData);
    }

    if (url.pathname === '/api/audit' || url.pathname === '/api/audit/') {
      return handleAuditRequest(request, env, ctx);
    }

    if (
      url.pathname === '/api/inquiry/config' ||
      url.pathname === '/api/inquiry/config/'
    ) {
      return handleInquiryConfig(request, env);
    }

    if (url.pathname === '/api/inquiry' || url.pathname === '/api/inquiry/') {
      return handleInquiryRequest(request, env, ctx);
    }

    // Unknown API route: return JSON, not the HTML 404 page.
    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'Not Found' }, 404);
    }

    // The status page is intentionally hidden. Redirect instead of returning
    // 404 so uptime probes and old links do not inflate the 4xx error rate.
    if (url.pathname === '/status' || url.pathname.startsWith('/status/')) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/', 'Cache-Control': 'no-store' },
      });
    }

    // Fallback for any other matched run_worker_first path.
    try {
      return await env.ASSETS.fetch(request);
    } catch (e) {
      console.error('Asset fetch failed:', e);
      return new Response('Internal Server Error', {
        status: 500,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
  },
};
