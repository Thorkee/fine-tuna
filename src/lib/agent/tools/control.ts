import { z } from 'zod';
import type { ReasoningEffort, Tool, ToolExecutionResult } from '../types';

// ============= Schemas =============

const openArtifactArgsSchema = z.object({
    id: z.string().min(1),
});

const planStepInputSchema = z.object({
    id: z.string().min(1).optional(),
    title: z.string().min(1),
    description: z.string().default(''),
    assignedSkillId: z.string().min(1).optional(),
    toolNeeds: z.array(z.string().min(1)).optional(),
    verification: z.string().min(1).optional(),
    rollback: z.string().min(1).optional(),
}).strip();

const setPlanArgsSchema = z.object({
    goal: z.string().min(1),
    successCriteria: z.array(z.string().min(1)).optional(),
    steps: z.array(planStepInputSchema).min(1),
}).strict();

const updatePlanStepArgsSchema = z.object({
    id: z.string().min(1),
    status: z.enum(['todo', 'doing', 'blocked', 'done', 'failed', 'skipped']),
    result: z.string().optional(),
    evidence: z.string().optional(),
}).strict();

const setActiveSkillArgsSchema = z.object({
    skillId: z.string().min(1),
}).strict();

const artifactTypeSchema = z.enum([
    'plan',
    'code',
    'dataset',
    'visualization',
    'model_card',
    'markdown',
    'document',
    'spreadsheet',
]);
const artifactStatusSchema = z.enum(['draft', 'final', 'executing']);

const upsertArtifactArgsSchema = z.object({
    id: z.string().min(1),
    type: artifactTypeSchema,
    title: z.string().min(1).optional(),
    content: z.unknown(),
    status: artifactStatusSchema.optional(),
    isCollaborative: z.boolean().optional(),
}).strict();

const reasoningEffortSchema: z.ZodType<ReasoningEffort> = z
    .string()
    .transform(s => s.trim().toLowerCase())
    .pipe(z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']));

const setReasoningEffortArgsSchema = z.object({
    level: reasoningEffortSchema,
}).strict();

const signalCompletionArgsSchema = z.object({
    summary: z.string().min(1).describe('Brief summary of what was accomplished and the final outcome.'),
    unfinishedItems: z.array(z.string()).optional().describe('Any items explicitly left undone with reasons.'),
}).strict();

// ============= Tools =============

export const openArtifactTool: Tool = {
    category: 'ui',
    definition: {
        name: 'open_artifact',
        description: 'Open an artifact in the UI Canvas by id (e.g., "plan", "sandbox").',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Artifact id to open' },
            },
            required: ['id'],
        },
    },
    handler: async (args: unknown): Promise<ToolExecutionResult> => {
        const parsed = openArtifactArgsSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        return {
            ok: true,
            sideEffects: [{ type: 'ui.openArtifact', payload: { id: parsed.data.id } }],
        };
    },
};

export const setPlanTool: Tool = {
    category: 'core',
    definition: {
        name: 'set_plan',
        description: 'Set/replace the current plan (goal + steps). Use this at the start (plan-first) or when the goal changes.',
        parameters: {
            type: 'object',
            properties: {
                goal: { type: 'string' },
                successCriteria: { type: 'array', items: { type: 'string' } },
                steps: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            title: { type: 'string' },
                            description: { type: 'string' },
                            assignedSkillId: { type: 'string' },
                            toolNeeds: { type: 'array', items: { type: 'string' } },
                            verification: { type: 'string' },
                            rollback: { type: 'string' },
                        },
                        required: ['title'],
                    },
                },
            },
            required: ['goal', 'steps'],
        },
    },
    handler: async (args: unknown): Promise<ToolExecutionResult> => {
        const parsed = setPlanArgsSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        return {
            ok: true,
            sideEffects: [{ type: 'agent.setPlan', payload: parsed.data }],
        };
    },
};

