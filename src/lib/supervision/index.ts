// Supervision Layer Service
// Human-in-the-loop checkpoints, approval gates, override capabilities, audit logging

import type { TaskType } from '@/types';

// WorkloadIntent type definition (inline to avoid circular dependency)
export interface WorkloadIntent {
    taskType: TaskType;
    taskSubtype?: string;
    inputDescription: string;
    outputDescription: string;
    budget: {
        hasConstraint: boolean;
        min?: number;
        max?: number;
        currency: string;
        isFlexible: boolean;
        notes?: string;
    };
    timeline: {
        hasDeadline: boolean;
        deadline?: Date;
        urgency: 'low' | 'medium' | 'high' | 'critical';
        preferredDuration?: string;
        notes?: string;
    };
    quality: {
        priority: 'speed' | 'balanced' | 'accuracy' | 'cost';
        minimumAccuracy?: number;
        acceptableErrorRate?: number;
        evaluationMetrics: string[];
    };
    dataRequirements?: {
        domain: string;
        geographicScope?: string;
        temporalScope?: string;
        granularity?: string;
        estimatedSize?: string;
    };
    deployment: {
        target: 'api' | 'huggingface' | 'download' | 'local' | 'undecided';
        scalingRequirements?: string;
        latencyRequirements?: string;
    };
    confidence: number;
    clarificationsNeeded: string[];
    assumptions: string[];
}

// ============= Types =============

export type SupervisionLevel = 'full_auto' | 'minimal' | 'standard' | 'strict';

export type CheckpointType =
    | 'intent_confirmation'      // Confirm we understand the task
    | 'data_cleaning_approval'   // Approve data transformations
    | 'model_selection'          // Confirm model choice
    | 'training_config'          // Approve training settings
    | 'cost_approval'            // Approve spending
    | 'deployment_confirmation'  // Confirm deployment settings
    | 'data_source_approval'     // Approve data sources (autonomous)
    | 'merge_strategy_approval'  // Approve dataset merge strategy
    | 'critical_decision';       // Any critical decision

export interface Checkpoint {
    id: string;
    type: CheckpointType;
    title: string;
    description: string;

    // What the agent is proposing
    proposal: {
        summary: string;
        details: Record<string, unknown>;
        reasoning: string;
        alternatives?: Array<{
            option: string;
            description: string;
            tradeoffs: string;
        }>;
    };

    // Risk assessment
    risk: {
        level: 'low' | 'medium' | 'high' | 'critical';
        factors: string[];
        reversible: boolean;
        estimatedImpact: string;
    };

    // What we need from the user
    requiredAction: 'approve' | 'choose' | 'modify' | 'confirm';
    options?: string[];

    // Status
    status: 'pending' | 'approved' | 'rejected' | 'modified' | 'skipped';
    userResponse?: {
        action: string;
        modifications?: Record<string, unknown>;
        timestamp: Date;
        notes?: string;
    };

    // Timeout handling
    autoApproveAfter?: number; // ms, for low-risk items
    createdAt: Date;
    resolvedAt?: Date;
}

export interface SupervisionConfig {
    level: SupervisionLevel;

    // Which checkpoints to enforce
    requiredCheckpoints: CheckpointType[];

    // Auto-approval settings
    autoApprove: {
        lowRiskItems: boolean;
        belowCostThreshold: number; // Auto-approve if cost below this
        timeoutMs: number;
    };

    // Notification preferences
    notifications: {
        email: boolean;
        inApp: boolean;
        slack?: string;
    };

    // Override settings
    allowOverride: boolean;
    requireOverrideReason: boolean;
}

export interface AuditLogEntry {
    id: string;
    projectId: string;
    timestamp: Date;
    actor: 'agent' | 'user' | 'system';

    action: {
        type: string;
        description: string;
        checkpoint?: string;
    };

    context: {
        step: number;
        phase: string;
        previousState: Record<string, unknown>;
        newState: Record<string, unknown>;
    };

    details: Record<string, unknown>;

    // If this was an override of agent recommendation
    override?: {
        originalRecommendation: Record<string, unknown>;
        userDecision: Record<string, unknown>;
        reason: string;
    };
}

export interface SupervisionState {
    config: SupervisionConfig;
    checkpoints: Checkpoint[];
    auditLog: AuditLogEntry[];
    pendingApprovals: number;
    lastUserInteraction: Date;
}

// ============= Default Configurations =============

