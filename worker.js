// Cloudflare Worker for Midnight Webs.
//
// Routing model (see wrangler.jsonc):
//   - Static assets are served by the ASSETS binding *before* this Worker runs.
//   - Only /api/* and /status* invoke this Worker (assets.run_worker_first).
//   - Unmatched routes are handled by assets.not_found_handling = "404-page",
//     which serves 404.html with a real 404 status.
//
// The previous in-memory rate limiter has been removed: it was per-isolate,
// reset on every cold start, and returned 429s (4xx) that polluted the error
// rate. Use a Cloudflare WAF Rate Limiting rule if you need real limiting.

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

async function sendDiscordWebhook(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('Webhook error:', e);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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
      // Do not block the response on the webhook.
      ctx.waitUntil(
        sendDiscordWebhook(env.DISCORD_WEBHOOK_URL, {
          embeds: [{
            title: '🟢 Site Status: Operational',
            description: 'Midnight Webs API status check',
            color: 0x00ff00,
            timestamp: statusData.timestamp,
          }],
        })
      );
      return request.method === 'HEAD'
        ? new Response(null, { headers: JSON_HEADERS })
        : json(statusData);
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
