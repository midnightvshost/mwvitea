# Security Configuration

## DDoS Protection & Rate Limiting
Rate limiting is no longer implemented inside the Worker. The previous
in-memory limiter was per-isolate (resetting on every cold start) and returned
429 responses that inflated the client 4xx error rate.

Use a Cloudflare **WAF > Rate limiting rule** on `/api/*` instead. Static
assets are served directly by Cloudflare and should not be rate limited.

## Status Monitoring with Discord Webhook
- `/status` and `/status/*` redirect to `/` (the status page is hidden).
- API endpoints are `/api/status` and `/api/health`.
- `/api/status` posts a notification to the configured Discord webhook.

## Setup Instructions
1. Deploy with `wrangler deploy` (Worker + Static Assets).
2. Add the secret with `wrangler secret put DISCORD_WEBHOOK_URL`.
3. Redeploy after changing configuration in `wrangler.jsonc`.

**Important:** Never commit webhook URLs to the repository. Always use environment variables/secrets.
