const RATE_LIMIT_BINDING = 'API_RATE_LIMITER';
const RETRY_AFTER_SECONDS = 60;

function clientKey(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  return `${ip}:${pathname}`;
}

function tooManyRequests() {
  return new Response(JSON.stringify({ error: 'Too Many Requests' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': String(RETRY_AFTER_SECONDS),
    },
  });
}

export async function enforceApiRateLimit(request, env) {
  const limiter = env?.[RATE_LIMIT_BINDING];

  if (!limiter) {
    console.warn(`${RATE_LIMIT_BINDING} binding is not configured; rate limiting skipped`);
    return null;
  }

  try {
    const { success } = await limiter.limit({ key: clientKey(request) });
    return success ? null : tooManyRequests();
  } catch (error) {
    console.error('Rate limiter error:', error);
    return null;
  }
}
