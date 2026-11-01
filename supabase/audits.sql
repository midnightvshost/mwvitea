create table if not exists public.audits (
  id bigint generated always as identity primary key,
  target_url text not null,
  final_url text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.audits enable row level security;

revoke all on table public.audits from anon, authenticated;
grant all on table public.audits to service_role;
grant usage, select on sequence public.audits_id_seq to service_role;

create index if not exists audits_created_at_idx
  on public.audits (created_at desc);
