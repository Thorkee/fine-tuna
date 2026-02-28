# Tuna AWS Deploy Assets

This folder contains runnable baseline assets for ECS/Fargate deployment and operational rollout gates.

## Files

- `deploy/aws/ecs/app-task-definition.template.json`: ECS task definition template for the Next.js app/API service.
- `deploy/aws/ecs/app-service.template.json`: ECS service template (ALB + private subnets) for the app.
- `deploy/aws/env-secrets-mapping.md`: required/optional env + secrets mapping matrix for app and runner.
- `deploy/aws/iam-checklist.md`: minimum IAM checklist for execution/task roles.
- `deploy/aws/rollout-rollback-runbook.md`: staged rollout, smoke-test, and rollback runbook.
- `e2b-runner-service/deploy/aws/runner-task-definition.template.json`: ECS task definition template for the runner service.
- `e2b-runner-service/deploy/aws/runner-service.template.json`: ECS service template for the runner service.

## Usage

1. Copy the JSON templates and replace `${...}` placeholders for your environment.
2. Register task definitions via `aws ecs register-task-definition --cli-input-json file://...`.
3. Create/update services with the service templates.
4. Follow `deploy/aws/rollout-rollback-runbook.md` for staged rollout and rollback gates.
