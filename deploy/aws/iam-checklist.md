# IAM Checklist (App + Runner)

Use separate roles for task execution and task runtime permissions.

> **Quick setup:** Run `deploy/aws/setup-iam-policies.sh` (requires AWS CLI with
> admin credentials) to apply all policies for the `tuna_finetune` user and
> `tuna-sagemaker-execution-role` in one shot.

## 1) ECS task execution roles

Attach to:
- `APP_TASK_EXECUTION_ROLE_ARN`
- `RUNNER_TASK_EXECUTION_ROLE_ARN`

Permissions:
- Pull images from ECR (`ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`).
- Write logs to CloudWatch (`logs:CreateLogStream`, `logs:PutLogEvents`).
- Read ECS-injected secrets from Secrets Manager / SSM (`secretsmanager:GetSecretValue`, `ssm:GetParameters`, `kms:Decrypt` for referenced KMS keys).

## 2) App task role (`APP_TASK_ROLE_ARN`)

Permissions:
- Bedrock inference:
  - `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`
  - `bedrock:ListFoundationModels`, `bedrock:GetFoundationModel`

## 3) Runner task role / `tuna_finetune` IAM user

The local dev path uses the `tuna_finetune` IAM user with access keys.
In ECS the `tuna-runner-task-role` serves the same purpose.

Permissions (inline policy `TunaFinetuneFullAccess`):

- **SageMaker** — broad training/model/endpoint lifecycle:
  - `sagemaker:Create*`, `Describe*`, `Stop*`, `List*`, `Delete*`, `Search`, `AddTags`, `DeleteTags`
- **S3** — full CRUD on `tuna-training-artifacts`:
  - `s3:GetObject`, `PutObject`, `DeleteObject`, `ListBucket`, `GetBucketLocation`, multipart operations
- **CloudWatch Logs** — create + read + write on `/aws/sagemaker/*`:
  - `logs:CreateLogGroup`, `CreateLogStream`, `PutLogEvents`, `DescribeLogGroups`, `DescribeLogStreams`, `GetLogEvents`, `FilterLogEvents`, `GetLogRecord`, `StartQuery`, `StopQuery`, `GetQueryResults`, `PutRetentionPolicy`
- **ECR** — pull + describe:
  - `ecr:GetAuthorizationToken`, `BatchCheckLayerAvailability`, `GetDownloadUrlForLayer`, `BatchGetImage`, `DescribeRepositories`, `ListImages`, `DescribeImages`
- **IAM** — pass role to SageMaker:
  - `iam:PassRole` on `tuna-*` roles, conditioned to `sagemaker.amazonaws.com`
  - `iam:GetRole`, `iam:ListRoles` on `tuna-*`
- **CloudWatch Metrics** — `PutMetricData`, `GetMetricData`, `GetMetricStatistics`, `ListMetrics`
- **Bedrock** — inference + listing
- **STS** — `sts:GetCallerIdentity`

## 4) SageMaker execution role (`tuna-sagemaker-execution-role`)

Assumed by SageMaker training jobs at runtime (not by ECS tasks).

Permissions (inline policy `TunaSageMakerExecutionFullAccess`):

- **S3** — full CRUD on `tuna-training-artifacts` (read inputs, write model artifacts)
- **CloudWatch Logs** — full create + read + write on `/aws/sagemaker/*`
- **ECR** — full pull access (private training image)
- **CloudWatch Metrics** — `PutMetricData`, `GetMetricData`, `GetMetricStatistics`, `ListMetrics`
- **SageMaker** — `BatchPutMetrics`, `DescribeTrainingJob`, `AddTags`, experiment APIs
- **KMS** — `Decrypt`, `GenerateDataKey` (for encrypted buckets)

Trust policy: `sagemaker.amazonaws.com` can assume this role.

## 5) Validation gates before rollout

- [ ] Execution roles can fetch every configured secret ARN.
- [ ] App task role can invoke Bedrock model(s) in target region.
- [ ] Runner / `tuna_finetune` can create + describe + stop a SageMaker training job.
- [ ] Runner / `tuna_finetune` can read CloudWatch logs under `/aws/sagemaker/*`.
- [ ] `iam:PassRole` works for the intended SageMaker execution role.
- [ ] SageMaker execution role can write logs to CloudWatch.
- [ ] SageMaker execution role can pull from ECR.
- [ ] SageMaker execution role can read/write S3 training bucket.
