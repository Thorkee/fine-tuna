-- Supabase SQL schema for Tuna console
-- Run this in the Supabase SQL editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users/Profiles table (Merged: extends Supabase auth.users)
-- Combining original 'profiles' with new fields
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade not null primary key,
  full_name text,
  username text unique,
  avatar_url text,
  website text,
  preferences jsonb default '{"comm": {"email_updates": true, "queued_task_start": false}, "mcp": {"enabled_servers": ["firecrawl-mcp"]}}'::jsonb,
  -- Onboarding (mandatory for newly created users)
  onboarding_completed boolean not null default true,
  onboarding_completed_at timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now()),

  constraint username_length check (char_length(username) >= 3)
);

-- Ensure onboarding columns exist for existing installs
alter table public.profiles
  add column if not exists onboarding_completed boolean not null default true;

alter table public.profiles
  add column if not exists onboarding_completed_at timestamp with time zone;

alter table public.profiles
  add column if not exists preferences jsonb default '{"comm": {"email_updates": true, "queued_task_start": false}, "mcp": {"enabled_servers": ["firecrawl-mcp"]}}'::jsonb;

alter table public.profiles
  drop column if exists email;

-- Enable RLS
alter table public.profiles enable row level security;

drop policy if exists "Public profiles are viewable by everyone." on profiles;
create policy "Public profiles are viewable by everyone."
  on profiles for select
  using ( true );

drop policy if exists "Users can insert their own profile." on profiles;
create policy "Users can insert their own profile."
  on profiles for insert
  with check ( auth.uid() = id );

drop policy if exists "Users can update own profile." on profiles;
create policy "Users can update own profile."
  on profiles for update
  using ( auth.uid() = id );

-- Server-only user integrations (provider tokens). Access via service-role only.
create table if not exists public.user_integrations (
  user_id uuid references auth.users on delete cascade not null,
  provider text not null check (provider in ('huggingface', 'github', 'kaggle', 'firecrawl')),
  access_token text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  primary key (user_id, provider)
);

-- Ensure provider check constraint supports new providers for existing installs.
alter table public.user_integrations
  drop constraint if exists user_integrations_provider_check;

alter table public.user_integrations
  add constraint user_integrations_provider_check
  check (provider in ('huggingface', 'github', 'kaggle', 'firecrawl'));

alter table public.user_integrations enable row level security;

-- Intentionally no authenticated/anon policies: only service role should read/write tokens.
revoke all on table public.user_integrations from anon, authenticated;

-- Server-only user MCP servers (remote HTTP). Access via service-role only.
create table if not exists public.user_mcp_servers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  label text not null,
  transport text not null check (transport in ('http')),
  url text not null,
  headers jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.user_mcp_servers enable row level security;

-- Intentionally no authenticated/anon policies: only service role should read/write MCP servers.
revoke all on table public.user_mcp_servers from anon, authenticated;

-- Server-only MCP tool approvals (first-use only). Access via service-role only.
create table if not exists public.user_mcp_tool_approvals (
  user_id uuid references auth.users on delete cascade not null,
  server_id uuid references public.user_mcp_servers(id) on delete cascade not null,
  tool_name text not null,
  approved_at timestamp with time zone default timezone('utc'::text, now()) not null,
  primary key (user_id, server_id, tool_name)
);

alter table public.user_mcp_tool_approvals enable row level security;

-- Intentionally no authenticated/anon policies: only service role should read/write MCP approvals.
revoke all on table public.user_mcp_tool_approvals from anon, authenticated;

-- Connected source repos (currently GitHub) for agent editing/publish workflows.
create table if not exists public.integration_repo_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  provider text not null check (provider in ('github')),
  repo_full_name text not null,
  is_private boolean not null default false,
  base_branch text not null default 'main',
  work_branch text not null default 'tuna',
  default_publish_mode text not null default 'pr' check (default_publish_mode in ('pr', 'direct')),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (user_id, provider, repo_full_name)
);

alter table public.integration_repo_connections enable row level security;

drop policy if exists "Users can view own repo connections" on integration_repo_connections;
create policy "Users can view own repo connections"
  on integration_repo_connections for select
  using (auth.uid() = user_id);

drop policy if exists "Users can create own repo connections" on integration_repo_connections;
create policy "Users can create own repo connections"
  on integration_repo_connections for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own repo connections" on integration_repo_connections;
create policy "Users can update own repo connections"
  on integration_repo_connections for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete own repo connections" on integration_repo_connections;
create policy "Users can delete own repo connections"
  on integration_repo_connections for delete
  using (auth.uid() = user_id);

-- Handle new user signup -> auto create profile
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, avatar_url, onboarding_completed, onboarding_completed_at, preferences)
  values (
    new.id, 
    new.raw_user_meta_data->>'full_name', 
    new.raw_user_meta_data->>'avatar_url',
    false,
    null,
    '{"comm": {"email_updates": true, "queued_task_start": false}, "mcp": {"enabled_servers": ["firecrawl-mcp"]}}'::jsonb
  );
  return new;
end;
$$ language plpgsql security definer;

-- Trigger for new users
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ==========================================
-- LEGACY CHAT TABLES (Preserved for current UI)
-- ==========================================