export const SUPERVISION_PRESETS: Record<SupervisionLevel, SupervisionConfig> = {
    full_auto: {
        level: 'full_auto',
        requiredCheckpoints: [],
        autoApprove: {
            lowRiskItems: true,
            belowCostThreshold: 1000,
            timeoutMs: 0, // Immediate
        },
        notifications: { email: false, inApp: false },
        allowOverride: true,
        requireOverrideReason: false,
    },

    minimal: {
        level: 'minimal',
        requiredCheckpoints: ['cost_approval', 'deployment_confirmation'],
        autoApprove: {
            lowRiskItems: true,
            belowCostThreshold: 100,
            timeoutMs: 30000, // 30 seconds
        },
        notifications: { email: false, inApp: true },
        allowOverride: true,
        requireOverrideReason: false,
    },

    standard: {
        level: 'standard',
        requiredCheckpoints: [
            'intent_confirmation',
            'data_cleaning_approval',
            'model_selection',
            'cost_approval',
            'deployment_confirmation',
        ],
        autoApprove: {
            lowRiskItems: true,
            belowCostThreshold: 10,
            timeoutMs: 60000, // 1 minute
        },
        notifications: { email: true, inApp: true },
        allowOverride: true,
        requireOverrideReason: true,
    },

    strict: {
        level: 'strict',
        requiredCheckpoints: [
            'intent_confirmation',
            'data_source_approval',
            'data_cleaning_approval',
            'merge_strategy_approval',
            'model_selection',
            'training_config',
            'cost_approval',
            'deployment_confirmation',
        ],
        autoApprove: {
            lowRiskItems: false,
            belowCostThreshold: 0, // Never auto-approve costs
            timeoutMs: 0, // Never timeout
        },
        notifications: { email: true, inApp: true },
        allowOverride: true,
        requireOverrideReason: true,
    },
};

// ============= Supervision Manager =============

export class SupervisionManager {
    private state: SupervisionState;
    private projectId: string;

    constructor(projectId: string, level: SupervisionLevel = 'standard') {
        this.projectId = projectId;
        this.state = {
            config: SUPERVISION_PRESETS[level],
            checkpoints: [],
            auditLog: [],
            pendingApprovals: 0,
            lastUserInteraction: new Date(),
        };
    }

    // ============= Checkpoint Management =============

    /**
     * Create a checkpoint that requires user approval
     */
    async createCheckpoint(
        type: CheckpointType,
        proposal: Checkpoint['proposal'],
        risk: Checkpoint['risk']
    ): Promise<Checkpoint> {
        const checkpoint: Checkpoint = {
            id: crypto.randomUUID(),
            type,
            title: this.getCheckpointTitle(type),
            description: this.getCheckpointDescription(type),
            proposal,
            risk,
            requiredAction: this.determineRequiredAction(type, risk),
            status: 'pending',
            createdAt: new Date(),
        };

        // Check if we should auto-approve
        if (this.shouldAutoApprove(checkpoint)) {
            checkpoint.status = 'approved';
            checkpoint.userResponse = {
                action: 'auto_approved',
                timestamp: new Date(),
                notes: 'Auto-approved based on supervision settings',
            };
            checkpoint.resolvedAt = new Date();

            this.logAudit('checkpoint_auto_approved', { checkpointId: checkpoint.id, type: checkpoint.type });
        } else {
            this.state.pendingApprovals++;
        }

        this.state.checkpoints.push(checkpoint);
        return checkpoint;
    }

    /**
     * Wait for checkpoint approval (blocks until resolved)
     */
    async waitForApproval(checkpointId: string): Promise<{
        approved: boolean;
        modifications?: Record<string, unknown>;
    }> {
        const checkpoint = this.state.checkpoints.find(c => c.id === checkpointId);
        if (!checkpoint) {
            throw new Error(`Checkpoint ${checkpointId} not found`);
        }

        // Already resolved
        if (checkpoint.status !== 'pending') {
            return {
                approved: checkpoint.status === 'approved' || checkpoint.status === 'modified',
                modifications: checkpoint.userResponse?.modifications,
            };
        }

        // Check for auto-approve timeout
        if (checkpoint.autoApproveAfter) {
            const elapsed = Date.now() - checkpoint.createdAt.getTime();
            if (elapsed >= checkpoint.autoApproveAfter) {
                await this.resolveCheckpoint(checkpointId, 'approved');
                return { approved: true };
            }
        }

        // In a real implementation, this would wait for user input via WebSocket
        // For now, we'll return a promise that the UI will resolve
        return new Promise((resolve) => {
            // This would be replaced with actual event listening
            const checkResolved = () => {
                const cp = this.state.checkpoints.find(c => c.id === checkpointId);
                if (cp && cp.status !== 'pending') {
                    resolve({
                        approved: cp.status === 'approved' || cp.status === 'modified',
                        modifications: cp.userResponse?.modifications,
                    });
                } else {
                    setTimeout(checkResolved, 1000);
                }
            };
            checkResolved();
        });
    }

