// Intent Detection Service
// Robust extraction of user intent for AI workloads
// Handles: workload type, budget, deadline, accuracy preferences

import type { ProjectContext, Message, IntentAnalysis, TaskType } from '@/types';
import { getConfiguredLlmProvider } from '@/lib/llm/provider';
import { getLlmRuntime } from '@/lib/llm/runtime';

// ============= Types =============

export interface WorkloadIntent {
    // Core workload type
    taskType: TaskType;
    taskSubtype?: string; // e.g., "sentiment_analysis", "text_generation", "forecasting"

    // Input/Output understanding
    inputDescription: string;
    outputDescription: string;

    // Budget constraints
    budget: {
        hasConstraint: boolean;
        min?: number;
        max?: number;
        currency: string;
        isFlexible: boolean;
        notes?: string;
    };

    // Timeline/Deadline
    timeline: {
        hasDeadline: boolean;
        deadline?: Date;
        urgency: 'low' | 'medium' | 'high' | 'critical';
        preferredDuration?: string; // e.g., "2 hours", "1 day"
        notes?: string;
    };

    // Quality preferences
    quality: {
        priority: 'speed' | 'balanced' | 'accuracy' | 'cost';
        minimumAccuracy?: number;
        acceptableErrorRate?: number;
        evaluationMetrics: string[];
    };

    // Data requirements (for autonomous mode)
    dataRequirements?: {
        domain: string;
        geographicScope?: string;
        temporalScope?: string;
        granularity?: string;
        estimatedSize?: string;
    };

    // Deployment preferences
    deployment: {
        target: 'api' | 'huggingface' | 'download' | 'local' | 'undecided';
        scalingRequirements?: string;
        latencyRequirements?: string;
    };

    // Confidence and clarifications needed
    confidence: number; // 0-1
    clarificationsNeeded: string[];
    assumptions: string[];
}

export interface IntentExtractionResult {
    intent: WorkloadIntent;
    rawAnalysis: string;
    suggestedFollowUp: string[];
    missingInformation: string[];
}

// ============= Intent Detection Functions =============

const INTENT_EXTRACTION_FUNCTION = {
    name: 'extract_workload_intent',
    description: 'Extract comprehensive workload intent from user message including budget, deadline, and quality preferences',
    parameters: {
        type: 'object' as const,
        properties: {
            taskType: {
                type: 'string',
                enum: ['classification', 'regression', 'generation', 'seq2seq', 'summarization', 'qa', 'embedding', 'other'],
                description: 'Primary ML task type'
            },
            taskSubtype: {
                type: 'string',
                description: 'More specific task subtype, e.g., sentiment_analysis, named_entity_recognition'
            },
            inputDescription: {
                type: 'string',
                description: 'Description of input data the model will receive'
            },
            outputDescription: {
                type: 'string',
                description: 'Description of expected model output'
            },
            budgetMin: { type: 'number', description: 'Minimum budget in USD' },
            budgetMax: { type: 'number', description: 'Maximum budget in USD' },
            budgetCurrency: { type: 'string', description: 'Budget currency, default USD' },
            budgetIsFlexible: { type: 'boolean', description: 'Whether budget is negotiable' },
            budgetNotes: { type: 'string', description: 'Any notes about budget constraints' },
            hasDeadline: { type: 'boolean', description: 'Whether there is a deadline' },
            deadlineDate: { type: 'string', description: 'ISO date string of deadline if specified' },
            urgency: {
                type: 'string',
                enum: ['low', 'medium', 'high', 'critical'],
                description: 'Urgency level of the project'
            },
            preferredDuration: { type: 'string', description: 'Preferred training duration' },
            qualityPriority: {
                type: 'string',
                enum: ['speed', 'balanced', 'accuracy', 'cost'],
                description: 'What the user prioritizes most'
            },
            minimumAccuracy: { type: 'number', description: 'Minimum acceptable accuracy (0-1)' },
            evaluationMetrics: {
                type: 'array',
                items: { type: 'string' },
                description: 'Metrics to evaluate model performance'
            },
            domain: { type: 'string', description: 'Data domain (e.g., agriculture, finance, healthcare)' },
            geographicScope: { type: 'string', description: 'Geographic scope if applicable' },
            temporalScope: { type: 'string', description: 'Time range for data (e.g., last 5 years)' },
            deploymentTarget: {
                type: 'string',
                enum: ['api', 'huggingface', 'download', 'local', 'undecided'],
                description: 'Where to deploy the model'
            },
            confidence: {
                type: 'number',
                description: 'Confidence in extraction (0-1)'
            },
            clarificationsNeeded: {
                type: 'array',
                items: { type: 'string' },
                description: 'Questions to ask user for clarification'
            },
            assumptions: {
                type: 'array',
                items: { type: 'string' },
                description: 'Assumptions made during extraction'
            },
        },
        required: ['taskType', 'inputDescription', 'outputDescription', 'qualityPriority', 'confidence'],
    },
};

