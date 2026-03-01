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

## Runner Service (ECS/Fargate)

After modifying `e2b-runner-service/` code (runner.py, sagemaker_executor.py, etc.), rebuild and deploy:

```bash
cd e2b-runner-service

# Authenticate Docker to ECR (replace ACCOUNT_ID and REGION)
aws ecr get-login-password --region REGION | \
  docker login --username AWS --password-stdin ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com

# Build for linux/amd64 (required for Fargate)
docker build --platform linux/amd64 -t tuna-runner:latest .

# Tag and push
docker tag tuna-runner:latest \
  ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/tuna-runner:latest
docker push ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/tuna-runner:latest

# Force a rolling deployment on ECS
aws ecs update-service \
  --cluster CLUSTER_NAME \
  --service tuna-runner \
  --force-new-deployment \
  --region REGION
```

After deployment, the runner task's public IP can be found via:

```bash
# Get task ARN
TASK_ARN=$(aws ecs list-tasks --cluster CLUSTER_NAME --service-name tuna-runner --region REGION --query 'taskArns[0]' --output text)

# Get ENI ID
ENI_ID=$(aws ecs describe-tasks --cluster CLUSTER_NAME --tasks $TASK_ARN --region REGION \
  --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value' --output text)

# Get public IP
aws ec2 describe-network-interfaces --network-interface-ids $ENI_ID --region REGION \
  --query 'NetworkInterfaces[0].Association.PublicIp' --output text
```

Update `E2B_RUNNER_URL` in the app's `.env.local` to `http://<public-ip>:8000`.

Health check: `GET http://<public-ip>:8000/` (no auth required).
