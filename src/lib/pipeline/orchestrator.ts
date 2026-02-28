// Agentic Pipeline Orchestrator
// Coordinates intent detection, dataset parsing, and supervision layer
// for the complete agentic workflow

import type { ProjectContext, Message, UploadedFile } from '@/types';
import {
    extractWorkloadIntent,
    refineIntent,
    isIntentComplete,
    type WorkloadIntent,
    type IntentExtractionResult,
} from '../azure-openai/intent-detection';
import {
    inferSchema,
    assessDataQuality,
    analyzeMultipleDatasets,
    convertToTrainingFormat,
    applyAutoFixes,
    type ParsedDataset,
    type DataQualityAssessment,
} from '../azure-openai/dataset-parser';
import {
    SupervisionManager,
    createIntentCheckpoint,
    createCostCheckpoint,
    type Checkpoint,
    type SupervisionLevel,
} from '../supervision';
import { getConfiguredLlmProvider } from '../llm/provider';
import { getLlmRuntime } from '../llm/runtime';

// ============= Types =============

export type PipelinePhase =
    | 'idle'
    | 'intent_detection'
    | 'intent_clarification'
    | 'data_upload'
    | 'data_parsing'
    | 'data_quality'
    | 'data_cleaning'
    | 'data_merge'
    | 'model_selection'
    | 'training_config'
    | 'provider_selection'
    | 'cost_approval'
    | 'training'
    | 'evaluation'
    | 'export'
    | 'complete'
    | 'error';

export interface PipelineState {
    phase: PipelinePhase;
    progress: number; // 0-100

    // Intent
    intent: WorkloadIntent | null;
    intentComplete: boolean;

    // Data
    uploadedFiles: UploadedFile[];
    parsedDatasets: ParsedDataset[];
    qualityAssessment: DataQualityAssessment | null;

    // Supervision
    pendingCheckpoints: Checkpoint[];
    resolvedCheckpoints: Checkpoint[];

    // Errors and warnings
    errors: string[];
    warnings: string[];

    // Conversation for clarification
    conversationHistory: Message[];
}

export interface PipelineEvent {
    type: 'phase_change' | 'checkpoint_required' | 'progress_update' | 'error' | 'complete';
    data: Record<string, unknown>;
    timestamp: Date;
}

export type PipelineEventHandler = (event: PipelineEvent) => void;

// ============= Pipeline Orchestrator =============

export class AgenticPipelineOrchestrator {
    private context: ProjectContext;
    private supervision: SupervisionManager;
    private state: PipelineState;
    private eventHandlers: PipelineEventHandler[] = [];

    constructor(
        context: ProjectContext,
        supervisionLevel: SupervisionLevel = 'standard'
    ) {
        this.context = context;
        this.supervision = new SupervisionManager(context.projectId, supervisionLevel);
        this.state = {
            phase: 'idle',
            progress: 0,
            intent: null,
            intentComplete: false,
            uploadedFiles: [],
            parsedDatasets: [],
            qualityAssessment: null,
            pendingCheckpoints: [],
            resolvedCheckpoints: [],
            errors: [],
            warnings: [],
            conversationHistory: [],
        };
    }

    // ============= Event System =============

    on(handler: PipelineEventHandler): () => void {
        this.eventHandlers.push(handler);
        return () => {
            this.eventHandlers = this.eventHandlers.filter(h => h !== handler);
        };
    }

    private emit(event: PipelineEvent): void {
        this.eventHandlers.forEach(h => h(event));
    }

    private setPhase(phase: PipelinePhase, progress?: number): void {
        this.state.phase = phase;
        if (progress !== undefined) this.state.progress = progress;
        this.emit({
            type: 'phase_change',
            data: { phase, progress: this.state.progress },
            timestamp: new Date(),
        });
    }

    // ============= Phase 1: Intent Detection =============

