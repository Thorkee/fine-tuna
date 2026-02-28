// Core type definitions based on the Tuna product specification
// Context-aware system architecture

// ============= Base Types =============

export type ProjectMode = 'own_data' | 'autonomous';

export type TaskType = 'classification' | 'regression' | 'generation' | 'seq2seq';

export type TrainingMethod = 'full' | 'lora' | 'qlora';

export type DistributedStrategy = 'ddp' | 'fsdp' | 'deepspeed_zero2' | 'deepspeed_zero3';

export type FileFormat = 'csv' | 'json' | 'jsonl' | 'parquet';

export type FileStatus = 'uploading' | 'processing' | 'ready' | 'error';

export type TrainingStatus =
  | 'queued'
  | 'provisioning'
  | 'initializing'
  | 'loading'
  | 'training'
  | 'checkpointing'
  | 'evaluating'
  | 'packaging'
  | 'complete'
  | 'failed'
  | 'retrying';

export type ProviderAvailability = 'available' | 'limited' | 'unavailable';

// ============= Uploaded Files =============

export interface UploadedFile {
  id: string;
  filename: string;
  size: number;
  format: FileFormat;
  status: FileStatus;
  s3Key: string;
  createdAt: Date;
}

// ============= EDA Types =============

export interface ColumnSchema {
  name: string;
  type: string;
  nullable: boolean;
  uniqueValues: number;
  sampleValues: string[];
}

export interface DataStatistics {
  rowCount: number;
  columnCount: number;
  missingValues: Record<string, number>;
  numericalStats: Record<string, {
    min: number;
    max: number;
    mean: number;
    median: number;
    std: number;
  }>;
}

export interface TokenStats {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface Anomaly {
  column: string;
  type: 'outlier' | 'format' | 'encoding' | 'missing';
  description: string;
  severity: 'low' | 'medium' | 'high';
}

export interface CleaningAction {
  type: string;
  description: string;
  affectedRows: number;
  applied: boolean;
}

// ============= Goal & Recommendations =============

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null; // Content can be null for tool calls
  tool_calls?: unknown[];  // OpenAI Tool Calls
  tool_call_id?: string;   // For tool messages
  name?: string;           // For tool messages
  timestamp?: Date;
}

export interface Constraint {
  type: string;
  value: string | number;
  priority: 'required' | 'preferred' | 'optional';
}

export interface ResearchFinding {
  source: string;
  title: string;
  relevance: number;
  summary: string;
  url?: string;
}

export interface ThoughtStep {
  title: string;
  content: string;
  status: 'pending' | 'active' | 'complete';
}

export interface IntentAnalysis {
  taskType: TaskType;
  targetColumn?: string;
  inputColumns?: string[];
  targetMetric: string;
  targetValue: number;
  constraints: Constraint[];
}

export interface ModelRecommendation {
  baseModel: string;
  method: TrainingMethod;
  loraRank?: number;
  loraAlpha?: number;
  estimatedCost: number;
  estimatedTime: string;
  expectedAccuracy: number;
  reasoning: string;
  candidates?: Array<{
    modelId: string;
    benchmarkScore: number;
    benchmarkDomainHits: number;
    benchmarkSignalCount: number;
    freshestBenchmarkDate?: string;
  }>;
  selectionPolicy?: {
    strictness: 'off' | 'prefer' | 'strict';
    benchmarkMaxAgeDays: number;
    preferredBaseModels: string[];
    selectedFromPreferredPool: boolean;
  };
}

// ============= Data Preparation =============

export interface Transformation {
  type: string;
  column: string;
  params: Record<string, unknown>;
}

export interface Augmentation {
  type: string;
  probability: number;
  params: Record<string, unknown>;
}

export interface TokenizationConfig {
  maxLength: number;
  truncation: boolean;
  padding: boolean;
}

// ============= Provider Types =============

export interface ProviderOption {
  provider: string;
  gpuType: string;
  gpuCount: number;
  estimatedHours: number;
  pricePerHour: number;
  totalCost: number;
  availability: ProviderAvailability;
  regions: string[];
  savings?: number;
}

// ============= Training Types =============

export interface TrainingConfig {
  baseModel: string;
  method: TrainingMethod;
  hyperparameters: {
    numEpochs: number;
    batchSize: number;
    learningRate: number;
    warmupRatio: number;
    weightDecay: number;
    gradientAccumulation: number;
  };
  loraConfig?: {
    r: number;
    alpha: number;
    dropout: number;
    targetModules: string[];
  };
  distributedStrategy?: DistributedStrategy;
}

export interface TrainingMetrics {
  epoch: number;
  step: number;
  trainLoss: number;
  valLoss?: number;
  accuracy?: number;
  gpuMemoryUsed: number;
  gpuUtilization: number;
  samplesPerSecond: number;
  estimatedTimeRemaining: string;
}

export interface Checkpoint {
  id: string;
  epoch: number;
  step: number;
  s3Key: string;
  metrics: TrainingMetrics;
  createdAt: Date;
}

// ============= Training Script =============

