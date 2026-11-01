const RATE_LIMIT_BINDING = 'API_RATE_LIMITER';
const RETRY_AFTER_SECONDS = 60;
const MAX_KEY_LENGTH = 256;

const DEFAULT_METHOD_BUCKETS = {
  GET: 'read',
  HEAD: 'read',
  OPTIONS: 'read',
  POST: 'write',
  PUT: 'write',
  PATCH: 'write',
  DELETE: 'write',
};

const IP_HEADERS = [
  'cf-connecting-ip',
  'true-client-ip',
  'x-real-ip',
  'x-forwarded-for',
];

function normalizeIp(value) {
  if (!value) return null;

  let ip = value.split(',')[0].trim();
  if (!ip) return null;

  if (ip.startsWith('[')) {
    const closingBracket = ip.indexOf(']');
    if (closingBracket !== -1) ip = ip.slice(1, closingBracket);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(':'));
  }

  ip = ip.toLowerCase();

  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(mapped)) ip = mapped;
  }

  return ip || null;
}

function clientIp(request) {
  for (const header of IP_HEADERS) {
    const ip = normalizeIp(request.headers.get(header));
    if (ip) return ip;
  }

  return 'unknown';
}

function normalizePath(request) {
  let pathname;

  try {
    pathname = new URL(request.url).pathname;
  } catch {
    pathname = '/';
  }

  const normalized = pathname
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');

  return normalized || '/';
}

function tooManyRequests(retryAfterSeconds) {
  return new Response(JSON.stringify({ error: 'Too Many Requests' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': String(retryAfterSeconds),
    },
  });
}

function buildConfig(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const retryAfter = Number(opts.retryAfterSeconds);
  const methodBuckets =
    opts.methodBuckets && typeof opts.methodBuckets === 'object'
      ? opts.methodBuckets
      : {};
  const bucketBindings =
    opts.bucketBindings && typeof opts.bucketBindings === 'object'
      ? opts.bucketBindings
      : {};
  const skipMethods = Array.isArray(opts.skipMethods) ? opts.skipMethods : [];

  return {
    defaultBinding: opts.defaultBinding || RATE_LIMIT_BINDING,
    retryAfterSeconds:
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.ceil(retryAfter)
        : RETRY_AFTER_SECONDS,
    methodBuckets: { ...DEFAULT_METHOD_BUCKETS, ...methodBuckets },
    bucketBindings: { ...bucketBindings },
    skipMethods: new Set(
      skipMethods.map((method) => String(method).toUpperCase())
    ),
  };
}

function resolveBucket(config, method) {
  const bucket = config.methodBuckets[method] || method.toLowerCase() || 'default';
  return String(bucket).toLowerCase() || 'default';
}

function resolveLimiter(env, config, bucket) {
  const bindingName = config.bucketBindings[bucket] || config.defaultBinding;
  const limiter = env?.[bindingName];

  if (limiter) return { limiter, bindingName };

  if (bindingName !== config.defaultBinding) {
    const fallback = env?.[config.defaultBinding];
    if (fallback) {
      console.warn(
        `${bindingName} binding is not configured; falling back to ${config.defaultBinding}`
      );
      return { limiter: fallback, bindingName: config.defaultBinding };
    }
  }

  return { limiter: null, bindingName };
}

export async function enforceApiRateLimit(request, env, options = {}) {
  const config = buildConfig(options);
  const method = (request.method || 'GET').toUpperCase();

  if (config.skipMethods.has(method)) return null;

  const bucket = resolveBucket(config, method);
  const { limiter, bindingName } = resolveLimiter(env, config, bucket);

  if (!limiter) {
    console.warn(`${bindingName} binding is not configured; rate limiting skipped`);
    return null;
  }

  const key = `${clientIp(request)}:${bucket}:${normalizePath(request)}`.slice(
    0,
    MAX_KEY_LENGTH
  );

  try {
    const { success } = await limiter.limit({ key });
    return success ? null : tooManyRequests(config.retryAfterSeconds);
  } catch (error) {
    console.error('Rate limiter error:', error);
    return null;
  }
}
