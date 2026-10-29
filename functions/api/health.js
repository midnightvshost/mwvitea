export async function onRequest(context) {
  return new Response(JSON.stringify({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    checks: { site: 'ok' }
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
