-- OmniDrive cloud-linked account registry.
--
-- This stores account identity metadata only. It does not store Google access
-- tokens or refresh tokens. New devices can show previously linked accounts,
-- then ask the user to reconnect Google locally before Drive data is available.

create table if not exists public.linked_google_accounts (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_id text not null,
  label text not null,
  display_name text not null,
  email text,
  source_kind text not null check (source_kind in ('drive', 'photos')),
  last_synced_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, account_id)
);

alter table public.linked_google_accounts enable row level security;

drop policy if exists "Users can read their linked Google accounts" on public.linked_google_accounts;
create policy "Users can read their linked Google accounts"
  on public.linked_google_accounts
  for select
  using (auth.uid() = user_id);

drop policy if exists "Users can create their linked Google accounts" on public.linked_google_accounts;
create policy "Users can create their linked Google accounts"
  on public.linked_google_accounts
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their linked Google accounts" on public.linked_google_accounts;
create policy "Users can update their linked Google accounts"
  on public.linked_google_accounts
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their linked Google accounts" on public.linked_google_accounts;
create policy "Users can delete their linked Google accounts"
  on public.linked_google_accounts
  for delete
  using (auth.uid() = user_id);

create or replace function public.set_linked_google_accounts_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_linked_google_accounts_updated_at on public.linked_google_accounts;
create trigger set_linked_google_accounts_updated_at
  before update on public.linked_google_accounts
  for each row
  execute function public.set_linked_google_accounts_updated_at();
