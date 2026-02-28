-- E2B Runner Service: runner_tasks table
-- Run this in Supabase → SQL Editor (one-time).
--
-- Storage bucket "runner-artifacts": create in Dashboard → Storage → New bucket.
-- Layout:
--   inputs/<task_id>/input.csv    inputs/<task_id>/train.py
--   outputs/<task_id>/model.pkl   outputs/<task_id>/run.log   outputs/<task_id>/metadata.json

create table if not exists public.runner_tasks (
  id uuid default gen_random_uuid() primary key,
  status text not null check (status in ('pending', 'running', 'completed', 'failed')) default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Storage keys (Supabase Storage paths in bucket runner-artifacts)
  input_csv_key text,
  script_key text,
  output_model_key text,
  run_log_key text,
  -- Truncated in DB; full logs in run.log file
  stdout text,
  stderr text,
  error_message text,
  attempts int default 0,
  -- Optional from POST body (upload-by-reference)
  expected_output_name text default 'model.pkl',
  timeout_seconds int,
  requested_backend text default 'e2b',
  execution_backend text,
  backend_job_id text,
  backend_status text,
  output_metadata_key text
);

alter table public.runner_tasks enable row level security;

create policy "Service can manage runner_tasks"
  on public.runner_tasks for all
  using ( true )
  with check ( true );

create or replace function public.set_runner_tasks_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists runner_tasks_updated_at on public.runner_tasks;
create trigger runner_tasks_updated_at
  before update on public.runner_tasks
  for each row execute procedure public.set_runner_tasks_updated_at();