/**
 * Extract comprehensive workload intent from user message
 */
export async function extractWorkloadIntent(
    userMessage: string,
    context: ProjectContext,
    conversationHistory: Message[] = []
): Promise<IntentExtractionResult> {
    const prompt = `
You are an expert ML project analyst. Analyze the user's request and extract comprehensive workload intent.

User's request: "${userMessage}"

${conversationHistory.length > 0 ? `
Previous conversation:
${conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')}
` : ''}

${context.dataContext ? `
Data already uploaded:
- Files: ${context.dataContext.files.length}
- Total rows: ${context.dataContext.totalRows}
- Formats: ${context.dataContext.formats.join(', ')}
` : ''}

Extract all available information about:
1. The ML task type and specifics
2. Budget constraints (look for $ amounts, "cheap", "affordable", "enterprise", etc.)
3. Timeline/deadline (look for dates, "ASAP", "by next week", "no rush", etc.)
4. Quality preferences (look for accuracy targets, "fast", "accurate", "cheap", etc.)
5. Deployment preferences
6. Data requirements if this is an autonomous data collection task

Be thorough but honest about what's explicitly stated vs assumed.
`;

    try {
        const llm = getLlmRuntime(getConfiguredLlmProvider());
        const result = await llm.functionCall(
            [{ role: 'user', content: prompt }],
            [INTENT_EXTRACTION_FUNCTION],
            context
        );

        const args = result.arguments as Record<string, unknown>;

        const intent: WorkloadIntent = {
            taskType: (args.taskType as TaskType) || 'generation',
            taskSubtype: args.taskSubtype as string | undefined,
            inputDescription: (args.inputDescription as string) || 'Unknown input',
            outputDescription: (args.outputDescription as string) || 'Unknown output',
            budget: {
                hasConstraint: !!(args.budgetMin || args.budgetMax),
                min: args.budgetMin as number | undefined,
                max: args.budgetMax as number | undefined,
                currency: (args.budgetCurrency as string) || 'USD',
                isFlexible: (args.budgetIsFlexible as boolean) ?? true,
                notes: args.budgetNotes as string | undefined,
            },
            timeline: {
                hasDeadline: (args.hasDeadline as boolean) ?? false,
                deadline: args.deadlineDate ? new Date(args.deadlineDate as string) : undefined,
                urgency: (args.urgency as 'low' | 'medium' | 'high' | 'critical') || 'medium',
                preferredDuration: args.preferredDuration as string | undefined,
            },
            quality: {
                priority: (args.qualityPriority as 'speed' | 'balanced' | 'accuracy' | 'cost') || 'balanced',
                minimumAccuracy: args.minimumAccuracy as number | undefined,
                evaluationMetrics: (args.evaluationMetrics as string[]) || ['accuracy'],
            },
            dataRequirements: args.domain ? {
                domain: args.domain as string,
                geographicScope: args.geographicScope as string | undefined,
                temporalScope: args.temporalScope as string | undefined,
            } : undefined,
            deployment: {
                target: (args.deploymentTarget as 'api' | 'huggingface' | 'download' | 'local' | 'undecided') || 'undecided',
            },
            confidence: (args.confidence as number) || 0.5,
            clarificationsNeeded: (args.clarificationsNeeded as string[]) || [],
            assumptions: (args.assumptions as string[]) || [],
        };

        // Generate follow-up questions if confidence is low
        const suggestedFollowUp = generateFollowUpQuestions(intent);
        const missingInformation = identifyMissingInfo(intent);

        return {
            intent,
            rawAnalysis: JSON.stringify(args, null, 2),
            suggestedFollowUp,
            missingInformation,
        };
    } catch (error) {
        console.error('Intent extraction error:', error);
        throw error;
    }
}

/**
 * Generate follow-up questions based on missing or uncertain information
 */
function generateFollowUpQuestions(intent: WorkloadIntent): string[] {
    const questions: string[] = [];

    if (!intent.budget.hasConstraint) {
        questions.push("What's your budget range for this project? (This helps us optimize for cost vs. quality)");
    }

    if (!intent.timeline.hasDeadline && intent.timeline.urgency === 'medium') {
        questions.push("Do you have a deadline or preferred timeline for this project?");
    }

    if (!intent.quality.minimumAccuracy) {
        questions.push(`What's your minimum acceptable ${intent.quality.evaluationMetrics[0] || 'accuracy'} for this model?`);
    }

    if (intent.deployment.target === 'undecided') {
        questions.push("How do you plan to deploy or use this model? (API, HuggingFace Hub, local download)");
    }

    if (intent.confidence < 0.7) {
        questions.push(...intent.clarificationsNeeded.slice(0, 2));
    }

    return questions.slice(0, 3); // Max 3 questions at a time
}

/**
 * Identify missing critical information
 */
function identifyMissingInfo(intent: WorkloadIntent): string[] {
    const missing: string[] = [];

    if (!intent.budget.hasConstraint) missing.push('budget');
    if (!intent.timeline.hasDeadline) missing.push('deadline');
    if (!intent.quality.minimumAccuracy) missing.push('target_accuracy');
    if (intent.deployment.target === 'undecided') missing.push('deployment_target');

    return missing;
}

/**
 * Validate intent completeness for proceeding
 */
export function isIntentComplete(intent: WorkloadIntent): { complete: boolean; blockers: string[] } {
    const blockers: string[] = [];

    const addBlocker = (text: string) => {
        if (!blockers.includes(text)) blockers.push(text);
    };

    if (intent.confidence < 0.5) {
        addBlocker('Low confidence in understanding the task');
    }

    const hasClarifications = Array.isArray(intent.clarificationsNeeded)
        && intent.clarificationsNeeded.some(item => typeof item === 'string' && item.trim());
    if (hasClarifications) {
        addBlocker('Additional clarification needed');
    }

    // For high-value tasks, require budget confirmation
    if (!intent.budget.hasConstraint && intent.timeline.urgency !== 'low') {
        addBlocker('Budget not confirmed');
    }

    const missingInfo = identifyMissingInfo(intent);
    if (missingInfo.includes('target_accuracy')) {
        addBlocker('Target accuracy not confirmed');
    }
    if (missingInfo.includes('deployment_target')) {
        addBlocker('Deployment target not confirmed');
    }
    if (
        missingInfo.includes('deadline')
        && (intent.timeline.urgency === 'high' || intent.timeline.urgency === 'critical')
    ) {
        addBlocker('Deadline not confirmed');
    }

    return {
        complete: blockers.length === 0,
        blockers,
    };
}

/**
 * Multi-turn intent refinement - iteratively improve understanding
 */
export async function refineIntent(
    currentIntent: WorkloadIntent,
    userResponse: string,
    context: ProjectContext
): Promise<IntentExtractionResult> {
    const refinementPrompt = `
Current understanding of the user's intent:
${JSON.stringify(currentIntent, null, 2)}

User's clarification: "${userResponse}"

Update the intent with this new information. Keep existing information unless directly contradicted.
`;

    return extractWorkloadIntent(refinementPrompt, context, [
        { role: 'assistant', content: `I understand you want to ${currentIntent.taskType}. Let me clarify...` },
        { role: 'user', content: userResponse },
    ]);
}
