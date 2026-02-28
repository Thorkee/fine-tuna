# Env + Secrets Mapping (ECS/Fargate)

This matrix defines where each runtime variable should come from for the app and runner services.

## App service (`tuna-app`)

| Variable | Source | Required | Notes |
| --- | --- | --- | --- |
| `NODE_ENV`, `NEXT_TELEMETRY_DISABLED` | Task env | Yes | `production`, `1` |
| `NEXT_PUBLIC_APP_URL` | Task env | Yes | Public app base URL |
| `NEXT_PUBLIC_SUPABASE_URL` | Task env | Yes | Public Supabase URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Task env | Yes | Public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Secrets Manager/SSM | Yes | Server-only key |
| `POSTGRES_URL` | Secrets Manager/SSM | Yes | DB connection for server/migrations |
| `SUPABASE_STORAGE_URL`, `SUPABASE_STORAGE_REGION` | Task env | Yes | Supabase S3-compatible endpoint |
| `SUPABASE_STORAGE_KEY_ID`, `SUPABASE_STORAGE_SECRET` | Secrets Manager/SSM | Yes | Storage service credentials |
| `TUNA_LLM_PROVIDER` | Task env | Yes | Set to `aws_bedrock` by default |
| `AWS_REGION`, `AWS_BEDROCK_MODEL_ID` | Task env | Yes | Bedrock runtime settings |
| Bedrock auth | Task role IAM | Yes | Prefer IAM role over static AWS keys |
| `EXA_API_KEY` | Secrets Manager/SSM | Yes | Web search/fetch backend |
| `E2B_RUNNER_URL` | Task env | Yes | Internal runner endpoint |
| `E2B_RUNNER_TOKEN` | Secrets Manager/SSM | Yes | Shared token for runner proxy auth |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Secrets Manager/SSM | Optional | Required only if billing enabled |
| `RESEND_API_KEY` | Secrets Manager/SSM | Optional | Required only if email enabled |
| `AZURE_OPENAI_*`, `OPENAI_API_KEY` | Secrets Manager/SSM | Optional | Only if non-Bedrock providers are enabled |

## Runner service (`tuna-runner`)

| Variable | Source | Required | Notes |
| --- | --- | --- | --- |
| `PORT` | Task env | Yes | `8000` |
| `RUNNER_AUTH_TOKEN` | Secrets Manager/SSM | Yes | Mandatory runner API auth token |
| `E2B_API_KEY` | Secrets Manager/SSM | Yes | E2B runtime access |
| `OPENAI_API_KEY` | Secrets Manager/SSM | Yes | Required by current runner training path/tooling |
| `AWS_REGION` | Task env | Yes | SageMaker + logging region |
| `SAGEMAKER_EXECUTION_ROLE_ARN` | Task env | Yes | Role passed to training jobs |
| `SAGEMAKER_TRAINING_IMAGE_URI` | Task env | Yes | SageMaker training image |
| `SAGEMAKER_OUTPUT_S3_URI` | Task env | Yes | SageMaker output prefix |
| `SAGEMAKER_INSTANCE_TYPE` | Task env | Yes | Default training instance |
| `SAGEMAKER_MAX_RUNTIME_SECONDS` | Task env | Yes | Job safety cap |
| `SAGEMAKER_POLL_INTERVAL_SECONDS` | Task env | Yes | Status polling interval |
| `WANDB_API_KEY` | Secrets Manager/SSM | Optional | Required for W&B `online` mode |
| `WANDB_PROJECT`, `WANDB_ENTITY` | Task env | Optional | W&B run metadata |
| `KAGGLE_TOKEN` | Secrets Manager/SSM | Optional | Runner dataset integrations |
| `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Task env | Yes | Supabase connectivity |
| `SUPABASE_SERVICE_ROLE_KEY` | Secrets Manager/SSM | Yes | Runner DB/storage writes |
| `POSTGRES_URL` | Secrets Manager/SSM | Yes | Runner task persistence |
| `SUPABASE_STORAGE_URL`, `SUPABASE_STORAGE_REGION` | Task env | Yes | Artifact storage endpoint |
| `SUPABASE_STORAGE_KEY_ID`, `SUPABASE_STORAGE_SECRET` | Secrets Manager/SSM | Yes | Artifact storage credentials |

## Secret Hygiene Rules

- Never map AWS/W&B/provider secrets to `NEXT_PUBLIC_*`.
- Prefer IAM task roles for AWS API calls (Bedrock/SageMaker) over static key pairs.
- Rotate high-risk tokens (`SUPABASE_SERVICE_ROLE_KEY`, `RUNNER_AUTH_TOKEN`, `WANDB_API_KEY`) on a fixed schedule.
