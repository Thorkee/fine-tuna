# Tuna AWS Deploy Assets

This folder contains runnable baseline assets for ECS/Fargate deployment and operational rollout gates.

## Files

- `deploy/aws/ecs/app-task-definition.template.json`: ECS task definition template for the Next.js app/API service.
- `deploy/aws/ecs/app-service.template.json`: ECS service template (ALB + private subnets) for the app.
- `deploy/aws/sagemaker-training-image/`: SageMaker training container (Dockerfile + entrypoint). Must be rebuilt and pushed to ECR when `train-entrypoint.py` changes.
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

## SageMaker Training Image

After modifying `deploy/aws/sagemaker-training-image/train-entrypoint.py`, rebuild and push the image:

```bash
cd deploy/aws/sagemaker-training-image

# Build
docker build -t tuna-sagemaker-training:latest .

# Tag for ECR (replace ACCOUNT_ID and REGION)
docker tag tuna-sagemaker-training:latest \
  ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/tuna-sagemaker-training:latest

# Authenticate and push
aws ecr get-login-password --region REGION | \
  docker login --username AWS --password-stdin ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com
docker push ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/tuna-sagemaker-training:latest
```

The runner service references this image via `SAGEMAKER_TRAINING_IMAGE_URI`.
