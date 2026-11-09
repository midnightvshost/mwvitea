const WEBHOOK_ENV_KEYS = [
  'DISCORD_WEBHOOK_URL',
  'DISCORD_STATUS_WEBHOOK_URL',
  'DISCORD_WEBHOOK',
];

const STATUS_PROBE_TIMEOUT_MS = 5000;

function normalizeWebhookUrl(value) {
  if (!value) return null;
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
  for (const key of WEBHOOK_ENV_KEYS) {
    const url = normalizeWebhookUrl(env?.[key]);
    if (url) return url;
  }
  return null;
}

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

async function probeSite(env, origin) {
  const started = Date.now();

  try {
    let response;

    if (env?.ASSETS && typeof env.ASSETS.fetch === 'function') {
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

async function sendDiscordWebhook(env, payload) {
  const webhookUrl = resolveWebhookUrl(env);

  if (!webhookUrl) {
    console.error(
      'Discord status webhook is not configured. Set DISCORD_WEBHOOK_URL as a secret in Cloudflare.'
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

export async function onRequest(context) {
  const { request, env, waitUntil } = context;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Allow: 'GET, HEAD',
        'Cache-Control': 'no-store',
      },
    });
  }

  const origin = new URL(request.url).origin;
  const statusData = {
    status: 'operational',
    timestamp: new Date().toISOString(),
    service: 'midnight-webs',
  };

  const debug = new URL(request.url).searchParams.get('debug') === '1';

  const deliver = async () => {
    const probe = await probeSite(env, origin);
    const payload = buildStatusPayload({ origin, request, statusData, probe });
    const webhook = await sendDiscordWebhook(env, payload);
    return { probe, webhook };
  };

  if (debug) {
    const { probe, webhook } = await deliver();
    statusData.probe = probe;
    statusData.webhook = webhook;
  } else if (typeof waitUntil === 'function') {
    waitUntil(deliver());
  } else {
    await deliver();
  }

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };

  if (request.method === 'HEAD') {
    return new Response(null, { headers });
  }

  return new Response(JSON.stringify(statusData), { headers });
}