export const updatePlanStepTool: Tool = {
    category: 'core',
    definition: {
        name: 'update_plan_step',
        description: 'Update a single plan step status/result/evidence.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string' },
                status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done', 'failed', 'skipped'] },
                result: { type: 'string' },
                evidence: { type: 'string' },
            },
            required: ['id', 'status'],
        },
    },
    handler: async (args: unknown): Promise<ToolExecutionResult> => {
        const parsed = updatePlanStepArgsSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        return {
            ok: true,
            sideEffects: [{ type: 'agent.updatePlanStep', payload: parsed.data }],
        };
    },
};

export const setActiveSkillTool: Tool = {
    category: 'core',
    definition: {
        name: 'set_active_skill',
        description: 'Switch the active skill for the next execution iteration.',
        parameters: {
            type: 'object',
            properties: {
                skillId: { type: 'string' },
            },
            required: ['skillId'],
        },
    },
    handler: async (args: unknown): Promise<ToolExecutionResult> => {
        const parsed = setActiveSkillArgsSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        return {
            ok: true,
            sideEffects: [{ type: 'agent.setActiveSkill', payload: parsed.data }],
        };
    },
};

export const setReasoningEffortTool: Tool = {
    category: 'core',
    definition: {
        name: 'set_reasoning_effort',
        description: 'Set the reasoning effort level for subsequent model calls in this run. Use higher effort for very hard tasks.',
        parameters: {
            type: 'object',
            properties: {
                level: { type: 'string', enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
            },
            required: ['level'],
        },
    },
    handler: async (args: unknown): Promise<ToolExecutionResult> => {
        const parsed = setReasoningEffortArgsSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        return {
            ok: true,
            sideEffects: [{ type: 'agent.setReasoningEffort', payload: { level: parsed.data.level } }],
        };
    },
};

export const signalCompletionTool: Tool = {
    category: 'core',
    definition: {
        name: 'signal_completion',
        description:
            'Signal that you have finished the user\'s request. Call this ONLY when all meaningful work is done ' +
            '(all plan steps are done/failed/skipped, or you\'ve answered the question). ' +
            'Do NOT call this prematurely — finish the work first. Provide a brief summary of what was accomplished.',
        parameters: {
            type: 'object',
            properties: {
                summary: {
                    type: 'string',
                    description: 'Brief summary of what was accomplished and the final outcome.',
                },
                unfinishedItems: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional: any items explicitly left undone, with reasons.',
                },
            },
            required: ['summary'],
        },
    },
    handler: async (args: unknown): Promise<ToolExecutionResult> => {
        const parsed = signalCompletionArgsSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        return {
            ok: true,
            sideEffects: [{ type: 'agent.signalCompletion', payload: parsed.data }],
        };
    },
};

export const upsertArtifactTool: Tool = {
    category: 'ui',
    definition: {
        name: 'upsert_artifact',
        description: 'Create or update an artifact (for Canvas). Only call this with real, substantive content — never with placeholder, empty, or stub content.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string' },
                type: {
                    type: 'string',
                    enum: ['plan', 'code', 'dataset', 'visualization', 'model_card', 'markdown', 'document', 'spreadsheet'],
                },
                title: { type: 'string' },
                content: { type: 'string', description: 'Artifact content (string or JSON-encoded object).' },
                status: { type: 'string', enum: ['draft', 'final', 'executing'] },
                isCollaborative: { type: 'boolean' },
            },
            required: ['id', 'type', 'content'],
        },
    },
    handler: async (args: unknown): Promise<ToolExecutionResult> => {
        const parsed = upsertArtifactArgsSchema.safeParse(args);
        if (!parsed.success) {
            return { ok: false, error: { message: parsed.error.message, name: 'ValidationError' } };
        }
        return {
            ok: true,
            sideEffects: [{ type: 'ui.upsertArtifact', payload: parsed.data }],
        };
    },
};

