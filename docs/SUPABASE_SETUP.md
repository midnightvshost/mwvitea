# Supabase audit storage setup

When both `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are configured, the
`/api/audit` Worker endpoint stores each successful audit in `public.audits`
without delaying the response. If storage is not configured or the insert
fails, the audit still returns to the visitor and the error is logged.

The service key is only used in Worker server code and must never be placed in
browser code or committed to Git.

## Database

In the Supabase dashboard, open **SQL Editor → New query**, paste the contents
of [`supabase/audits.sql`](supabase/audits.sql), and click **Run**. This creates
the table, enables RLS, and grants table access only to the `service_role`.
It creates no public policies.

## Local development

The repository ignores `.dev.vars`. Create `/Users/user/Desktop/mw/.dev.vars`
with these lines, filling the key value from **Project Settings → API Keys**.
Use the secret key (usually named `default` and starting with `sb_secret_`) or
the legacy `service_role` key. Do not use a publishable or `anon` key. The
Supabase label may be `default`; the Worker variable name must be
`SUPABASE_SERVICE_ROLE_KEY`:

```dotenv
SUPABASE_URL=https://pqevbgelvgfalkwamkcl.supabase.co
SUPABASE_SERVICE_ROLE_KEY=paste_the_secret_key_value_here
```

Do not commit or share `.dev.vars`.

For project inquiries in local development, also add `GMAIL_APP_PASSWORD`,
`TURNSTILE_SECRET_KEY` and `INQUIRY_HASH_SALT` to `.dev.vars`, and set
`TURNSTILE_SITE_KEY` in `wrangler.jsonc`.

## Production

`SUPABASE_URL` is configured in `wrangler.jsonc`. From this project directory,
run:

```sh
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

Paste the service role secret when Wrangler prompts for it, then deploy with
`wrangler deploy`.

## Project inquiries

The estimate form posts to `/api/inquiry`, which stores submissions in
`public.inquiries`, emails a notification to `MAIL_TO` with `Reply-To` set to
the visitor, and sends the visitor a confirmation email. Both emails are sent
through Gmail SMTP as `contact.midnightwebs@gmail.com`.

1. Run [`supabase/inquiries.sql`](supabase/inquiries.sql) in the Supabase SQL
   editor. Like `audits`, it is accessible only through the `service_role`.
2. Create a Cloudflare Turnstile site and copy its keys.
3. Turn on 2-Step Verification for `contact.midnightwebs@gmail.com`, then open
   **Google Account → Security → App passwords**, create one named
   `Midnight Webs`, and copy the 16-character password.
4. Set the public site key in `wrangler.jsonc`:
   ```jsonc
   "TURNSTILE_SITE_KEY": "your_public_site_key"
   ```
   `GMAIL_USER` and `MAIL_TO` are already set to
   `contact.midnightwebs@gmail.com`.
5. Add the secrets:
   ```sh
   wrangler secret put GMAIL_APP_PASSWORD
   wrangler secret put TURNSTILE_SECRET_KEY
   wrangler secret put INQUIRY_HASH_SALT
   ```
   `INQUIRY_HASH_SALT` is any long random string; it is used to hash visitor
   IP addresses before storage.
6. Deploy. If `GMAIL_APP_PASSWORD` is missing, submissions are still stored in
   Supabase and both emails are skipped.