-- CHATS TABLE
create table if not exists public.chats (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  title text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.chats enable row level security;

drop policy if exists "Users can view their own chats" on chats;
create policy "Users can view their own chats" on chats for select using ( auth.uid() = user_id );
drop policy if exists "Users can insert their own chats" on chats;
create policy "Users can insert their own chats" on chats for insert with check ( auth.uid() = user_id );
drop policy if exists "Users can update their own chats" on chats;
create policy "Users can update their own chats" on chats for update using ( auth.uid() = user_id );
drop policy if exists "Users can delete their own chats" on chats;
create policy "Users can delete their own chats" on chats for delete using ( auth.uid() = user_id );

-- MESSAGES TABLE
create table if not exists public.messages (
  id uuid default gen_random_uuid() primary key,
  chat_id uuid references public.chats on delete cascade not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  files jsonb, 
  tool_calls jsonb,
  status jsonb,
  reasoning_summary text,
  reasoning_segments jsonb,
  trace_segments jsonb,
  render_order jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Ensure status column exists for existing installs
alter table public.messages
  add column if not exists status jsonb;
alter table public.messages
  add column if not exists reasoning_summary text;
alter table public.messages
  add column if not exists reasoning_segments jsonb;
alter table public.messages
  add column if not exists trace_segments jsonb;
alter table public.messages
  add column if not exists render_order jsonb;

alter table public.messages enable row level security;

drop policy if exists "Users can view messages in their chats" on messages;
create policy "Users can view messages in their chats" on messages for select
  using ( exists ( select 1 from chats where id = messages.chat_id and user_id = auth.uid() ) );
drop policy if exists "Users can insert messages in their chats" on messages;
create policy "Users can insert messages in their chats" on messages for insert
  with check ( exists ( select 1 from chats where id = messages.chat_id and user_id = auth.uid() ) );
drop policy if exists "Users can update messages in their chats" on messages;
create policy "Users can update messages in their chats" on messages for update
  using ( exists ( select 1 from chats where id = messages.chat_id and user_id = auth.uid() ) );

-- AGENT STATES TABLE
create table if not exists public.agent_states (
  chat_id uuid references public.chats on delete cascade primary key,
  state jsonb not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.agent_states enable row level security;

drop policy if exists "Users can view agent states in their chats" on agent_states;
create policy "Users can view agent states in their chats" on agent_states for select
  using ( exists ( select 1 from chats where id = agent_states.chat_id and user_id = auth.uid() ) );
drop policy if exists "Users can insert agent states in their chats" on agent_states;
create policy "Users can insert agent states in their chats" on agent_states for insert
  with check ( exists ( select 1 from chats where id = agent_states.chat_id and user_id = auth.uid() ) );
drop policy if exists "Users can update agent states in their chats" on agent_states;
create policy "Users can update agent states in their chats" on agent_states for update
  using ( exists ( select 1 from chats where id = agent_states.chat_id and user_id = auth.uid() ) );
drop policy if exists "Users can delete agent states in their chats" on agent_states;
create policy "Users can delete agent states in their chats" on agent_states for delete
  using ( exists ( select 1 from chats where id = agent_states.chat_id and user_id = auth.uid() ) );

-- AGENT RUNS TABLE
create table if not exists public.agent_runs (
  id uuid default gen_random_uuid() primary key,
  chat_id uuid references public.chats on delete cascade not null,
  status text not null check (status in ('running', 'done', 'failed', 'cancelled')),
  error text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.agent_runs enable row level security;

drop policy if exists "Users can view agent runs in their chats" on agent_runs;
create policy "Users can view agent runs in their chats" on agent_runs for select
  using ( exists ( select 1 from chats where id = agent_runs.chat_id and user_id = auth.uid() ) );
drop policy if exists "Users can insert agent runs in their chats" on agent_runs;
create policy "Users can insert agent runs in their chats" on agent_runs for insert
  with check ( exists ( select 1 from chats where id = agent_runs.chat_id and user_id = auth.uid() ) );
drop policy if exists "Users can update agent runs in their chats" on agent_runs;
create policy "Users can update agent runs in their chats" on agent_runs for update
  using ( exists ( select 1 from chats where id = agent_runs.chat_id and user_id = auth.uid() ) );
drop policy if exists "Users can delete agent runs in their chats" on agent_runs;
create policy "Users can delete agent runs in their chats" on agent_runs for delete
  using ( exists ( select 1 from chats where id = agent_runs.chat_id and user_id = auth.uid() ) );

-- CHAT SHARES TABLE (Public share URLs -> immutable snapshots)
create table if not exists public.chat_shares (
  share_id uuid default gen_random_uuid() primary key,
  chat_id uuid references public.chats on delete cascade not null,
  owner_id uuid references auth.users on delete cascade not null,
  snapshot jsonb not null,
  is_public boolean not null default true,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  expires_at timestamp with time zone,
  revoked_at timestamp with time zone,
  constraint chat_shares_expires_after_created
    check (expires_at is null or expires_at > created_at)
);

create index if not exists chat_shares_chat_id_idx on public.chat_shares(chat_id);
create index if not exists chat_shares_owner_id_idx on public.chat_shares(owner_id);
create index if not exists chat_shares_expires_at_idx on public.chat_shares(expires_at);

alter table public.chat_shares enable row level security;

drop policy if exists "Owners can view their chat shares" on chat_shares;
create policy "Owners can view their chat shares" on chat_shares for select
  using ( auth.uid() = owner_id );

drop policy if exists "Public can view public chat shares" on chat_shares;
create policy "Public can view public chat shares" on chat_shares for select
  using (
    is_public = true
    and revoked_at is null
    and (expires_at is null or expires_at > now())
  );

drop policy if exists "Owners can create chat shares" on chat_shares;
create policy "Owners can create chat shares" on chat_shares for insert
  with check (
    auth.uid() = owner_id
    and exists ( select 1 from chats where id = chat_shares.chat_id and user_id = auth.uid() )
  );

drop policy if exists "Owners can update chat shares" on chat_shares;
create policy "Owners can update chat shares" on chat_shares for update
  using ( auth.uid() = owner_id )
  with check ( auth.uid() = owner_id );

drop policy if exists "Owners can delete chat shares" on chat_shares;
create policy "Owners can delete chat shares" on chat_shares for delete
  using ( auth.uid() = owner_id );

-- ==========================================
-- BILLING / CREDITS
-- ==========================================

create table if not exists public.billing_accounts (
  user_id uuid references auth.users on delete cascade primary key,
  plan text not null default 'free',
  status text not null default 'active' check (status in ('active', 'trialing', 'past_due', 'paused', 'canceled')),
  credits_balance bigint not null default 5000,
  daily_credits_balance bigint not null default 0,
  daily_credits_refreshed_at date,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.billing_accounts
  alter column credits_balance set default 5000;

alter table public.billing_accounts
  add column if not exists daily_credits_balance bigint not null default 0;

alter table public.billing_accounts
  add column if not exists daily_credits_refreshed_at date;

alter table public.billing_accounts enable row level security;

drop policy if exists "Users can view own billing account" on public.billing_accounts;
create policy "Users can view own billing account"
  on public.billing_accounts for select
  using ( auth.uid() = user_id );

create table if not exists public.billing_customers (
  user_id uuid references auth.users on delete cascade primary key,
  stripe_customer_id text unique not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.billing_customers enable row level security;

-- No direct policies: managed by server/service role only.

create table if not exists public.billing_subscriptions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  stripe_subscription_id text unique not null,
  status text not null check (status in ('active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused')),
  current_period_start timestamp with time zone,
  current_period_end timestamp with time zone,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.billing_subscriptions enable row level security;

drop policy if exists "Users can view own billing subscriptions" on public.billing_subscriptions;
create policy "Users can view own billing subscriptions"
  on public.billing_subscriptions for select
  using ( auth.uid() = user_id );

create table if not exists public.billing_rates (
  id uuid default gen_random_uuid() primary key,
  provider text not null,
  model text not null,
  credits_per_1m_input_tokens bigint not null,
  credits_per_1m_output_tokens bigint not null,
  credits_per_1m_cached_input_tokens bigint,
  active boolean not null default true,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (provider, model)
);

alter table public.billing_rates enable row level security;

-- No direct policies: managed by server/service role only.

-- Default billing rates (adjust to match your deployment/model costs).
insert into public.billing_rates (
  provider,
  model,
  credits_per_1m_input_tokens,
  credits_per_1m_output_tokens
) values (
  'azure_openai',
  'gpt-5.2',
  1000,
  1000
) on conflict (provider, model) do nothing;

create table if not exists public.billing_skus (
  stripe_price_id text primary key,
  kind text not null check (kind in ('subscription_monthly', 'topup_pack')),
  credits_base bigint not null,
  credits_multiplier numeric not null default 1,
  currency text not null default 'usd',
  amount_cents integer,
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.billing_skus enable row level security;

-- No direct policies: managed by server/service role only.

create table if not exists public.credit_ledger (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  entry_type text not null check (entry_type in ('grant', 'usage', 'refund', 'adjustment', 'expire')),
  source text,
  amount bigint not null,
  chat_id uuid references public.chats on delete set null,
  run_id uuid references public.agent_runs on delete set null,
  provider text,
  model text,
  input_tokens integer,
  output_tokens integer,
  cached_tokens integer,
  stripe_event_id text,
  stripe_invoice_id text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists credit_ledger_user_id_idx on public.credit_ledger(user_id, created_at desc);
create index if not exists credit_ledger_run_id_idx on public.credit_ledger(run_id);
create index if not exists credit_ledger_chat_id_idx on public.credit_ledger(chat_id);
create unique index if not exists credit_ledger_stripe_event_id_idx on public.credit_ledger(stripe_event_id)
  where stripe_event_id is not null;

-- Backfill initial credits for accounts that have no ledger activity.
-- Note: credit_ledger must exist before we can reference it.
update public.billing_accounts
set credits_balance = 5000
where credits_balance = 0
  and not exists (
    select 1 from public.credit_ledger
    where credit_ledger.user_id = billing_accounts.user_id
  );

alter table public.credit_ledger enable row level security;

drop policy if exists "Users can view own credit ledger" on public.credit_ledger;
create policy "Users can view own credit ledger"
  on public.credit_ledger for select
  using ( auth.uid() = user_id );

-- E2B usage meters (service role only)
-- These tables let the server track how much E2B usage has been billed so far,
-- without trusting any client-provided state.
create table if not exists public.e2b_session_meters (
  session_id uuid primary key,
  user_id uuid references auth.users on delete cascade not null,
  chat_id uuid references public.chats on delete set null,
  started_at timestamp with time zone not null,
  billed_minutes integer not null default 0,
  billed_through_at timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists e2b_session_meters_user_id_idx
  on public.e2b_session_meters(user_id, updated_at desc);
create index if not exists e2b_session_meters_chat_id_idx
  on public.e2b_session_meters(chat_id);

alter table public.e2b_session_meters enable row level security;
-- No direct policies: managed by server/service role only.

create table if not exists public.e2b_training_task_meters (
  task_id uuid primary key,
  user_id uuid references auth.users on delete cascade not null,
  chat_id uuid references public.chats on delete set null,
  submitted_at timestamp with time zone default timezone('utc'::text, now()) not null,
  status text,
  billed boolean not null default false,
  billed_credits bigint not null default 0,
  billed_at timestamp with time zone,
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists e2b_training_task_meters_user_id_idx
  on public.e2b_training_task_meters(user_id, updated_at desc);
create index if not exists e2b_training_task_meters_chat_id_idx
  on public.e2b_training_task_meters(chat_id);

alter table public.e2b_training_task_meters enable row level security;
-- No direct policies: managed by server/service role only.

-- Billing RPCs (security definer)
create or replace function public.get_credit_balance()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  bal bigint;
  daily_bal bigint;
  daily_refreshed_at date;
  today date := timezone('utc', now())::date;
  daily_amount bigint := 500;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  insert into public.billing_accounts (user_id)
  values (uid)
  on conflict (user_id) do nothing;

  select credits_balance, daily_credits_balance, daily_credits_refreshed_at
    into bal, daily_bal, daily_refreshed_at
  from public.billing_accounts
  where user_id = uid
  for update;

  bal := coalesce(bal, 0);
  daily_bal := coalesce(daily_bal, 0);

  if daily_refreshed_at is null or daily_refreshed_at < today then
    if daily_bal > 0 and daily_refreshed_at is not null then
      insert into public.credit_ledger (
        user_id,
        entry_type,
        source,
        amount,
        metadata
      ) values (
        uid,
        'expire',
        'daily_refresh',
        -daily_bal,
        jsonb_build_object('bucket', 'daily', 'reason', 'daily_refresh')
      );
    end if;

    update public.billing_accounts
    set daily_credits_balance = daily_amount,
        daily_credits_refreshed_at = today,
        updated_at = now()
    where user_id = uid
    returning daily_credits_balance, daily_credits_refreshed_at into daily_bal, daily_refreshed_at;

    insert into public.credit_ledger (
      user_id,
      entry_type,
      source,
      amount,
      metadata
    ) values (
      uid,
      'grant',
      'daily_refresh',
      daily_amount,
      jsonb_build_object('bucket', 'daily', 'reason', 'daily_refresh')
    );
  end if;

  return bal;
end;
$$;

grant execute on function public.get_credit_balance() to authenticated;

create or replace function public.get_credit_summary()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  bal bigint;
  daily_bal bigint;
  daily_refreshed_at date;
  today date := timezone('utc', now())::date;
  daily_amount bigint := 500;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  insert into public.billing_accounts (user_id)
  values (uid)
  on conflict (user_id) do nothing;

  select credits_balance, daily_credits_balance, daily_credits_refreshed_at
    into bal, daily_bal, daily_refreshed_at
  from public.billing_accounts
  where user_id = uid
  for update;

  bal := coalesce(bal, 0);
  daily_bal := coalesce(daily_bal, 0);

  if daily_refreshed_at is null or daily_refreshed_at < today then
    if daily_bal > 0 and daily_refreshed_at is not null then
      insert into public.credit_ledger (
        user_id,
        entry_type,
        source,
        amount,
        metadata
      ) values (
        uid,
        'expire',
        'daily_refresh',
        -daily_bal,
        jsonb_build_object('bucket', 'daily', 'reason', 'daily_refresh')
      );
    end if;

    update public.billing_accounts
    set daily_credits_balance = daily_amount,
        daily_credits_refreshed_at = today,
        updated_at = now()
    where user_id = uid
    returning daily_credits_balance, daily_credits_refreshed_at into daily_bal, daily_refreshed_at;

    insert into public.credit_ledger (
      user_id,
      entry_type,
      source,
      amount,
      metadata
    ) values (
      uid,
      'grant',
      'daily_refresh',
      daily_amount,
      jsonb_build_object('bucket', 'daily', 'reason', 'daily_refresh')
    );
  end if;

  return jsonb_build_object(
    'credits_balance', bal,
    'daily_credits_balance', daily_bal,
    'daily_credits_refreshed_at', daily_refreshed_at,
    'total_credits', bal + daily_bal
  );
end;
$$;

grant execute on function public.get_credit_summary() to authenticated;

create or replace function public.consume_credits(
  p_run_id uuid,
  p_amount bigint,
  p_metadata jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  current_balance bigint;
  daily_balance bigint;
  new_balance bigint;
  new_daily_balance bigint;
  daily_refreshed_at date;
  today date := timezone('utc', now())::date;
  daily_amount bigint := 500;
  daily_used bigint;
  base_used bigint;
  chat_id_val uuid;
  source_val text;
  provider_val text;
  model_val text;
  input_tokens_val integer;
  output_tokens_val integer;
  cached_tokens_val integer;
  usage_metadata jsonb;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid amount';
  end if;

  insert into public.billing_accounts (user_id)
  values (uid)
  on conflict (user_id) do nothing;

  select credits_balance, daily_credits_balance, daily_credits_refreshed_at
    into current_balance, daily_balance, daily_refreshed_at
  from public.billing_accounts
  where user_id = uid
  for update;

  current_balance := coalesce(current_balance, 0);
  daily_balance := coalesce(daily_balance, 0);

  if daily_refreshed_at is null or daily_refreshed_at < today then
    if daily_balance > 0 and daily_refreshed_at is not null then
      insert into public.credit_ledger (
        user_id,
        entry_type,
        source,
        amount,
        metadata
      ) values (
        uid,
        'expire',
        'daily_refresh',
        -daily_balance,
        jsonb_build_object('bucket', 'daily', 'reason', 'daily_refresh')
      );
    end if;

    update public.billing_accounts
    set daily_credits_balance = daily_amount,
        daily_credits_refreshed_at = today,
        updated_at = now()
    where user_id = uid
    returning daily_credits_balance, daily_credits_refreshed_at into daily_balance, daily_refreshed_at;

    insert into public.credit_ledger (
      user_id,
      entry_type,
      source,
      amount,
      metadata
    ) values (
      uid,
      'grant',
      'daily_refresh',
      daily_amount,
      jsonb_build_object('bucket', 'daily', 'reason', 'daily_refresh')
    );
  end if;

  if current_balance + daily_balance < p_amount then
    raise exception 'insufficient_credits';
  end if;

  daily_used := least(daily_balance, p_amount);
  base_used := p_amount - daily_used;

  update public.billing_accounts
  set credits_balance = credits_balance - base_used,
      daily_credits_balance = daily_credits_balance - daily_used,
      updated_at = now()
  where user_id = uid
  returning credits_balance, daily_credits_balance into new_balance, new_daily_balance;

  chat_id_val := nullif(p_metadata->>'chat_id', '')::uuid;
  source_val := nullif(p_metadata->>'source', '');
  provider_val := nullif(p_metadata->>'provider', '');
  model_val := nullif(p_metadata->>'model', '');
  input_tokens_val := (p_metadata->>'input_tokens')::integer;
  output_tokens_val := (p_metadata->>'output_tokens')::integer;
  cached_tokens_val := (p_metadata->>'cached_tokens')::integer;

  usage_metadata := coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
    'daily_credits_used', daily_used,
    'base_credits_used', base_used,
    'daily_credits_remaining', new_daily_balance,
    'credits_balance_remaining', new_balance
  );

  insert into public.credit_ledger (
    user_id,
    entry_type,
    source,
    amount,
    chat_id,
    run_id,
    provider,
    model,
    input_tokens,
    output_tokens,
    cached_tokens,
    metadata
  ) values (
    uid,
    'usage',
    source_val,
    -p_amount,
    chat_id_val,
    p_run_id,
    provider_val,
    model_val,
    input_tokens_val,
    output_tokens_val,
    cached_tokens_val,
    usage_metadata
  );

  return new_balance;
end;
$$;

grant execute on function public.consume_credits(uuid, bigint, jsonb) to authenticated;

create or replace function public.consume_credits_for_user(
  p_user_id uuid,
  p_run_id uuid,
  p_amount bigint,
  p_metadata jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  current_balance bigint;
  daily_balance bigint;
  new_balance bigint;
  new_daily_balance bigint;
  daily_refreshed_at date;
  today date := timezone('utc', now())::date;
  daily_amount bigint := 500;
  daily_used bigint;
  base_used bigint;
  chat_id_val uuid;
  source_val text;
  provider_val text;
  model_val text;
  input_tokens_val integer;
  output_tokens_val integer;
  cached_tokens_val integer;
  usage_metadata jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_user_id is null then
    raise exception 'user_id required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid amount';
  end if;

  insert into public.billing_accounts (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select credits_balance, daily_credits_balance, daily_credits_refreshed_at
    into current_balance, daily_balance, daily_refreshed_at
  from public.billing_accounts
  where user_id = p_user_id
  for update;

  current_balance := coalesce(current_balance, 0);
  daily_balance := coalesce(daily_balance, 0);

  if daily_refreshed_at is null or daily_refreshed_at < today then
    if daily_balance > 0 and daily_refreshed_at is not null then
      insert into public.credit_ledger (
        user_id,
        entry_type,
        source,
        amount,
        metadata
      ) values (
        p_user_id,
        'expire',
        'daily_refresh',
        -daily_balance,
        jsonb_build_object('bucket', 'daily', 'reason', 'daily_refresh')
      );
    end if;

    update public.billing_accounts
    set daily_credits_balance = daily_amount,
        daily_credits_refreshed_at = today,
        updated_at = now()
    where user_id = p_user_id
    returning daily_credits_balance, daily_credits_refreshed_at into daily_balance, daily_refreshed_at;

    insert into public.credit_ledger (
      user_id,
      entry_type,
      source,
      amount,
      metadata
    ) values (
      p_user_id,
      'grant',
      'daily_refresh',
      daily_amount,
      jsonb_build_object('bucket', 'daily', 'reason', 'daily_refresh')
    );
  end if;

  if current_balance + daily_balance < p_amount then
    raise exception 'insufficient_credits';
  end if;

  daily_used := least(daily_balance, p_amount);
  base_used := p_amount - daily_used;

  update public.billing_accounts
  set credits_balance = credits_balance - base_used,
      daily_credits_balance = daily_credits_balance - daily_used,
      updated_at = now()
  where user_id = p_user_id
  returning credits_balance, daily_credits_balance into new_balance, new_daily_balance;

  chat_id_val := nullif(p_metadata->>'chat_id', '')::uuid;
  source_val := nullif(p_metadata->>'source', '');
  provider_val := nullif(p_metadata->>'provider', '');
  model_val := nullif(p_metadata->>'model', '');
  input_tokens_val := (p_metadata->>'input_tokens')::integer;
  output_tokens_val := (p_metadata->>'output_tokens')::integer;
  cached_tokens_val := (p_metadata->>'cached_tokens')::integer;

  usage_metadata := coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
    'daily_credits_used', daily_used,
    'base_credits_used', base_used,
    'daily_credits_remaining', new_daily_balance,
    'credits_balance_remaining', new_balance
  );

  insert into public.credit_ledger (
    user_id,
    entry_type,
    source,
    amount,
    chat_id,
    run_id,
    provider,
    model,
    input_tokens,
    output_tokens,
    cached_tokens,
    metadata
  ) values (
    p_user_id,
    'usage',
    source_val,
    -p_amount,
    chat_id_val,
    p_run_id,
    provider_val,
    model_val,
    input_tokens_val,
    output_tokens_val,
    cached_tokens_val,
    usage_metadata
  );

  return new_balance;
end;
$$;

grant execute on function public.consume_credits_for_user(uuid, uuid, bigint, jsonb) to service_role;

create or replace function public.bill_e2b_session_minutes(
  p_session_id uuid,
  p_user_id uuid,
  p_chat_id uuid,
  p_credits_per_minute integer,
  p_started_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  meter_row record;
  started_at_val timestamptz;
  billed_minutes_val integer;
  target_minutes integer;
  delta_minutes integer;
  now_ts timestamptz := now();
  charge_credits bigint;
  billed_through_at_val timestamptz;
  metadata jsonb;
  current_balance bigint;
  daily_balance bigint;
  daily_refreshed_at date;
  today date := timezone('utc', now())::date;
  daily_amount bigint := 500;
  available_total bigint;
  billable_minutes integer;
  billable_credits bigint;
  new_billed_minutes integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_session_id is null then
    raise exception 'session_id required';
  end if;
  if p_user_id is null then
    raise exception 'user_id required';
  end if;
  if p_chat_id is null then
    raise exception 'chat_id required';
  end if;
  if p_credits_per_minute is null or p_credits_per_minute <= 0 then
    raise exception 'invalid rate';
  end if;

  insert into public.e2b_session_meters (
    session_id,
    user_id,
    chat_id,
    started_at,
    billed_minutes,
    billed_through_at
  ) values (
    p_session_id,
    p_user_id,
    p_chat_id,
    coalesce(p_started_at, now_ts),
    0,
    coalesce(p_started_at, now_ts)
  ) on conflict (session_id) do nothing;

  select * into meter_row
  from public.e2b_session_meters
  where session_id = p_session_id
  for update;

  if meter_row.user_id is not null and meter_row.user_id <> p_user_id then
    raise exception 'user mismatch';
  end if;
  if meter_row.chat_id is not null and meter_row.chat_id <> p_chat_id then
    raise exception 'chat mismatch';
  end if;

  started_at_val := meter_row.started_at;
  billed_minutes_val := coalesce(meter_row.billed_minutes, 0);

  target_minutes := ceil(extract(epoch from (now_ts - started_at_val)) / 60.0);
  if target_minutes < 0 then
    target_minutes := 0;
  end if;

  delta_minutes := target_minutes - billed_minutes_val;
  if delta_minutes <= 0 then
    return jsonb_build_object(
      'billed_minutes_total', billed_minutes_val,
      'delta_minutes', 0,
      'charged_credits', 0
    );
  end if;

  charge_credits := delta_minutes * p_credits_per_minute;

  -- Best-effort / partial billing:
  -- If the user can't cover the full delta, bill as many whole minutes as possible
  -- so we still deduct something instead of charging 0.
  insert into public.billing_accounts (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select credits_balance, daily_credits_balance, daily_credits_refreshed_at
    into current_balance, daily_balance, daily_refreshed_at
  from public.billing_accounts
  where user_id = p_user_id
  for update;

  current_balance := coalesce(current_balance, 0);
  daily_balance := coalesce(daily_balance, 0);

  if daily_refreshed_at is null or daily_refreshed_at < today then
    if daily_balance > 0 and daily_refreshed_at is not null then
      insert into public.credit_ledger (
        user_id,
        entry_type,
        source,
        amount,
        metadata
      ) values (
        p_user_id,
        'expire',
        'daily_refresh',
        -daily_balance,
        jsonb_build_object('bucket', 'daily', 'reason', 'daily_refresh')
      );
    end if;

    update public.billing_accounts
    set daily_credits_balance = daily_amount,
        daily_credits_refreshed_at = today,
        updated_at = now()
    where user_id = p_user_id
    returning daily_credits_balance, daily_credits_refreshed_at into daily_balance, daily_refreshed_at;

    insert into public.credit_ledger (
      user_id,
      entry_type,
      source,
      amount,
      metadata
    ) values (
      p_user_id,
      'grant',
      'daily_refresh',
      daily_amount,
      jsonb_build_object('bucket', 'daily', 'reason', 'daily_refresh')
    );
  end if;

  available_total := current_balance + daily_balance;
  if available_total <= 0 then
    return jsonb_build_object(
      'blocked', 'insufficient_credits',
      'billed_minutes_total', billed_minutes_val,
      'delta_minutes', delta_minutes,
      'charged_credits', 0
    );
  end if;

  billable_minutes := least(delta_minutes, floor((available_total::numeric) / (p_credits_per_minute::numeric))::integer);
  if billable_minutes <= 0 then
    return jsonb_build_object(
      'blocked', 'insufficient_credits',
      'billed_minutes_total', billed_minutes_val,
      'delta_minutes', delta_minutes,
      'charged_credits', 0
    );
  end if;

  billable_credits := billable_minutes * p_credits_per_minute;
  new_billed_minutes := billed_minutes_val + billable_minutes;

  metadata := jsonb_build_object(
    'chat_id', p_chat_id,
    'source', 'e2b_sandbox',
    'provider', 'e2b',
    'model', 'sandbox',
    'e2b_session_id', p_session_id,
    'started_at', started_at_val,
    'billed_minutes_delta', billable_minutes,
    'billed_minutes_total', new_billed_minutes,
    'billed_minutes_target', target_minutes,
    'billed_minutes_delta_requested', delta_minutes,
    'credits_per_minute', p_credits_per_minute,
    'charged_credits', billable_credits,
    'requested_charge_credits', charge_credits,
    'available_credits_total', available_total,
    'blocked_insufficient_credits', (billable_minutes < delta_minutes),
    'billed_at', now_ts
  );

  perform public.consume_credits_for_user(p_user_id, null, billable_credits, metadata);

  billed_through_at_val := started_at_val + (new_billed_minutes * interval '1 minute');

  update public.e2b_session_meters
  set billed_minutes = new_billed_minutes,
      billed_through_at = billed_through_at_val
  where session_id = p_session_id;

  if billable_minutes < delta_minutes then
    return jsonb_build_object(
      'blocked', 'insufficient_credits',
      'billed_minutes_total', new_billed_minutes,
      'delta_minutes', billable_minutes,
      'charged_credits', billable_credits
    );
  end if;

  return jsonb_build_object(
    'billed_minutes_total', new_billed_minutes,
    'delta_minutes', billable_minutes,
    'charged_credits', billable_credits
  );
end;
$$;

grant execute on function public.bill_e2b_session_minutes(uuid, uuid, uuid, integer, timestamptz) to service_role;

create or replace function public.grant_credits(
  p_user_id uuid,
  p_amount bigint,
  p_source text,
  p_metadata jsonb default '{}'::jsonb,
  p_stripe_event_id text default null,
  p_stripe_invoice_id text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  current_balance bigint;
  new_balance bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_user_id is null then
    raise exception 'user_id required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid amount';
  end if;

  insert into public.billing_accounts (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select credits_balance into current_balance
  from public.billing_accounts
  where user_id = p_user_id
  for update;

  update public.billing_accounts
  set credits_balance = credits_balance + p_amount,
      updated_at = now()
  where user_id = p_user_id
  returning credits_balance into new_balance;

  insert into public.credit_ledger (
    user_id,
    entry_type,
    source,
    amount,
    stripe_event_id,
    stripe_invoice_id,
    metadata
  ) values (
    p_user_id,
    'grant',
    p_source,
    p_amount,
    p_stripe_event_id,
    p_stripe_invoice_id,
    p_metadata
  );

  return new_balance;
end;
$$;

grant execute on function public.grant_credits(uuid, bigint, text, jsonb, text, text) to service_role;

-- ==========================================
-- PERFORMANCE INDEXES
-- ==========================================
CREATE INDEX IF NOT EXISTS idx_chats_user_id_created ON chats (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_chat_id_created ON messages (chat_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_chat_status ON agent_runs (chat_id, status);
CREATE INDEX IF NOT EXISTS idx_user_mcp_servers_user ON user_mcp_servers (user_id);

-- Realtime subscription disabled: no client code subscribes to these tables,
-- and the publication creates unnecessary WAL overhead on every write.
-- To re-enable, uncomment the block below.
-- do $$ begin
--   if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'messages') then
--     alter publication supabase_realtime add table messages;
--   end if;
--   if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'agent_runs') then
--     alter publication supabase_realtime add table agent_runs;
--   end if;
-- end $$;

-- ==========================================
-- NEW PROJECT / AGENT SCHEMA
-- ==========================================

-- Projects table
CREATE TABLE if not exists public.projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  mode VARCHAR(20) NOT NULL CHECK (mode IN ('own_data', 'autonomous')),
  status VARCHAR(20) DEFAULT 'created' CHECK (status IN ('created', 'uploading', 'analyzing', 'training', 'complete', 'failed')),
  current_step INTEGER DEFAULT 1,
  context JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own projects" ON public.projects;
CREATE POLICY "Users can view own projects" ON public.projects FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can create own projects" ON public.projects;
CREATE POLICY "Users can create own projects" ON public.projects FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own projects" ON public.projects;
CREATE POLICY "Users can update own projects" ON public.projects FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own projects" ON public.projects;
CREATE POLICY "Users can delete own projects" ON public.projects FOR DELETE USING (auth.uid() = user_id);

-- Uploaded Files table
CREATE TABLE if not exists public.uploaded_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL,
  filename VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  size_bytes BIGINT NOT NULL,
  mime_type VARCHAR(100),
  format VARCHAR(20) CHECK (format IN ('csv', 'json', 'jsonl', 'parquet')),
  storage_path TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'uploading' CHECK (status IN ('uploading', 'processing', 'ready', 'error')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.uploaded_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own files" ON public.uploaded_files;
CREATE POLICY "Users can view own files" ON public.uploaded_files FOR SELECT USING (auth.uid() = (SELECT user_id FROM public.projects WHERE id = project_id));
DROP POLICY IF EXISTS "Users can create own files" ON public.uploaded_files;
CREATE POLICY "Users can create own files" ON public.uploaded_files FOR INSERT WITH CHECK (auth.uid() = (SELECT user_id FROM public.projects WHERE id = project_id));
DROP POLICY IF EXISTS "Users can update own files" ON public.uploaded_files;
CREATE POLICY "Users can update own files" ON public.uploaded_files FOR UPDATE USING (auth.uid() = (SELECT user_id FROM public.projects WHERE id = project_id));

-- EDA Results table
CREATE TABLE if not exists public.eda_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL UNIQUE,
  schema_info JSONB NOT NULL DEFAULT '[]',
  statistics JSONB NOT NULL DEFAULT '{}',
  quality_score INTEGER CHECK (quality_score >= 0 AND quality_score <= 100),
  cleaning_actions JSONB DEFAULT '[]',
  anomalies JSONB DEFAULT '[]',
  recommendations JSONB DEFAULT '[]',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.eda_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own EDA results" ON public.eda_results;
CREATE POLICY "Users can view own EDA results" ON public.eda_results FOR SELECT USING (auth.uid() = (SELECT user_id FROM public.projects WHERE id = project_id));
DROP POLICY IF EXISTS "Users can manage own EDA results" ON public.eda_results;
CREATE POLICY "Users can manage own EDA results" ON public.eda_results FOR ALL USING (auth.uid() = (SELECT user_id FROM public.projects WHERE id = project_id));

-- Training Goals table
CREATE TABLE if not exists public.training_goals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL UNIQUE,
  conversation_history JSONB DEFAULT '[]',
  extracted_intent JSONB,
  user_preferences JSONB,
  recommendation JSONB,
  research_findings JSONB DEFAULT '[]',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.training_goals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own training goals" ON public.training_goals;
CREATE POLICY "Users can manage own training goals" ON public.training_goals FOR ALL USING (auth.uid() = (SELECT user_id FROM public.projects WHERE id = project_id));

-- Training Jobs table
CREATE TABLE if not exists public.training_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL,
  provider VARCHAR(50) NOT NULL,
  gpu_type VARCHAR(50) NOT NULL,
  gpu_count INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(20) DEFAULT 'queued' CHECK (status IN ('queued', 'provisioning', 'initializing', 'loading', 'training', 'checkpointing', 'evaluating', 'packaging', 'complete', 'failed', 'retrying', 'cancelled')),
  training_config JSONB NOT NULL,
  generated_script JSONB,
  metrics JSONB DEFAULT '{}',
  cost_estimated DECIMAL(10,2),
  cost_actual DECIMAL(10,2),
  error_message TEXT,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.training_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own training jobs" ON public.training_jobs;
CREATE POLICY "Users can manage own training jobs" ON public.training_jobs FOR ALL USING (auth.uid() = (SELECT user_id FROM public.projects WHERE id = project_id));

-- Training Checkpoints table
CREATE TABLE if not exists public.training_checkpoints (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id UUID REFERENCES public.training_jobs(id) ON DELETE CASCADE NOT NULL,
  epoch INTEGER NOT NULL,
  step INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  metrics JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.training_checkpoints ENABLE ROW LEVEL SECURITY;

-- Model Artifacts table
CREATE TABLE if not exists public.model_artifacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id UUID REFERENCES public.training_jobs(id) ON DELETE CASCADE NOT NULL,
  artifact_type VARCHAR(50) NOT NULL CHECK (artifact_type IN ('weights', 'tokenizer', 'config', 'model_card', 'full_model')),
  filename VARCHAR(255) NOT NULL,
  storage_path TEXT NOT NULL,
  size_bytes BIGINT,
  huggingface_repo VARCHAR(255),
  download_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.model_artifacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own artifacts" ON public.model_artifacts;
CREATE POLICY "Users can manage own artifacts" ON public.model_artifacts FOR ALL USING (auth.uid() = (SELECT p.user_id FROM public.projects p JOIN public.training_jobs j ON j.project_id = p.id WHERE j.id = job_id));

-- Research Sources table
CREATE TABLE if not exists public.research_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL,
  name VARCHAR(255) NOT NULL,
  url TEXT NOT NULL,
  source_type VARCHAR(20) CHECK (source_type IN ('api', 'webpage', 'database')),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'scraping', 'complete', 'failed')),
  records_extracted INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.research_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own research sources" ON public.research_sources;
CREATE POLICY "Users can manage own research sources" ON public.research_sources FOR ALL USING (auth.uid() = (SELECT user_id FROM public.projects WHERE id = project_id));

-- Updated at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers
drop trigger if exists update_profiles_updated_at on public.profiles;
CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

drop trigger if exists update_user_integrations_updated_at on public.user_integrations;
CREATE TRIGGER update_user_integrations_updated_at BEFORE UPDATE ON public.user_integrations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

drop trigger if exists update_user_mcp_servers_updated_at on public.user_mcp_servers;
CREATE TRIGGER update_user_mcp_servers_updated_at BEFORE UPDATE ON public.user_mcp_servers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

drop trigger if exists update_integration_repo_connections_updated_at on public.integration_repo_connections;
CREATE TRIGGER update_integration_repo_connections_updated_at BEFORE UPDATE ON public.integration_repo_connections FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

drop trigger if exists update_projects_updated_at on public.projects;
CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

drop trigger if exists update_eda_results_updated_at on public.eda_results;
CREATE TRIGGER update_eda_results_updated_at BEFORE UPDATE ON public.eda_results FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

drop trigger if exists update_training_goals_updated_at on public.training_goals;
CREATE TRIGGER update_training_goals_updated_at BEFORE UPDATE ON public.training_goals FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

drop trigger if exists update_agent_states_updated_at on public.agent_states;
CREATE TRIGGER update_agent_states_updated_at BEFORE UPDATE ON public.agent_states FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

drop trigger if exists update_agent_runs_updated_at on public.agent_runs;
CREATE TRIGGER update_agent_runs_updated_at BEFORE UPDATE ON public.agent_runs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

drop trigger if exists update_billing_accounts_updated_at on public.billing_accounts;
CREATE TRIGGER update_billing_accounts_updated_at BEFORE UPDATE ON public.billing_accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

drop trigger if exists update_billing_customers_updated_at on public.billing_customers;
CREATE TRIGGER update_billing_customers_updated_at BEFORE UPDATE ON public.billing_customers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

drop trigger if exists update_billing_subscriptions_updated_at on public.billing_subscriptions;
CREATE TRIGGER update_billing_subscriptions_updated_at BEFORE UPDATE ON public.billing_subscriptions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

drop trigger if exists update_billing_rates_updated_at on public.billing_rates;
CREATE TRIGGER update_billing_rates_updated_at BEFORE UPDATE ON public.billing_rates FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

drop trigger if exists update_billing_skus_updated_at on public.billing_skus;
CREATE TRIGGER update_billing_skus_updated_at BEFORE UPDATE ON public.billing_skus FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

drop trigger if exists update_e2b_session_meters_updated_at on public.e2b_session_meters;
CREATE TRIGGER update_e2b_session_meters_updated_at BEFORE UPDATE ON public.e2b_session_meters FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

drop trigger if exists update_e2b_training_task_meters_updated_at on public.e2b_training_task_meters;
CREATE TRIGGER update_e2b_training_task_meters_updated_at BEFORE UPDATE ON public.e2b_training_task_meters FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Storage bucket buckets (Must be created via API or Dashboard if SQL fails)
INSERT INTO storage.buckets (id, name, public) VALUES ('uploads', 'uploads', false) ON CONFLICT DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('artifacts', 'artifacts', false) ON CONFLICT DO NOTHING;

-- Storage Policies (idempotent: drop then create)
drop policy if exists "Authenticated users can upload files" on storage.objects;
create policy "Authenticated users can upload files"
  on storage.objects for insert
  with check ( bucket_id = 'uploads' and auth.role() = 'authenticated' );

drop policy if exists "Users can view their own files" on storage.objects;
create policy "Users can view their own files"
  on storage.objects for select
  using ( bucket_id = 'uploads' and auth.uid() = owner );

drop policy if exists "Authenticated users can upload artifacts" on storage.objects;
create policy "Authenticated users can upload artifacts"
  on storage.objects for insert
  with check ( bucket_id = 'artifacts' and auth.role() = 'authenticated' );

drop policy if exists "Users can view their own artifacts" on storage.objects;
create policy "Users can view their own artifacts"
  on storage.objects for select
  using ( bucket_id = 'artifacts' and auth.uid() = owner );
