#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Tuna IAM Policy Setup
#
# Creates customer-managed IAM policies and attaches them to the tuna_finetune
# IAM user and the tuna-sagemaker-execution-role.
#
# Prerequisites:
#   - AWS CLI v2 configured with admin-level credentials
#   - The tuna_finetune IAM user already exists
#   - The tuna-sagemaker-execution-role IAM role already exists
#
# Usage:
#   AWS_DEFAULT_REGION=us-east-1 bash deploy/aws/setup-iam-policies.sh
# ==============================================================================

export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

ACCOUNT_ID="272861537879"
REGION="us-east-1"
IAM_USER="tuna_finetune"
SAGEMAKER_ROLE="tuna-sagemaker-execution-role"
S3_BUCKET="tuna-training-artifacts"

echo "==> Account: ${ACCOUNT_ID}"
echo "==> Region:  ${REGION}"
echo "==> User:    ${IAM_USER}"
echo "==> Role:    ${SAGEMAKER_ROLE}"
echo ""

# Helper: create-or-update a customer-managed policy
upsert_policy() {
  local name="$1"
  local doc="$2"
  local arn="arn:aws:iam::${ACCOUNT_ID}:policy/${name}"

  if aws iam get-policy --policy-arn "${arn}" >/dev/null 2>&1; then
    echo "    Policy ${name} exists, creating new version..." >&2
    local versions
    versions=$(aws iam list-policy-versions --policy-arn "${arn}" \
      --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text)
    local count
    count=$(echo "${versions}" | wc -w)
    if [ "${count}" -ge 4 ]; then
      local oldest
      oldest=$(echo "${versions}" | awk '{print $NF}')
      aws iam delete-policy-version --policy-arn "${arn}" --version-id "${oldest}" || true
    fi
    aws iam create-policy-version \
      --policy-arn "${arn}" \
      --policy-document "${doc}" \
      --set-as-default >/dev/null
  else
    echo "    Creating policy ${name}..." >&2
    aws iam create-policy \
      --policy-name "${name}" \
      --policy-document "${doc}" >/dev/null
  fi
  printf '%s' "${arn}"
}

# --------------------------------------------------------------------------
# 1) Policy for tuna_finetune IAM user — SageMaker + S3 + IAM PassRole
# --------------------------------------------------------------------------
USER_POLICY_1_NAME="TunaFinetune-SageMaker-S3"
USER_POLICY_1_DOC=$(cat <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SageMaker",
      "Effect": "Allow",
      "Action": "sagemaker:*",
      "Resource": "*"
    },
    {
      "Sid": "S3Bucket",
      "Effect": "Allow",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::${S3_BUCKET}",
        "arn:aws:s3:::${S3_BUCKET}/*"
      ]
    },
    {
      "Sid": "PassRole",
      "Effect": "Allow",
      "Action": ["iam:PassRole","iam:GetRole","iam:ListRoles"],
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/tuna-*"
    }
  ]
}
POLICY
)

# --------------------------------------------------------------------------
# 2) Policy for tuna_finetune — CloudWatch + ECR + Bedrock + STS
# --------------------------------------------------------------------------
USER_POLICY_2_NAME="TunaFinetune-Logs-ECR-Bedrock"
USER_POLICY_2_DOC=$(cat <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": "logs:*",
      "Resource": [
        "arn:aws:logs:*:${ACCOUNT_ID}:log-group:/aws/sagemaker/*",
        "arn:aws:logs:*:${ACCOUNT_ID}:log-group:/aws/sagemaker/*:*"
      ]
    },
    {
      "Sid": "ECR",
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:DescribeRepositories",
        "ecr:ListImages"
      ],
      "Resource": "*"
    },
    {
      "Sid": "Bedrock",
      "Effect": "Allow",
      "Action": "bedrock:*",
      "Resource": "*"
    },
    {
      "Sid": "CloudWatchMetrics",
      "Effect": "Allow",
      "Action": ["cloudwatch:PutMetricData","cloudwatch:GetMetricData","cloudwatch:ListMetrics"],
      "Resource": "*"
    },
    {
      "Sid": "STS",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    }
  ]
}
POLICY
)

