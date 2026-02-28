# Phase 2 Runtime Verification (Tuna)

This document is the release gate for the audited runtime phase:
- Bedrock runtime path,
- SageMaker execution path,
- W&B runtime tracking,
- HF-first source-policy enforcement,
- ECS/Fargate deploy readiness + rollback gates.

## Validation Matrix

| Matrix Item | Status | Evidence | Notes |
| :--- | :--- | :--- | :--- |
| Bedrock chat/tool runtime wiring | ✅ pass (code + type checks) | `src/lib/llm/runtime.ts`, `src/lib/aws-bedrock/service.ts`, `src/lib/agent/coordinator.ts`, `src/app/api/chat/stream/route.ts`, `npx tsc --noEmit` | Provider abstraction now routes through `getLlmRuntime()` with Bedrock default. |
| SageMaker training execution path | ✅ pass (code integration) | `e2b-runner-service/sagemaker_executor.py`, `e2b-runner-service/main.py`, `e2b-runner-service/db.py`, `e2b-runner-service/supabase_schema.sql` | Runner now branches to real SageMaker submit/poll/finalize when `backend=sagemaker`. |
| W&B run metadata persistence/surfacing | ✅ pass (code integration) | `e2b-runner-service/wandb_runtime.py`, `e2b-runner-service/main.py`, `src/lib/agent/tools/e2b-runner.ts`, `src/app/components/artifacts/TrainingArtifact.tsx` | Runtime persists/surfaces sanitized `run_id`/`run_url` metadata; failure metadata is also persisted. |
| HF-first enforcement + escalation evidence | ✅ pass (runtime + tests) | `src/lib/agent/source-policy.ts`, `src/lib/agent/tools/dataset-search.ts`, `src/lib/agent/tools/model-search.ts`, `src/lib/agent/tool-runner.ts`, `npm run -s test:source-policy` | Tier telemetry now includes explicit fallback reasons; desktop escalation requires prior-tier evidence. |
| ECS/Fargate deploy assets present | ✅ pass (assets committed) | `deploy/aws/ecs/app-task-definition.template.json`, `deploy/aws/ecs/app-service.template.json`, `e2b-runner-service/deploy/aws/runner-task-definition.template.json`, `e2b-runner-service/deploy/aws/runner-service.template.json` | App + runner templates and shared runbook/checklists are now in-repo. |
| Rollout + rollback runbook gates | ✅ pass (runbook committed) | `deploy/aws/rollout-rollback-runbook.md`, `deploy/aws/iam-checklist.md`, `deploy/aws/env-secrets-mapping.md` | Includes staged deployment order, smoke checks, rollback triggers, and rollback commands. |

## Executed Checks (This Repository Session)

- `npx eslint src/lib/agent/source-policy.ts src/lib/agent/tool-runner.ts src/lib/agent/tools/dataset-search.ts src/lib/agent/tools/model-search.ts src/app/components/ui/GenericArtifactRenderer.tsx src/lib/agent/__tests__/source-policy.test.ts src/app/api/health/route.ts`
- `npx tsc --noEmit`
- `npm run -s test:source-policy`

All checks passed (excluding pre-existing non-blocking warnings in `src/lib/agent/tools/e2b-runner.ts`).

## Staged Rollout / Rollback Checklist

- [ ] Register app and runner task definitions from resolved templates.
- [ ] Deploy runner service first and wait for ECS steady state.
- [ ] Verify runner health (`GET /`) and authenticated config (`GET /config`).
- [ ] Deploy app service and verify app health (`GET /api/health`).
- [ ] Run one smoke Bedrock chat and one `backend=sagemaker` training task.
- [ ] Confirm W&B run link appears in training metadata/artifact.
- [ ] If any gate fails, roll back to previous task definition ARN (document incident evidence).

## Known Limitations / Follow-Ups

- Full Bedrock/SageMaker/W&B live-runtime verification still requires deployed AWS credentials, networking, and quotas.
- Python bytecode compile validation (`python3 -m py_compile`) is blocked in this environment by missing local Xcode license acceptance.
- Recommended follow-up: execute the rollout runbook in a staging AWS account and attach command logs/screenshots to this document.