    /**
     * Resolve a pending checkpoint
     */
    async resolveCheckpoint(
        checkpointId: string,
        action: 'approved' | 'rejected' | 'modified',
        modifications?: Record<string, unknown>,
        notes?: string
    ): Promise<void> {
        const checkpoint = this.state.checkpoints.find(c => c.id === checkpointId);
        if (!checkpoint) {
            throw new Error(`Checkpoint ${checkpointId} not found`);
        }

        // Decrement pending count before changing status
        if (checkpoint.status === 'pending') {
            this.state.pendingApprovals--;
        }

        checkpoint.status = action;
        checkpoint.userResponse = {
            action,
            modifications,
            timestamp: new Date(),
            notes,
        };
        checkpoint.resolvedAt = new Date();

        this.state.lastUserInteraction = new Date();
        this.logAudit(`checkpoint_${action}`, { checkpointId: checkpoint.id, type: checkpoint.type }, modifications);
    }

    // ============= Override Handling =============

    /**
     * Allow user to override agent recommendation
     */
    async override(
        checkpointId: string,
        userDecision: Record<string, unknown>,
        reason: string
    ): Promise<void> {
        if (!this.state.config.allowOverride) {
            throw new Error('Overrides are not allowed in current supervision mode');
        }

        if (this.state.config.requireOverrideReason && !reason) {
            throw new Error('Override reason is required');
        }

        const checkpoint = this.state.checkpoints.find(c => c.id === checkpointId);
        if (!checkpoint) {
            throw new Error(`Checkpoint ${checkpointId} not found`);
        }

        await this.resolveCheckpoint(checkpointId, 'modified', userDecision, reason);

        // Log special audit entry for overrides
        this.state.auditLog.push({
            id: crypto.randomUUID(),
            projectId: this.projectId,
            timestamp: new Date(),
            actor: 'user',
            action: {
                type: 'override',
                description: `User overrode agent recommendation for ${checkpoint.type}`,
                checkpoint: checkpointId,
            },
            context: {
                step: 0,
                phase: checkpoint.type,
                previousState: checkpoint.proposal.details,
                newState: userDecision,
            },
            details: {},
            override: {
                originalRecommendation: checkpoint.proposal.details,
                userDecision,
                reason,
            },
        });
    }

    // ============= Audit Logging =============

    /**
     * Log an action to the audit trail
     */
    logAudit(
        actionType: string,
        details: Record<string, unknown>,
        newState?: Record<string, unknown>
    ): void {
        this.state.auditLog.push({
            id: crypto.randomUUID(),
            projectId: this.projectId,
            timestamp: new Date(),
            actor: 'agent',
            action: {
                type: actionType,
                description: `Agent action: ${actionType}`,
            },
            context: {
                step: 0,
                phase: 'pipeline',
                previousState: {},
                newState: newState || details,
            },
            details,
        });
    }

    /**
     * Get full audit trail
     */
    getAuditLog(): AuditLogEntry[] {
        return [...this.state.auditLog];
    }

    /**
     * Export audit log as JSON
     */
    exportAuditLog(): string {
        return JSON.stringify(this.state.auditLog, null, 2);
    }

    // ============= Helper Methods =============

    private shouldAutoApprove(checkpoint: Checkpoint): boolean {
        const config = this.state.config;

        // Never auto-approve if checkpoint is required
        if (config.requiredCheckpoints.includes(checkpoint.type)) {
            return false;
        }

        // Auto-approve low risk items if enabled
        if (config.autoApprove.lowRiskItems && checkpoint.risk.level === 'low') {
            return true;
        }

        // Auto-approve if below cost threshold
        const cost = (checkpoint.proposal.details as Record<string, unknown>).estimatedCost as number | undefined;
        if (cost !== undefined && cost <= config.autoApprove.belowCostThreshold) {
            return true;
        }

        return false;
    }

