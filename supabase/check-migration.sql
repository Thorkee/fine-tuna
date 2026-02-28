-- Paste this in Supabase SQL Editor to see migration status (read-only)
-- Expected tables from schema.sql
WITH expected(t) AS (
  SELECT unnest(ARRAY[
    'profiles','user_integrations','integration_repo_connections','chats','messages','agent_states','agent_runs','projects','uploaded_files','eda_results',
    'training_goals','training_jobs','training_checkpoints','model_artifacts','research_sources',
    'chat_shares',
    'billing_accounts','billing_customers','billing_subscriptions','billing_rates','billing_skus','credit_ledger',
    'e2b_session_meters','e2b_training_task_meters'
  ]::text[])
),
found AS (
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
)
SELECT
  e.t AS table_name,
  CASE WHEN f.table_name IS NOT NULL THEN 'ok' ELSE 'MISSING' END AS status
FROM expected e
LEFT JOIN found f ON f.table_name = e.t
ORDER BY status, e.t;

-- Extension
SELECT 'uuid-ossp' AS check_name, CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'uuid-ossp') THEN 'ok' ELSE 'MISSING' END AS status;

-- Realtime (messages in publication)
SELECT 'realtime messages' AS check_name, CASE WHEN EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'messages') THEN 'ok' ELSE 'MISSING' END AS status;

-- Storage buckets
SELECT id AS bucket_id, 'ok' AS status FROM storage.buckets WHERE id IN ('uploads', 'artifacts');
-- If no rows above, buckets are MISSING.