# --------------------------------------------------------------------------
# 3) Policy for tuna-sagemaker-execution-role
# --------------------------------------------------------------------------
ROLE_POLICY_NAME="TunaSageMaker-Execution"
ROLE_POLICY_DOC=$(cat <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3",
      "Effect": "Allow",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::${S3_BUCKET}",
        "arn:aws:s3:::${S3_BUCKET}/*"
      ]
    },
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": "logs:*",
      "Resource": [
        "arn:aws:logs:*:${ACCOUNT_ID}:log-group:/aws/sagemaker/*",
        "arn:aws:logs:*:${ACCOUNT_ID}:log-group:/aws/sagemaker/*:*"
      ]
    },
    {
      "Sid": "ECR",
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage"
      ],
      "Resource": "*"
    },
    {
      "Sid": "MetricsAndSageMaker",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:PutMetricData",
        "sagemaker:BatchPutMetrics",
        "sagemaker:DescribeTrainingJob",
        "sagemaker:AddTags"
      ],
      "Resource": "*"
    },
    {
      "Sid": "KMS",
      "Effect": "Allow",
      "Action": ["kms:Decrypt","kms:GenerateDataKey"],
      "Resource": "*"
    }
  ]
}
POLICY
)

# --------------------------------------------------------------------------
# Apply policies
# --------------------------------------------------------------------------

echo "==> Setting up user policies for '${IAM_USER}'..."
# Remove old inline policy if it exists
aws iam delete-user-policy --user-name "${IAM_USER}" --policy-name "TunaFinetuneFullAccess" 2>/dev/null || true

P1_ARN=$(upsert_policy "${USER_POLICY_1_NAME}" "${USER_POLICY_1_DOC}")
echo "    Attaching ${USER_POLICY_1_NAME} to user..."
aws iam attach-user-policy --user-name "${IAM_USER}" --policy-arn "${P1_ARN}"

P2_ARN=$(upsert_policy "${USER_POLICY_2_NAME}" "${USER_POLICY_2_DOC}")
echo "    Attaching ${USER_POLICY_2_NAME} to user..."
aws iam attach-user-policy --user-name "${IAM_USER}" --policy-arn "${P2_ARN}"
echo "    User policies done."
echo ""

echo "==> Setting up role policies for '${SAGEMAKER_ROLE}'..."
# Remove old inline policy if it exists
aws iam delete-role-policy --role-name "${SAGEMAKER_ROLE}" --policy-name "TunaSageMakerExecutionFullAccess" 2>/dev/null || true

P3_ARN=$(upsert_policy "${ROLE_POLICY_NAME}" "${ROLE_POLICY_DOC}")
echo "    Attaching ${ROLE_POLICY_NAME} to role..."
aws iam attach-role-policy --role-name "${SAGEMAKER_ROLE}" --policy-arn "${P3_ARN}"
echo "    Role policies done."
echo ""

# --------------------------------------------------------------------------
# Trust policy on the SageMaker role
# --------------------------------------------------------------------------
TRUST_POLICY=$(cat <<TRUST
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "sagemaker.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
TRUST
)

echo "==> Updating trust policy on role '${SAGEMAKER_ROLE}'..."
aws iam update-assume-role-policy \
  --role-name "${SAGEMAKER_ROLE}" \
  --policy-document "${TRUST_POLICY}"
echo "    Done."
echo ""

# --------------------------------------------------------------------------
# Verification
# --------------------------------------------------------------------------
echo "==> Verification: user attached policies"
aws iam list-attached-user-policies --user-name "${IAM_USER}" --output table
echo ""
echo "==> Verification: role attached policies"
aws iam list-attached-role-policies --role-name "${SAGEMAKER_ROLE}" --output table
echo ""
echo "==> Verification: role trust policy"
aws iam get-role --role-name "${SAGEMAKER_ROLE}" --query 'Role.AssumeRolePolicyDocument' --output json
echo ""

echo "============================================"
echo " IAM setup complete."
echo ""
echo " ${IAM_USER} now has:"
echo "   - sagemaker:*  (all SageMaker actions)"
echo "   - s3:*  on ${S3_BUCKET}"
echo "   - logs:*  on /aws/sagemaker/*"
echo "   - ecr:  pull + describe"
echo "   - bedrock:*  (inference + listing)"
echo "   - iam:PassRole on tuna-* roles"
echo "   - cloudwatch metrics + sts:GetCallerIdentity"
echo ""
echo " ${SAGEMAKER_ROLE} now has:"
echo "   - s3:*  on ${S3_BUCKET}"
echo "   - logs:*  on /aws/sagemaker/*"
echo "   - ecr:  pull access"
echo "   - cloudwatch + sagemaker metrics"
echo "   - kms:Decrypt/GenerateDataKey"
echo "   - Trust: sagemaker.amazonaws.com"
echo "============================================"
