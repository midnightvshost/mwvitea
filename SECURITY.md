# Security Configuration

## DDoS Protection & Rate Limiting
`rate-limiter.js` applies Cloudflare's Workers Rate Limiting binding to
`/api/*`. The binding is configured in `wrangler.jsonc` as
`API_RATE_LIMITER` (10 requests per 60 seconds per IP per endpoint).

Unlike the old in-memory limiter, this state is backed by Cloudflare and
survives cold starts and isolate restarts. Static assets are not rate limited.

## Status Monitoring with Discord Webhook
- `/status` and `/status/*` redirect to `/` (the status page is hidden).
- API endpoints are `/api/status` and `/api/health`.
- `/api/status` posts a notification to the configured Discord webhook.

## Setup Instructions
1. Deploy with `wrangler deploy` (Worker + Static Assets).
2. Add the secret with `wrangler secret put DISCORD_WEBHOOK_URL`.
3. Redeploy after changing configuration in `wrangler.jsonc`.

**Important:** Never commit webhook URLs to the repository. Always use environment variables/secrets.
