import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sm from "aws-cdk-lib/aws-secretsmanager";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

const ACCOUNT = "272861537879";
const REGION = "us-east-1";
const DOMAIN = "tuna.ju0.org";

export class TunaInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------------------------------
    // VPC: 2 AZs, public + private subnets, single NAT GW
    // -------------------------------------------------------
    const vpc = new ec2.Vpc(this, "TunaVpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { cidrMask: 24, name: "Public", subnetType: ec2.SubnetType.PUBLIC },
        {
          cidrMask: 24,
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // -------------------------------------------------------
    // ECR Repositories (pre-existing — import by name)
    // -------------------------------------------------------
    const appRepo = ecr.Repository.fromRepositoryName(
      this,
      "TunaAppRepo",
      "tuna-app"
    );

    const runnerRepo = ecr.Repository.fromRepositoryName(
      this,
      "TunaRunnerRepo",
      "tuna-runner"
    );

    const sagemakerRepo = ecr.Repository.fromRepositoryName(
      this,
      "TunaSagemakerRepo",
      "tuna-sagemaker-training"
    );

    // -------------------------------------------------------
    // S3 Bucket for SageMaker training artifacts (pre-existing)
    // -------------------------------------------------------
    const trainingBucket = s3.Bucket.fromBucketName(
      this,
      "TrainingArtifacts",
      "tuna-training-artifacts"
    );

    // -------------------------------------------------------
    // ECS Cluster
    // -------------------------------------------------------
    const cluster = new ecs.Cluster(this, "TunaCluster", {
      clusterName: "tuna",
      vpc,
      containerInsights: true,
      enableFargateCapacityProviders: true,
    });

    // -------------------------------------------------------
    // CloudWatch Log Groups (pre-existing — import by name)
    // -------------------------------------------------------
    const appLogGroup = logs.LogGroup.fromLogGroupName(
      this,
      "AppLogGroup",
      "/ecs/tuna-app"
    );

    const runnerLogGroup = logs.LogGroup.fromLogGroupName(
      this,
      "RunnerLogGroup",
      "/ecs/tuna-runner"
    );

    // -------------------------------------------------------
    // Secrets Manager – one secret per sensitive env var
    // Populated with placeholder values; update after deploy
    // -------------------------------------------------------
    const createSecret = (name: string, description: string) =>
      new sm.Secret(this, name, {
        secretName: `tuna/${name}`,
        description,
        secretStringValue: cdk.SecretValue.unsafePlainText("PLACEHOLDER"),
      });

    const secrets = {
      supabaseServiceRoleKey: createSecret(
        "SUPABASE_SERVICE_ROLE_KEY",
        "Supabase service role key"
      ),
      postgresUrl: createSecret("POSTGRES_URL", "Postgres connection URL"),
      storageKeyId: createSecret(
        "SUPABASE_STORAGE_KEY_ID",
        "Supabase S3 storage key ID"
      ),
      storageSecret: createSecret(
        "SUPABASE_STORAGE_SECRET",
        "Supabase S3 storage secret"
      ),
      exaApiKey: createSecret("EXA_API_KEY", "Exa web search API key"),
      e2bRunnerToken: createSecret(
        "E2B_RUNNER_TOKEN",
        "Shared auth token for app->runner proxy"
      ),
      e2bApiKey: createSecret("E2B_API_KEY", "E2B sandbox API key"),
      runnerAuthToken: createSecret(
        "RUNNER_AUTH_TOKEN",
        "Runner API auth token"
      ),
      openaiApiKey: createSecret(
        "OPENAI_API_KEY",
        "OpenAI API key (runner tooling)"
      ),
      wandbApiKey: createSecret(
        "WANDB_API_KEY",
        "Weights & Biases API key"
      ),
      // Optional — these exist but can stay as PLACEHOLDER if not used
      azureOpenaiApiKey: createSecret(
        "AZURE_OPENAI_API_KEY",
        "Azure OpenAI API key (optional)"
      ),
      azureOpenaiAuthToken: createSecret(
        "AZURE_OPENAI_AUTH_TOKEN",
        "Azure OpenAI auth token (optional)"
      ),
      stripeSecretKey: createSecret(
        "STRIPE_SECRET_KEY",
        "Stripe secret key (optional)"
      ),
      stripeWebhookSecret: createSecret(
        "STRIPE_WEBHOOK_SECRET",
        "Stripe webhook secret (optional)"
      ),
      resendApiKey: createSecret(
        "RESEND_API_KEY",
        "Resend email API key (optional)"
      ),
      kaggleToken: createSecret(
        "KAGGLE_TOKEN",
        "Kaggle API token (optional)"
      ),
    };

    // -------------------------------------------------------
    // ACM Certificate for tuna.ju0.org (DNS validation)
    // -------------------------------------------------------
    const certificate = new acm.Certificate(this, "TunaCert", {
      domainName: DOMAIN,
      validation: acm.CertificateValidation.fromDns(),
    });

    // -------------------------------------------------------
    // ALB + Security Groups
    // -------------------------------------------------------
    const albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc,
      description: "ALB security group",
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP redirect");

    const appSg = new ec2.SecurityGroup(this, "AppSg", {
      vpc,
      description: "App ECS service security group",
    });
    appSg.addIngressRule(albSg, ec2.Port.tcp(3000), "ALB to app");

    const runnerSg = new ec2.SecurityGroup(this, "RunnerSg", {
      vpc,
      description: "Runner ECS service security group",
    });
    runnerSg.addIngressRule(albSg, ec2.Port.tcp(8000), "ALB to runner");
    runnerSg.addIngressRule(appSg, ec2.Port.tcp(8000), "App to runner direct");

    const alb = new elbv2.ApplicationLoadBalancer(this, "TunaAlb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      loadBalancerName: "tuna-alb",
    });

    // HTTPS listener
    const httpsListener = alb.addListener("HttpsListener", {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: "text/plain",
        messageBody: "Not found",
      }),
    });

    // HTTP -> HTTPS redirect
    alb.addListener("HttpRedirect", {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: "HTTPS",
        port: "443",
        permanent: true,
      }),
    });

    // -------------------------------------------------------
    // IAM Roles
    // -------------------------------------------------------

    // Shared execution role (ECR pull + logs + secrets)
    const executionRole = new iam.Role(this, "EcsExecutionRole", {
      roleName: "tuna-ecs-execution-role",
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy"
        ),
      ],
    });

    // Grant execution role read access to all secrets
    Object.values(secrets).forEach((s) => s.grantRead(executionRole));

    // App task role: Bedrock inference (pre-existing — import)
    const appTaskRole = iam.Role.fromRoleName(
      this,
      "AppTaskRole",
      "tuna-app-task-role"
    );

    // Runner task role: SageMaker + S3 + CloudWatch + ECR (pre-existing — import)
    const runnerTaskRole = iam.Role.fromRoleName(
      this,
      "RunnerTaskRole",
      "tuna-runner-task-role"
    );

    // SageMaker execution role (pre-existing — import)
    const sagemakerRole = iam.Role.fromRoleName(
      this,
      "SagemakerExecutionRole",
      "tuna-sagemaker-execution-role"
    );

    // NOTE: Runner task role policies (SageMaker, S3, CloudWatch, ECR, PassRole)
    // are managed on the pre-existing role. No additions needed here.

    // -------------------------------------------------------
    // ECS Task Definitions
    // -------------------------------------------------------

    // --- App Task Definition ---
    const appTaskDef = new ecs.FargateTaskDefinition(this, "AppTaskDef", {
      family: "tuna-app",
      cpu: 1024,
      memoryLimitMiB: 2048,
      executionRole,
      taskRole: appTaskRole,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
      },
    });

    const runnerInternalUrl = `http://tuna-runner.tuna.local:8000`;

    appTaskDef.addContainer("tuna-app", {
      image: ecs.ContainerImage.fromEcrRepository(appRepo, "latest"),
      essential: true,
      portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
      environment: {
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        NEXT_PUBLIC_APP_URL: `https://${DOMAIN}`,
        NEXT_PUBLIC_SUPABASE_URL:
          "https://wdoltlusfalshahesccv.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY:
          "sb_publishable_Rwb0lBFkyCwR7HNwJJKXqg_QaH37ob6",
        SUPABASE_STORAGE_URL:
          "https://wdoltlusfalshahesccv.storage.supabase.co/storage/v1/s3",
        SUPABASE_STORAGE_REGION: "us-east-1",
        TUNA_LLM_PROVIDER: "aws_bedrock",
        AWS_REGION: REGION,
        AWS_BEDROCK_MODEL_ID: "mistral.mistral-large-3-675b-instruct",
        E2B_RUNNER_URL: runnerInternalUrl,
        TUNA_AGENT_SOURCE_POLICY_STRICTNESS: "prefer",
        TUNA_AGENT_SOURCE_POLICY_FALLBACK_GOV: "true",
        TUNA_AGENT_SOURCE_POLICY_FALLBACK_OPEN_WEB: "true",
        TUNA_AGENT_SOURCE_POLICY_MIN_RESULTS_PER_TIER: "3",
        TUNA_AGENT_MAX_CONTEXT_TOKENS: "262144",
        TUNA_AGENT_MAX_INPUT_TOKENS: "254000",
        TUNA_AGENT_MAX_OUTPUT_TOKENS: "8192",
        TUNA_AGENT_CONTEXT_SAFETY_MARGIN_TOKENS: "8192",
        TUNA_AGENT_SUMMARY_MAX_OUTPUT_TOKENS: "4096",
        TUNA_AGENT_SUMMARY_TRIGGER_FRACTION: "0.7",
        TUNA_AGENT_LOG_CONTEXT: "true",
        TUNA_AGENT_MAX_RUN_MS: "3600000",
        TUNA_AGENT_TOOL_MESSAGE_MAX_CHARS: "24000",
        TUNA_AGENT_ASSISTANT_MESSAGE_MAX_CHARS: "32000",
      },
      secrets: {
        SUPABASE_SERVICE_ROLE_KEY: ecs.Secret.fromSecretsManager(
          secrets.supabaseServiceRoleKey
        ),
        POSTGRES_URL: ecs.Secret.fromSecretsManager(secrets.postgresUrl),
        SUPABASE_STORAGE_KEY_ID: ecs.Secret.fromSecretsManager(
          secrets.storageKeyId
        ),
        SUPABASE_STORAGE_SECRET: ecs.Secret.fromSecretsManager(
          secrets.storageSecret
        ),
        EXA_API_KEY: ecs.Secret.fromSecretsManager(secrets.exaApiKey),
        E2B_RUNNER_TOKEN: ecs.Secret.fromSecretsManager(
          secrets.e2bRunnerToken
        ),
        AZURE_OPENAI_API_KEY: ecs.Secret.fromSecretsManager(
          secrets.azureOpenaiApiKey
        ),
        AZURE_OPENAI_AUTH_TOKEN: ecs.Secret.fromSecretsManager(
          secrets.azureOpenaiAuthToken
        ),
        OPENAI_API_KEY: ecs.Secret.fromSecretsManager(secrets.openaiApiKey),
        STRIPE_SECRET_KEY: ecs.Secret.fromSecretsManager(
          secrets.stripeSecretKey
        ),
        STRIPE_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(
          secrets.stripeWebhookSecret
        ),
        RESEND_API_KEY: ecs.Secret.fromSecretsManager(secrets.resendApiKey),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: appLogGroup,
        streamPrefix: "ecs",
      }),
      healthCheck: {
        command: [
          "CMD-SHELL",
          `node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`,
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(45),
      },
    });

    // --- Runner Task Definition ---
    const runnerTaskDef = new ecs.FargateTaskDefinition(
      this,
      "RunnerTaskDef",
      {
        family: "tuna-runner",
        cpu: 1024,
        memoryLimitMiB: 2048,
        executionRole,
        taskRole: runnerTaskRole,
        runtimePlatform: {
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
        },
      }
    );

    runnerTaskDef.addContainer("tuna-runner", {
      image: ecs.ContainerImage.fromEcrRepository(runnerRepo, "latest"),
      essential: true,
      portMappings: [{ containerPort: 8000, protocol: ecs.Protocol.TCP }],
      environment: {
        PORT: "8000",
        AWS_REGION: REGION,
        SAGEMAKER_EXECUTION_ROLE_ARN: sagemakerRole.roleArn,
        SAGEMAKER_TRAINING_IMAGE_URI: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/tuna-sagemaker-training:latest`,
        SAGEMAKER_OUTPUT_S3_URI: "s3://tuna-training-artifacts/runs/",
        SAGEMAKER_INSTANCE_TYPE: "ml.p4d.24xlarge",
        SAGEMAKER_MAX_RUNTIME_SECONDS: "28800",
        SAGEMAKER_POLL_INTERVAL_SECONDS: "15",
        WANDB_PROJECT: "tuna",
        WANDB_ENTITY: "",
        SUPABASE_URL: "https://wdoltlusfalshahesccv.supabase.co",
        NEXT_PUBLIC_SUPABASE_URL:
          "https://wdoltlusfalshahesccv.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY:
          "sb_publishable_Rwb0lBFkyCwR7HNwJJKXqg_QaH37ob6",
        SUPABASE_STORAGE_URL:
          "https://wdoltlusfalshahesccv.storage.supabase.co/storage/v1/s3",
        SUPABASE_STORAGE_REGION: "us-east-1",
      },
      secrets: {
        RUNNER_AUTH_TOKEN: ecs.Secret.fromSecretsManager(
          secrets.runnerAuthToken
        ),
        E2B_API_KEY: ecs.Secret.fromSecretsManager(secrets.e2bApiKey),
        OPENAI_API_KEY: ecs.Secret.fromSecretsManager(secrets.openaiApiKey),
        WANDB_API_KEY: ecs.Secret.fromSecretsManager(secrets.wandbApiKey),
        KAGGLE_TOKEN: ecs.Secret.fromSecretsManager(secrets.kaggleToken),
        SUPABASE_SERVICE_ROLE_KEY: ecs.Secret.fromSecretsManager(
          secrets.supabaseServiceRoleKey
        ),
        POSTGRES_URL: ecs.Secret.fromSecretsManager(secrets.postgresUrl),
        SUPABASE_STORAGE_KEY_ID: ecs.Secret.fromSecretsManager(
          secrets.storageKeyId
        ),
        SUPABASE_STORAGE_SECRET: ecs.Secret.fromSecretsManager(
          secrets.storageSecret
        ),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: runnerLogGroup,
        streamPrefix: "ecs",
      }),
      healthCheck: {
        command: [
          "CMD-SHELL",
          `python3 -c "import sys,urllib.request; r=urllib.request.urlopen('http://127.0.0.1:8000/', timeout=3); sys.exit(0 if 200 <= r.status < 500 else 1)"`,
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(40),
      },
    });

    // -------------------------------------------------------
    // Cloud Map namespace for internal service discovery
    // -------------------------------------------------------
    const namespace = cluster.addDefaultCloudMapNamespace({
      name: "tuna.local",
      vpc,
    });

    // -------------------------------------------------------
    // ECS Services
    // -------------------------------------------------------
    const appService = new ecs.FargateService(this, "AppService", {
      serviceName: "tuna-app",
      cluster,
      taskDefinition: appTaskDef,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [appSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { enable: true, rollback: true },
      enableExecuteCommand: true,
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      cloudMapOptions: {
        name: "tuna-app",
      },
    });

    const runnerService = new ecs.FargateService(this, "RunnerService", {
      serviceName: "tuna-runner",
      cluster,
      taskDefinition: runnerTaskDef,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [runnerSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { enable: true, rollback: true },
      enableExecuteCommand: true,
      healthCheckGracePeriod: cdk.Duration.seconds(45),
      cloudMapOptions: {
        name: "tuna-runner",
      },
    });

    // -------------------------------------------------------
    // ALB Target Groups + Routing
    // -------------------------------------------------------
    const appTargetGroup = httpsListener.addTargets("AppTarget", {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [appService],
      healthCheck: {
        path: "/api/health",
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      priority: 10,
      conditions: [elbv2.ListenerCondition.hostHeaders([DOMAIN])],
    });

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new cdk.CfnOutput(this, "AlbDnsName", {
      value: alb.loadBalancerDnsName,
      description:
        "ALB DNS name — create a CNAME record pointing tuna.ju0.org to this value",
    });

    new cdk.CfnOutput(this, "AppEcrUri", {
      value: appRepo.repositoryUri,
      description: "App ECR repository URI",
    });

    new cdk.CfnOutput(this, "RunnerEcrUri", {
      value: runnerRepo.repositoryUri,
      description: "Runner ECR repository URI",
    });

    new cdk.CfnOutput(this, "SagemakerEcrUri", {
      value: sagemakerRepo.repositoryUri,
      description: "SageMaker training image ECR repository URI",
    });

    new cdk.CfnOutput(this, "SagemakerRoleArn", {
      value: sagemakerRole.roleArn,
      description: "SageMaker execution role ARN",
    });

    new cdk.CfnOutput(this, "CertArn", {
      value: certificate.certificateArn,
      description:
        "ACM certificate ARN — check AWS Console for DNS validation CNAME record",
    });
  }
}
