# IAM Minimum Checklist (App + Runner)

Use separate roles for task execution and task runtime permissions.

## 1) ECS task execution roles

Attach to:
- `APP_TASK_EXECUTION_ROLE_ARN`
- `RUNNER_TASK_EXECUTION_ROLE_ARN`

Minimum permissions:
- Pull images from ECR (`ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`).
- Write logs to CloudWatch (`logs:CreateLogStream`, `logs:PutLogEvents`).
- Read ECS-injected secrets from Secrets Manager / SSM (`secretsmanager:GetSecretValue`, `ssm:GetParameters`, `kms:Decrypt` for referenced KMS keys).

## 2) App task role (`APP_TASK_ROLE_ARN`)

Minimum runtime permissions:
- Bedrock inference:
  - `bedrock:InvokeModel`
  - `bedrock:InvokeModelWithResponseStream`
- Scope resources to the exact model ARNs used by `AWS_BEDROCK_MODEL_ID`.

Avoid granting broad admin permissions to app task roles.

## 3) Runner task role (`RUNNER_TASK_ROLE_ARN`)

Minimum runtime permissions:
- SageMaker job lifecycle:
  - `sagemaker:CreateTrainingJob`
  - `sagemaker:DescribeTrainingJob`
  - `sagemaker:StopTrainingJob`
  - `sagemaker:ListTrainingJobs`
  - `sagemaker:DescribeAlgorithm`
  - `sagemaker:ListTags`
- Pass role for training jobs:
  - `iam:PassRole` scoped to `SAGEMAKER_EXECUTION_ROLE_ARN`
  - Condition: `iam:PassedToService = sagemaker.amazonaws.com`
- S3 access for training input/output prefixes used by runner:
  - `s3:ListBucket` on target buckets
  - `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on approved prefixes
- CloudWatch Logs read (for fetching training container logs on failure):
  - `logs:DescribeLogGroups`, `logs:DescribeLogStreams`, `logs:GetLogEvents`, `logs:FilterLogEvents`
  - Scoped to `arn:aws:logs:*:*:log-group:/aws/sagemaker/TrainingJobs:*`
- ECR pull (if runner needs direct image access):
  - `ecr:GetAuthorizationToken`, `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage`

## 4) SageMaker execution role (`SAGEMAKER_EXECUTION_ROLE_ARN`)

This role is assumed by SageMaker training jobs, not by ECS tasks.

Minimum permissions:
- Read training inputs from approved S3 prefixes.
- Write model artifacts to `SAGEMAKER_OUTPUT_S3_URI`.
- Pull training image from ECR (if using private ECR image).
- CloudWatch logs permissions for training job logs:
  - `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`
  - `logs:DescribeLogGroups`, `logs:DescribeLogStreams`, `logs:GetLogEvents`
  - Scoped to `arn:aws:logs:*:*:log-group:/aws/sagemaker/*`
- CloudWatch metrics (optional):
  - `cloudwatch:PutMetricData` with namespace condition `/aws/sagemaker/TrainingJobs`

## 5) Validation gates before rollout

- [ ] Execution roles can fetch every configured secret ARN.
- [ ] App task role can invoke Bedrock model(s) in target region.
- [ ] Runner task role can create + describe + stop a SageMaker training job.
- [ ] Runner task role can read CloudWatch logs under `/aws/sagemaker/TrainingJobs`.
- [ ] `iam:PassRole` is scoped and works only for the intended SageMaker execution role.
- [ ] SageMaker execution role can write logs to CloudWatch.
- [ ] No wildcard `*` actions/resources remain unless documented and approved.