export interface TrainingScript {
  id: string;
  projectId: string;
  version: number;
  files: {
    trainPy: string;
    requirementsTxt: string;
    dockerfile: string;
    runSh: string;
    evaluatePy: string;
    inferencePy: string;
    configYaml: string;
  };
  baseModel: string;
  method: TrainingMethod;
  estimatedVRAM: number;
  estimatedDuration: string;
  syntaxValid: boolean;
  dryRunPassed: boolean;
  generatedAt: Date;
  generatedBy: 'gpt-52';
}

// ============= Export Types =============

export interface Artifact {
  id: string;
  type: 'weights' | 'tokenizer' | 'config' | 'model_card';
  filename: string;
  s3Key: string;
  sizeBytes: number;
}

export interface DeploymentConfig {
  target: 'huggingface' | 'api' | 'download' | 'gguf';
  huggingfaceRepo?: string;
  quantization?: string;
}

// ============= Autonomous Mode Types =============

export interface ClarificationRound {
  roundNumber: number;
  topic: string;
  agentQuestion: string;
  userResponse: string;
  reasoning: ThoughtStep[];
}

export interface ResearchPlan {
  objective: string;
  dataSources: DataSource[];
  estimatedRecords: number;
  estimatedTime: string;
}

export interface DataSource {
  id: string;
  name: string;
  url: string;
  type: 'api' | 'webpage' | 'database';
  status: 'pending' | 'scraping' | 'complete' | 'failed';
  recordsExtracted: number;
}

export interface CurationPipelineState {
  stage: 'ingest' | 'clean' | 'structure' | 'validate';
  progress: number;
  transformationsApplied: string[];
  qualityScore?: number;
}

export interface HuggingFaceSkillPreferences {
  search_hub?: boolean;
  explore_datasets?: boolean;
  query_dataset?: boolean;
  get_documentation?: boolean;
  run_spaces?: boolean;
  train_model?: boolean;
}

export interface SkillPreferences {
  huggingface?: HuggingFaceSkillPreferences;
}

// ============= Project Context =============
// The unified context object that flows through every service

export interface ProjectContext {
  // Project identity
  projectId: string;
  userId: string;
  mode: ProjectMode;
  createdAt: Date;

  // User profile & preferences (from onboarding/settings)
  userProfile?: {
    fullName?: string | null;
    nickname?: string | null;
    roleTitle?: string | null;
    company?: string | null;
    industry?: string | null;
    experienceLevel?: string | null;
    region?: string | null;
    primaryUseCase?: string | null;
    occupation?: string | null;
    about?: string | null;
    instructions?: string | null;
    goal?: string | null;
  };

  // Skill preferences (from settings > skills)
  skillPreferences?: SkillPreferences;

  // Step 1: Data Context
  dataContext: {
    files: UploadedFile[];
    totalRows: number;
    totalSize: number;
    formats: FileFormat[];
    languages?: string[];
    domain?: string;
  } | null;

  // Step 2: EDA Context
  edaContext: {
    schema: ColumnSchema[];
    statistics: DataStatistics;
    qualityScore: number;
    cleaningActions: CleaningAction[];
    classDistribution?: Record<string, number>;
    tokenDistribution?: TokenStats;
    anomalies: Anomaly[];
    recommendations: string[];
  } | null;

  // Step 3: Goal Context
  goalContext: {
    conversationHistory: Message[];
    extractedIntent: IntentAnalysis;
    userPreferences: {
      budget: { min: number; max: number };
      timeline: string;
      accuracyPriority: 'speed' | 'balanced' | 'accuracy';
      deploymentTarget: string;
    };
    researchFindings: ResearchFinding[];
    recommendation?: ModelRecommendation;
  } | null;

  // Step 4: Preparation Context
  preparationContext: {
    trainSplit: number;
    valSplit: number;
    testSplit: number;
    labelColumn: string;
    featureColumns: string[];
    transformations: Transformation[];
    augmentations: Augmentation[];
    preparedDatasetPath: string;
    tokenizationConfig: TokenizationConfig;
  } | null;

  // Step 5: Provider Context
  providerContext: {
    selectedProvider: string;
    selectedGPU: string;
    gpuCount: number;
    estimatedCost: number;
    estimatedTime: string;
    alternativesConsidered: ProviderOption[];
  } | null;

  // Step 6: Training Context
  trainingContext: {
    generatedScript: TrainingScript;
    trainingConfig: TrainingConfig;
    jobId: string;
    status: TrainingStatus;
    metrics: TrainingMetrics;
    checkpoints: Checkpoint[];
  } | null;

  // Step 7: Export Context
  exportContext: {
    artifacts: Artifact[];
    deploymentConfig: DeploymentConfig;
    huggingfaceRepo?: string;
    downloadUrl?: string;
  } | null;

  // Autonomous Mode Extensions
  autonomousContext?: {
    clarificationRounds: ClarificationRound[];
    researchPlan: ResearchPlan;
    dataSources: DataSource[];
    collectedRecords: number;
    curationPipeline: CurationPipelineState;
  };
}

// ============= API Types =============

export interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}