    private determineRequiredAction(type: CheckpointType, risk: Checkpoint['risk']): Checkpoint['requiredAction'] {
        if (type === 'model_selection' || type === 'merge_strategy_approval') {
            return 'choose';
        }
        if (risk.level === 'critical' || type === 'cost_approval') {
            return 'confirm';
        }
        return 'approve';
    }

    private getCheckpointTitle(type: CheckpointType): string {
        const titles: Record<CheckpointType, string> = {
            intent_confirmation: 'Confirm Task Understanding',
            data_cleaning_approval: 'Approve Data Cleaning',
            model_selection: 'Select Model',
            training_config: 'Approve Training Configuration',
            cost_approval: 'Approve Estimated Cost',
            deployment_confirmation: 'Confirm Deployment',
            data_source_approval: 'Approve Data Sources',
            merge_strategy_approval: 'Approve Merge Strategy',
            critical_decision: 'Critical Decision Required',
        };
        return titles[type] || type;
    }

    private getCheckpointDescription(type: CheckpointType): string {
        const descriptions: Record<CheckpointType, string> = {
            intent_confirmation: 'Please confirm we correctly understand your requirements.',
            data_cleaning_approval: 'Review and approve the proposed data cleaning operations.',
            model_selection: 'Choose from recommended models for your task.',
            training_config: 'Review training hyperparameters and configuration.',
            cost_approval: 'Approve the estimated training cost before proceeding.',
            deployment_confirmation: 'Confirm deployment settings and destination.',
            data_source_approval: 'Review and approve data sources to be collected.',
            merge_strategy_approval: 'Approve the strategy for merging multiple datasets.',
            critical_decision: 'A critical decision requires your input.',
        };
        return descriptions[type] || '';
    }

    // ============= Getters =============

    get pendingApprovals(): number {
        return this.state.pendingApprovals;
    }

    get checkpoints(): Checkpoint[] {
        return [...this.state.checkpoints];
    }

    get config(): SupervisionConfig {
        return { ...this.state.config };
    }

    setConfig(config: Partial<SupervisionConfig>): void {
        this.state.config = { ...this.state.config, ...config };
    }
}

// ============= Checkpoint Builders =============

/**
 * Create intent confirmation checkpoint
 */
export function createIntentCheckpoint(intent: WorkloadIntent): Omit<Checkpoint, 'id' | 'createdAt' | 'status'> {
    return {
        type: 'intent_confirmation',
        title: 'Confirm Task Understanding',
        description: 'Please verify that we correctly understand your requirements.',
        proposal: {
            summary: `${intent.taskType} task: ${intent.inputDescription} → ${intent.outputDescription}`,
            details: intent as unknown as Record<string, unknown>,
            reasoning: intent.assumptions.length > 0
                ? `We made the following assumptions: ${intent.assumptions.join(', ')}`
                : 'Based on your description, this is our understanding.',
            alternatives: [],
        },
        risk: {
            level: intent.confidence < 0.7 ? 'medium' : 'low',
            factors: intent.clarificationsNeeded,
            reversible: true,
            estimatedImpact: 'Incorrect understanding may lead to suboptimal results',
        },
        requiredAction: intent.clarificationsNeeded.length > 0 ? 'modify' : 'approve',
    };
}

/**
 * Create cost approval checkpoint
 */
export function createCostCheckpoint(
    estimatedCost: number,
    breakdown: Record<string, number>,
    alternatives: Array<{ option: string; cost: number; tradeoffs: string }>
): Omit<Checkpoint, 'id' | 'createdAt' | 'status'> {
    return {
        type: 'cost_approval',
        title: 'Approve Training Cost',
        description: `The estimated cost for this training job is $${estimatedCost.toFixed(2)}`,
        proposal: {
            summary: `Total estimated cost: $${estimatedCost.toFixed(2)}`,
            details: { estimatedCost, breakdown },
            reasoning: 'Cost based on selected provider, GPU type, and estimated training duration.',
            alternatives: alternatives.map(a => ({
                option: a.option,
                description: `$${a.cost.toFixed(2)}`,
                tradeoffs: a.tradeoffs,
            })),
        },
        risk: {
            level: estimatedCost > 100 ? 'high' : estimatedCost > 20 ? 'medium' : 'low',
            factors: ['Actual cost may vary based on training duration'],
            reversible: false,
            estimatedImpact: `Will charge approximately $${estimatedCost.toFixed(2)} to your account`,
        },
        requiredAction: 'confirm',
    };
}