    /**
     * Start intent detection from user message
     */
    async detectIntent(userMessage: string): Promise<IntentExtractionResult> {
        this.setPhase('intent_detection', 10);
        this.state.conversationHistory.push({
            role: 'user',
            content: userMessage,
            timestamp: new Date(),
        });

        try {
            const result = await extractWorkloadIntent(
                userMessage,
                this.context,
                this.state.conversationHistory
            );

            this.state.intent = result.intent;
            this.state.intentComplete = isIntentComplete(result.intent).complete;

            // Create supervision checkpoint if needed
            if (this.state.intentComplete) {
                const checkpointData = createIntentCheckpoint(result.intent);
                const checkpoint = await this.supervision.createCheckpoint(
                    checkpointData.type,
                    checkpointData.proposal,
                    checkpointData.risk
                );

                if (checkpoint.status === 'pending') {
                    this.state.pendingCheckpoints.push(checkpoint);
                    this.emit({
                        type: 'checkpoint_required',
                        data: { checkpoint },
                        timestamp: new Date(),
                    });
                }
            } else {
                // Need clarification
                this.setPhase('intent_clarification', 15);
            }

            this.setPhase(this.state.intentComplete ? 'data_upload' : 'intent_clarification', 20);
            return result;
        } catch (error) {
            this.state.errors.push(`Intent detection failed: ${error}`);
            this.setPhase('error', 0);
            throw error;
        }
    }

    /**
     * Refine intent with user clarification
     */
    async clarifyIntent(userResponse: string): Promise<IntentExtractionResult> {
        if (!this.state.intent) {
            throw new Error('No initial intent to refine');
        }

        this.state.conversationHistory.push({
            role: 'user',
            content: userResponse,
            timestamp: new Date(),
        });

        const result = await refineIntent(
            this.state.intent,
            userResponse,
            this.context
        );

        this.state.intent = result.intent;
        this.state.intentComplete = isIntentComplete(result.intent).complete;

        return result;
    }

    // ============= Phase 2: Dataset Processing =============

    /**
     * Process uploaded files
     */
    async processDatasets(files: UploadedFile[]): Promise<ParsedDataset[]> {
        this.setPhase('data_parsing', 30);
        this.state.uploadedFiles = files;

        const parsedDatasets: ParsedDataset[] = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            this.emit({
                type: 'progress_update',
                data: {
                    message: `Parsing ${file.filename}`,
                    progress: 30 + (i / files.length) * 10,
                },
                timestamp: new Date(),
            });

            // In production, this would read actual file content
            // For now, we simulate with sample data
            const samples = await this.loadFileSamples(file);
            const schema = await inferSchema(samples, file.filename, this.context);
            const quality = assessDataQuality(samples, schema);

            const parsed: ParsedDataset = {
                id: file.id,
                originalName: file.filename,
                format: file.format,
                schema,
                statistics: {
                    rowCount: samples.length,
                    columnCount: schema.columns.length,
                    sizeBytes: file.size,
                    nullPercentage: 100 - quality.completeness,
                    duplicateRows: 0,
                },
                quality,
                samples,
                issues: quality.issues,
                recommendations: quality.recommendedActions,
            };

            parsedDatasets.push(parsed);
        }

        this.state.parsedDatasets = parsedDatasets;
        this.setPhase('data_quality', 40);

        // Analyze multiple datasets if needed
        if (parsedDatasets.length > 1) {
            await this.analyzeDatasetMerge(parsedDatasets);
        }

