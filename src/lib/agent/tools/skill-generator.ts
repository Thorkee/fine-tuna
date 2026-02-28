import type { AgentContext, Skill, Tool } from '../types';
import { registry } from '../registry';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(v => typeof v === 'string');
}

function normalizeSkillArgs(value: unknown): unknown {
    if (!isRecord(value)) return value;

    // Common mistake: wrapping as `{ skill: { ... } }`
    const unwrapped = isRecord(value.skill) ? value.skill : value;
    if (!isRecord(unwrapped)) return unwrapped;

    // Common mistake: using snake_case keys.
    const normalized: Record<string, unknown> = { ...unwrapped };
    if (normalized.systemPrompt === undefined && typeof unwrapped.system_prompt === 'string') {
        normalized.systemPrompt = unwrapped.system_prompt;
    }
    if (normalized.suggestedArtifacts === undefined && isStringArray(unwrapped.suggested_artifacts)) {
        normalized.suggestedArtifacts = unwrapped.suggested_artifacts;
    }
    return normalized;
}

function parseSkill(value: unknown): { ok: true; skill: Skill } | { ok: false; message: string } {
    const normalized = normalizeSkillArgs(value);
    if (!isRecord(normalized)) {
        return {
            ok: false,
            message:
                'Invalid args for create_skill: expected an object { id, name, description, systemPrompt, tools, suggestedArtifacts? }.',
        };
    }

    const errors: string[] = [];

    const id = typeof normalized.id === 'string' ? normalized.id.trim() : '';
    const name = typeof normalized.name === 'string' ? normalized.name.trim() : '';
    const description = typeof normalized.description === 'string' ? normalized.description.trim() : '';
    const systemPrompt = typeof normalized.systemPrompt === 'string' ? normalized.systemPrompt.trim() : '';

    if (!id) errors.push('id (non-empty string)');
    if (!name) errors.push('name (non-empty string)');
    if (!description) errors.push('description (non-empty string)');
    if (!systemPrompt) errors.push('systemPrompt (non-empty string)');

    let tools: string[] = [];
    if (!isStringArray(normalized.tools)) {
        errors.push('tools (non-empty string[])');
    } else {
        tools = normalized.tools.map(t => t.trim()).filter(Boolean);
        if (tools.length === 0) errors.push('tools (must include at least 1 tool id)');
        if (tools.length !== normalized.tools.length) errors.push('tools (all entries must be non-empty strings)');
    }

    let suggestedArtifacts: string[] | undefined;
    if (normalized.suggestedArtifacts !== undefined) {
        if (!isStringArray(normalized.suggestedArtifacts)) {
            errors.push('suggestedArtifacts (string[])');
        } else {
            const cleaned = normalized.suggestedArtifacts.map(a => a.trim()).filter(Boolean);
            suggestedArtifacts = cleaned.length ? cleaned : undefined;
            if (cleaned.length !== normalized.suggestedArtifacts.length) {
                errors.push('suggestedArtifacts (all entries must be non-empty strings)');
            }
        }
    }

    if (errors.length) {
        const receivedKeys = Object.keys(normalized).sort().join(', ');
        return {
            ok: false,
            message: `Invalid args for create_skill: ${errors.join(
                '; ',
            )}. Expected shape: { id, name, description, systemPrompt, tools, suggestedArtifacts? }. Received keys: [${receivedKeys}]`,
        };
    }

    return {
        ok: true,
        skill: { id, name, description, systemPrompt, tools, suggestedArtifacts },
    };
}

export const createSkillTool: Tool = {
    category: 'core',
    definition: {
        name: 'create_skill',
        description: 'Create and register a new specialized skill for the agent. Use this when you find a repeating pattern of tasks that requires a specific persona or toolset.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Unique identifier for the skill (e.g. "finance_expert")' },
                name: { type: 'string', description: 'Human readable name (e.g. "Finance Expert")' },
                description: { type: 'string', description: 'What this skill is good at.' },
                systemPrompt: { type: 'string', description: 'The system prompt/persona for this skill.' },
                tools: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'List of tool IDs this skill should have access to.'
                },
                suggestedArtifacts: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Types of artifacts this skill typically produces.'
                }
            },
            required: ['id', 'name', 'description', 'systemPrompt', 'tools'],
        },
    },
    handler: async (args: unknown, _context: AgentContext) => {
        const parsed = parseSkill(args);
        if (!parsed.ok) {
            return { ok: false, error: { message: parsed.message, name: 'ValidationError' } };
        }
        try {
            await registry.saveDynamicSkill(parsed.skill);
            return {
                ok: true,
                data: {
                    message: `Skill '${parsed.skill.name}' created and registered successfully. You can now delegate tasks to it.`
                }
            };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { message } };
        }
    },
};
