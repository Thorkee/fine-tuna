# E2B Validation Matrix (2026-02-09)

This matrix documents what was validated in code for:
- Composer `+` menu integrations
- GitHub connected-repo edit/publish flow
- Kaggle workflow coverage
- Scaffold visibility/persistence
- E2B session resilience

Live end-to-end calls that require external credentials (GitHub/Kaggle tokens, Supabase auth session, runner deployment) are marked as pending runtime smoke checks.

## Automated checks run

- `npx eslint src/lib/agent/tools/e2b-runner.ts src/lib/agent/coordinator.ts src/lib/agent/skills/orchestrator.ts src/lib/agent/skills/software-engineer.ts src/app/components/ui/FilesDrawer.tsx src/app/api/runner/sessions/[sessionId]/persist/route.ts`
  - Result: pass, warnings only (`appendDesktopEvent`, `markdown`) in `src/lib/agent/tools/e2b-runner.ts`.
- `python -m py_compile sessions.py main.py runner.py` (in `e2b-runner-service`)
  - Result: pass.
- `npx tsc --noEmit`
  - Result: fails due to pre-existing `SourceTier` typing errors in `src/lib/agent/tools/dataset-search.ts` and `src/lib/agent/tools/model-search.ts` (outside this change scope).

## Feature matrix

| Area | Expected behavior | Validation evidence | Status |
|---|---|---|---|
| Composer `+` menu | Show exactly `Upload files`, `Connect to GitHub`, `Connect to HuggingFace` | `src/app/components/ui/ComposerAttachMenu.tsx` defines the three actions; `src/app/[[...chatId]]/page.tsx` renders menu in both landing/chat composers | Pass (code-wired) |
| Integration handoff | Clicking GitHub/HF should open integrations tab with provider focus | `openCredits("integrations", "profile", "...")` in `src/app/[[...chatId]]/page.tsx`; `initialIntegrationProvider` focus logic in `src/app/components/ui/CreditsModal.tsx` | Pass (code-wired) |
| GitHub repo connection | Users can save/list/delete connected repos with base/work branch + publish mode | API routes at `src/app/api/integrations/github/repos/route.ts` and `src/app/api/integrations/github/repos/[connectionId]/route.ts`; DB table `integration_repo_connections` in `supabase/schema.sql` | Pass (code-wired) |
| GitHub publish defaults | Agent should default to branch `tuna` + PR; direct push only when explicitly requested | `github_repo_publish` logic in `src/lib/agent/tools/e2b-runner.ts` (default `pr`, default work branch `tuna`, explicit `confirmDirectPush` guard) | Pass (code-wired) |
| Kaggle integration scope | Token storage + dataset download/upload + competition submit + kernel push | Provider + token support in `src/lib/integrations/tokens.ts` and `src/app/components/ui/CreditsModal.tsx`; runner endpoints in `e2b-runner-service/main.py`; tool bindings in `src/lib/agent/tools/e2b-runner.ts` | Pass (code-wired) |
| Scaffold visibility | Persist full sandbox folder tree into Outputs so generated repos remain visible | Recursive persist API in `src/app/api/runner/sessions/[sessionId]/persist/route.ts`; UI action `Persist current folder` in `src/app/components/ui/FilesDrawer.tsx`; agent tool `sandbox_persist_tree` in `src/lib/agent/tools/e2b-runner.ts` | Pass (code-wired) |
| Session resilience | Recover from missing session and reduce premature expiry | Client recovery wrapper `withSessionRecoveryJson` in `src/lib/agent/tools/e2b-runner.ts`; runner grace/keepalive in `e2b-runner-service/sessions.py`; new env knobs in `e2b-runner-service/env_example.txt` | Pass (code-wired) |
| Multi-instance deployment guidance | Prevent cross-instance session loss | Sticky/single-instance guidance added in `e2b-runner-service/deploy/aws/README.md` and `e2b-runner-service/README.md` | Pass (docs) |

## Pending runtime smoke checks (requires live env)

- Click `+` in landing/chat composer and confirm all three options open expected flows.
- Save a GitHub repo connection in Integrations, run `github_repo_checkout`, edit a file, and run `github_repo_publish`:
  - Verify branch defaults to `tuna`
  - Verify PR is opened in default mode
  - Verify direct push requires explicit confirmation
- Run all four Kaggle tools against a sandbox session with a valid Kaggle token.
- Generate scaffold in sandbox, trigger `sandbox_persist_tree`/`Persist current folder`, and confirm files appear in Outputs and remain accessible after session end.
- Force a stale/invalid session ID and confirm auto-recovery recreates session and retries successfully.
