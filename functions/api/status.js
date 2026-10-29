export async function onRequest(context) {
  const { env } = context;
  const statusData = {
    status: 'operational',
    timestamp: new Date().toISOString(),
    service: 'midnight-webs'
  };
  
  try {
    if (env.DISCORD_WEBHOOK_URL) {
      await fetch(env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            title: '🟢 Site Status: Operational',
            description: 'Midnight Webs API status check',
            color: 0x00ff00,
            timestamp: statusData.timestamp,
          }]
        })
      });
    }
  } catch (e) {
    console.error('Webhook error:', e);
  }
  
  return new Response(JSON.stringify(statusData), {
    headers: { 'Content-Type': 'application/json' }
  });
}
