# Security Setup for Cloudflare

Since you're using Cloudflare with static assets, you need to deploy this as a Worker with Assets (not just Pages Functions).

## Option 1: Deploy with Wrangler (Recommended)

1. Install Wrangler: `npm install -g wrangler` or `npx wrangler`
2. Login: `wrangler login`
3. Navigate to the mw folder: `cd /Users/user/Desktop/mw`
4. Add your webhook as a secret:
   ```bash
   wrangler secret put DISCORD_WEBHOOK_URL
   ```
   When prompted, paste your webhook URL
5. Deploy:
   ```bash
   wrangler deploy
   ```

## Option 2: Deploy via Cloudflare Dashboard

1. Go to Workers & Pages > Create > Worker
2. Upload the files (worker.js, wrangler.jsonc, and all your static files)
3. Add the secret in Settings > Variables > Add variable (as Secret) named `DISCORD_WEBHOOK_URL`
4. Deploy

## Testing

After deployment:
- Visit `https://your-worker-url.workers.dev/api/status` - This will post to Discord
- Visit `https://your-worker-url.workers.dev/api/health` - Health check
- `/api/*` is rate limited by the `API_RATE_LIMITER` binding in `wrangler.jsonc`

The webhook is stored as an encrypted secret and never exposed in your code.
