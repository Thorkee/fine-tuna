# ECS Rollout / Rollback Runbook

This runbook is the deployment gate for `tuna-app` and `tuna-runner`.

## Preflight Checklist

- [ ] Images pushed to ECR (`APP_IMAGE_URI`, `RUNNER_IMAGE_URI`).
- [ ] All `${...}` placeholders in task/service templates are resolved.
- [ ] Required secrets exist and are readable by execution roles.
- [ ] IAM checklist in `deploy/aws/iam-checklist.md` is satisfied.
- [ ] ALB target groups and HTTPS listeners are provisioned.

## 1) Register task definitions

```bash
aws ecs register-task-definition --cli-input-json file://deploy/aws/ecs/app-task-definition.resolved.json
aws ecs register-task-definition --cli-input-json file://e2b-runner-service/deploy/aws/runner-task-definition.resolved.json
```

Record the new task definition ARNs for both services.

## 2) Deploy runner first (safer dependency order)

```bash
aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service tuna-runner \
  --task-definition "$RUNNER_TASK_DEF_ARN" \
  --force-new-deployment
```

Wait for steady state:

```bash
aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services tuna-runner
```

Smoke checks:
- `curl -fsS https://<runner-host>/` returns service descriptor JSON.
- `curl -fsS -H "Authorization: Bearer $E2B_RUNNER_TOKEN" https://<runner-host>/config` succeeds.

## 3) Deploy app

```bash
aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service tuna-app \
  --task-definition "$APP_TASK_DEF_ARN" \
  --force-new-deployment
```

Wait for steady state:

```bash
aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services tuna-app
```

Smoke checks:
- `curl -fsS https://<app-host>/api/health` returns `{"ok":true,...}`.
- Open app, run one Bedrock chat, and confirm tool call path still works.
- Submit one `training_submit` with `backend: "sagemaker"` and verify status transitions.

## 4) Staged rollout gates

Promote only if all gates pass:
- [ ] No `5xx` spike in ALB metrics.
- [ ] ECS task restarts remain within expected baseline.
- [ ] Runner can complete one end-to-end training flow (submit -> status -> finalize).
- [ ] W&B links persist for completed run metadata.

## 5) Rollback

Rollback triggers:
- sustained health check failures,
- regression in chat/tool runtime,
- runner failing to process training tasks.

Rollback command pattern:

```bash
aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service <tuna-app|tuna-runner> \
  --task-definition "<PREVIOUS_TASK_DEF_ARN>" \
  --force-new-deployment
```

Post-rollback checks:
- `aws ecs wait services-stable ...`
- Re-run smoke checks for both services.
- Capture incident notes: failed task definition ARN, timestamp, and top error signatures.
