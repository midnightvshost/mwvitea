create table if not exists public.inquiries (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name text not null,
  email text not null,
  company text,
  message text,
  pages text,
  plan text,
  features jsonb not null default '[]'::jsonb,
  estimate text,
  monthly text,
  timeline text,
  locale text not null default 'en',
  status text not null default 'new',
  spam_score integer not null default 0,
  flags jsonb not null default '[]'::jsonb,
  ip_hash text,
  user_agent text,
  source text not null default 'estimate'
);

alter table public.inquiries enable row level security;

revoke all on table public.inquiries from anon, authenticated;
grant all on table public.inquiries to service_role;
grant usage, select on sequence public.inquiries_id_seq to service_role;

create index if not exists inquiries_created_at_idx
  on public.inquiries (created_at desc);

create index if not exists inquiries_email_idx
  on public.inquiries (lower(email));