        return parsedDatasets;
    }

    /**
     * Analyze how to merge multiple datasets
     */
    private async analyzeDatasetMerge(datasets: ParsedDataset[]): Promise<void> {
        this.setPhase('data_merge', 45);

        const analysis = await analyzeMultipleDatasets(datasets, this.context);

        if (!analysis.canMerge) {
            this.state.warnings.push('Datasets may not be compatible for merging');
        }

        // Create merge strategy checkpoint
        if (analysis.conflicts.length > 0 || analysis.strategy) {
            const checkpoint = await this.supervision.createCheckpoint(
                'merge_strategy_approval',
                {
                    summary: `Merge ${datasets.length} datasets using ${analysis.strategy?.type || 'auto'} strategy`,
                    details: {
                        strategy: analysis.strategy,
                        conflicts: analysis.conflicts,
                    },
                    reasoning: analysis.recommendations.join(' '),
                },
                {
                    level: analysis.conflicts.length > 0 ? 'medium' : 'low',
                    factors: analysis.conflicts,
                    reversible: true,
                    estimatedImpact: 'Affects training data structure',
                }
            );

            if (checkpoint.status === 'pending') {
                this.state.pendingCheckpoints.push(checkpoint);
                this.emit({
                    type: 'checkpoint_required',
                    data: { checkpoint },
                    timestamp: new Date(),
                });
            }
        }
    }

    /**
     * Apply data cleaning and transformations
     */
    async cleanData(): Promise<void> {
        this.setPhase('data_cleaning', 50);

        for (const dataset of this.state.parsedDatasets) {
            const autoFixableIssues = dataset.issues.filter(i => i.autoFixable);

            if (autoFixableIssues.length > 0) {
                // Create checkpoint for approval
                const checkpoint = await this.supervision.createCheckpoint(
                    'data_cleaning_approval',
                    {
                        summary: `Apply ${autoFixableIssues.length} automatic fixes to ${dataset.originalName}`,
                        details: {
                            dataset: dataset.originalName,
                            fixes: autoFixableIssues.map(i => i.suggestedFix),
                        },
                        reasoning: 'These fixes will improve data quality without losing information.',
                    },
                    {
                        level: 'low',
                        factors: autoFixableIssues.map(i => i.description),
                        reversible: true,
                        estimatedImpact: 'Improves training data quality',
                    }
                );

                // Wait for approval or auto-approve
                const { approved } = await this.supervision.waitForApproval(checkpoint.id);

                if (approved) {
                    const { cleanedSamples, appliedFixes, remainingIssues } = applyAutoFixes(
                        dataset.samples,
                        dataset.issues
                    );

                    dataset.samples = cleanedSamples;
                    dataset.issues = remainingIssues;

                    this.supervision.logAudit('data_cleaned', {
                        dataset: dataset.originalName,
                        appliedFixes,
                    });
                }
            }
        }

        this.setPhase('model_selection', 60);
    }

    // ============= Phase 3: Model & Provider Selection =============

    /**
     * Get model recommendations and create selection checkpoint
     */
    async selectModel(): Promise<void> {
        this.setPhase('model_selection', 65);

        if (!this.state.intent) {
            throw new Error('Intent not set');
        }

        // Get recommendations from GPT - convert intent budget to expected format
        const budgetForModel = {
            min: this.state.intent.budget.min ?? 0,
            max: this.state.intent.budget.max ?? 1000,
        };

        const llm = getLlmRuntime(getConfiguredLlmProvider());
        const recommendation = await llm.recommendModel(
            {
                budget: budgetForModel,
                timeline: this.state.intent.timeline.preferredDuration || '4 hours',
                accuracyPriority: this.state.intent.quality.priority,
                preferredFamily: 'mistral',
            },
            this.context
        );

        const candidateAlternatives = Array.isArray(recommendation.candidates)
            ? recommendation.candidates
                .slice(0, 3)
                .map((candidate) => ({
                    option: candidate.modelId,
                    description: `Benchmark score ${candidate.benchmarkScore.toFixed(2)} (hits: ${candidate.benchmarkDomainHits}, signals: ${candidate.benchmarkSignalCount})`,
                    tradeoffs: candidate.modelId === recommendation.baseModel
                        ? 'Selected as primary recommendation'
                        : 'Alternative candidate with different benchmark profile',
                }))
            : [];

        // Create model selection checkpoint
        const checkpoint = await this.supervision.createCheckpoint(
            'model_selection',
            {
                summary: `Recommended: ${recommendation.baseModel} with ${recommendation.method} fine-tuning`,
                details: recommendation as unknown as Record<string, unknown>,
                reasoning: recommendation.reasoning,
                alternatives: candidateAlternatives.length > 0
                    ? candidateAlternatives
                    : [
                        {
                            option: 'Smaller model (faster, cheaper)',
                            description: 'Use a 7B parameter model instead',
                            tradeoffs: 'May have lower accuracy but trains 2x faster',
                        },
                        {
                            option: 'Larger model (better accuracy)',
                            description: 'Use a 70B parameter model',
                            tradeoffs: 'Better accuracy but 4x training cost',
                        },
                    ],
            },
            {
                level: 'medium',
                factors: ['Model choice significantly affects results'],
                reversible: true,
                estimatedImpact: 'Determines training approach and expected results',
            }
        );

        if (checkpoint.status === 'pending') {
            this.state.pendingCheckpoints.push(checkpoint);
            this.emit({
                type: 'checkpoint_required',
                data: { checkpoint },
                timestamp: new Date(),
            });
        }

        this.setPhase('training_config', 70);
    }

    /**
     * Approve training cost
     */
    async approveCost(estimatedCost: number): Promise<boolean> {
        this.setPhase('cost_approval', 75);

        const checkpointData = createCostCheckpoint(
            estimatedCost,
            {
                compute: estimatedCost * 0.8,
                storage: estimatedCost * 0.1,
                overhead: estimatedCost * 0.1,
            },
            [
                {
                    option: 'Use spot instances',
                    cost: estimatedCost * 0.4,
                    tradeoffs: 'May be interrupted and take longer'
                },
                {
                    option: 'Use smaller batch size',
                    cost: estimatedCost * 0.7,
                    tradeoffs: 'Slightly lower accuracy'
                },
            ]
        );

        const checkpoint = await this.supervision.createCheckpoint(
            checkpointData.type,
            checkpointData.proposal,
            checkpointData.risk
        );

        if (checkpoint.status === 'pending') {
            this.state.pendingCheckpoints.push(checkpoint);
            this.emit({
                type: 'checkpoint_required',
                data: { checkpoint },
                timestamp: new Date(),
            });

            const { approved } = await this.supervision.waitForApproval(checkpoint.id);
            return approved;
        }

        return checkpoint.status === 'approved';
    }

    // ============= Utility Methods =============

    private async loadFileSamples(file: UploadedFile): Promise<Record<string, unknown>[]> {
        // In production, this would read from Supabase Storage
        // For now, return mock data
        return [
            { id: 1, text: 'Sample text 1', label: 'positive' },
            { id: 2, text: 'Sample text 2', label: 'negative' },
            { id: 3, text: 'Sample text 3', label: 'positive' },
        ];
    }

    // ============= State Getters =============

    get currentPhase(): PipelinePhase {
        return this.state.phase;
    }

    get progress(): number {
        return this.state.progress;
    }

    get state_(): PipelineState {
        return { ...this.state };
    }

    get pendingCheckpoints(): Checkpoint[] {
        return [...this.state.pendingCheckpoints];
    }

    get auditLog() {
        return this.supervision.getAuditLog();
    }

    /**
     * Resolve a checkpoint from UI
     */
    async resolveCheckpoint(
        checkpointId: string,
        action: 'approved' | 'rejected' | 'modified',
        modifications?: Record<string, unknown>,
        notes?: string
    ): Promise<void> {
        await this.supervision.resolveCheckpoint(checkpointId, action, modifications, notes);

        // Move from pending to resolved
        const idx = this.state.pendingCheckpoints.findIndex(c => c.id === checkpointId);
        if (idx >= 0) {
            const [checkpoint] = this.state.pendingCheckpoints.splice(idx, 1);
            this.state.resolvedCheckpoints.push(checkpoint);
        }
    }
}

// ============= Factory =============

export function createPipeline(
    context: ProjectContext,
    supervisionLevel?: SupervisionLevel
): AgenticPipelineOrchestrator {
    return new AgenticPipelineOrchestrator(context, supervisionLevel);
}
