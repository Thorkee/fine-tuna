# Tuna Console

Tuna is an agentic chat + canvas app for AI workflows. It runs on Next.js, uses Supabase for auth/data/storage, and keeps model/provider credentials server-side.

## Quickstart (minimum)

### 1) Prerequisites
- Node.js 20+
- A Supabase project (Auth + Postgres + Storage)
- Azure OpenAI or another configured LLM provider

### 2) Configure environment
Copy `.env.example` to `.env.local` and set required values.

Minimum required:

```env
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
NEXT_PUBLIC_APP_URL=http://localhost:3000

AZURE_OPENAI_ENDPOINT=...
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_DEPLOYMENT_NAME=...
AZURE_OPENAI_API_VERSION=...

# Optional provider switch: aws_bedrock | azure_openai | openai
TUNA_LLM_PROVIDER=aws_bedrock
```

### 3) Apply database schema
Apply `supabase/schema.sql` in Supabase SQL editor, or run:

```bash
npm run migrate
npm run check-migration
```

### 4) Create required storage buckets
- `uploads`
- `artifacts`
- Optional (runner): `runner-artifacts`

### 5) Install and run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

### 6) Sign in and complete onboarding
- New users are redirected to `/onboarding` until setup is complete.
- Setup edits are available via `/onboarding?edit=1`.

## Security rules (must keep)
- Only `NEXT_PUBLIC_*` variables are safe for client exposure.
- Keep all API keys/tokens server-side (`AZURE_OPENAI_*`, `SUPABASE_SERVICE_ROLE_KEY`, `E2B_RUNNER_TOKEN`, Stripe/Resend keys, etc.).
- Do not expose runner URLs/tokens directly to client code.

## Azure OpenAI and OpenAI calling notes
- Azure OpenAI uses deployment-scoped endpoints and an API version.
- Common Azure shape:
  - `POST https://{endpoint}/openai/deployments/{deployment-id}/completions?api-version={api-version}`
- This app primarily uses chat-style Azure routes through its server adapter; keep endpoint, deployment, and API version consistent with your Azure deployment.

## Auth and onboarding gate
- Runtime gate entrypoint: `src/proxy.ts`
- Gate logic: `src/lib/supabase/middleware.ts`
- Behavior:
  - unauthenticated users -> `/login`
  - authenticated but not onboarded -> `/onboarding`

## Optional runner service
For sandbox/training/desktop features, configure `e2b-runner-service` and set:
- `E2B_RUNNER_URL`
- `E2B_RUNNER_TOKEN`

See `e2b-runner-service/README.md` for runner setup.
