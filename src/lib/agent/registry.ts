import type { Skill, Tool } from './types';
import fs from 'fs/promises';
import path from 'path';

const READONLY_SKILLS_DIR = path.resolve(process.cwd(), 'src/lib/agent/skills/dynamic');
const RUNTIME_SKILLS_DIR = process.env.VERCEL
    ? path.join('/tmp', 'tuna', 'skills', 'dynamic')
    : READONLY_SKILLS_DIR;

/**
 * The Central Registry for all Agent Capabilities.
 * This allows the agent to "know what it can do" by inspecting available skills/tools.
 */
export class CapabilityRegistry {
    private static instance: CapabilityRegistry;
    private skills: Map<string, Skill> = new Map();
    private tools: Map<string, Tool> = new Map();
    private isInitialized = false;

    private constructor() {
        // Private constructor for singleton
    }

    public static getInstance(): CapabilityRegistry {
        if (!CapabilityRegistry.instance) {
            CapabilityRegistry.instance = new CapabilityRegistry();
        }
        return CapabilityRegistry.instance;
    }

    /**
     * Start the registry and load dynamic skills
     */
    public async initialize(): Promise<void> {
        if (this.isInitialized) return;

        await this.loadDynamicSkills();
        this.isInitialized = true;
    }

    /**
     * Load JSON-based skills from the dynamic directory
     */
    private async loadDynamicSkills(): Promise<void> {
        try {
            const dirs = [READONLY_SKILLS_DIR, RUNTIME_SKILLS_DIR];
            const seen = new Set<string>();

            for (const dir of dirs) {
                try {
                    await fs.access(dir);
                } catch {
                    if (dir === RUNTIME_SKILLS_DIR) {
                        await fs.mkdir(dir, { recursive: true });
                    } else {
                        continue;
                    }
                }

                const files = (await fs.readdir(dir)).sort();
                for (const file of files) {
                    if (!file.endsWith('.json') || seen.has(file)) continue;
                    const content = await fs.readFile(path.join(dir, file), 'utf-8');
                    try {
                        const skill = JSON.parse(content) as Skill;
                        this.registerSkill(skill);
                        seen.add(file);
                    } catch (e) {
                        console.error(`Failed to load dynamic skill ${file}:`, e);
                    }
                }
            }
        } catch (e) {
            console.error("Error loading dynamic skills:", e);
        }
    }

    /**
     * Register a new Tool
     */
    public registerTool(tool: Tool): void {
        const id = tool.definition.name;
        if (this.tools.has(id)) {
            console.warn(`Tool ${id} is already registered. Overwriting.`);
        }
        this.tools.set(id, tool);
    }

    /**
     * Register a new Skill
     */
    public registerSkill(skill: Skill): void {
        if (this.skills.has(skill.id)) {
            // console.warn(`Skill ${skill.id} is already registered. Overwriting.`);
        }
        this.skills.set(skill.id, skill);
    }

    /**
     * Resolve a skill identifier to its canonical id.
     *
     * Accepts either the skill id (preferred) or the skill display name (case-insensitive).
     * This is intentionally forgiving because LLMs (and older persisted state) may use names.
     */
    public resolveSkillId(idOrName: string): string | undefined {
        const raw = typeof idOrName === 'string' ? idOrName.trim() : '';
        if (!raw) return undefined;

        if (this.skills.has(raw)) return raw;

        const needle = raw.toLowerCase();
        for (const [id, skill] of this.skills.entries()) {
            const name = typeof skill.name === 'string' ? skill.name.trim().toLowerCase() : '';
            if (name && name === needle) return id;
        }

        return undefined;
    }

    /**
     * Persist a new skill to disk (Dynamic Skill Creation)
     */
    public async saveDynamicSkill(skill: Skill): Promise<void> {
        // Register in memory first
        this.registerSkill(skill);

        // Save to disk
        const filePath = path.join(RUNTIME_SKILLS_DIR, `${skill.id}.json`);
        await fs.writeFile(filePath, JSON.stringify(skill, null, 2));
    }

    /**
     * Get a specific tool by name
     */
    public getTool(name: string): Tool | undefined {
        return this.tools.get(name);
    }

    /**
     * Get a specific skill by ID
     */
    public getSkill(idOrName: string): Skill | undefined {
        const resolved = this.resolveSkillId(idOrName);
        return resolved ? this.skills.get(resolved) : undefined;
    }

    /**
     * Get all registered skills
     */
    public getAllSkills(): Skill[] {
        return Array.from(this.skills.values());
    }

    /**
     * Get tool definitions for a specific skill
     */
    public getToolsForSkill(skillId: string): Tool[] {
        const resolved = this.resolveSkillId(skillId);
        if (!resolved) return [];
        const skill = this.skills.get(resolved);
        if (!skill) return [];

        return skill.tools
            .map(toolId => this.tools.get(toolId))
            .filter((t): t is Tool => !!t);
    }

    /**
     * Generate the "Capabilities" section of the System Prompt
     * This allows the agent to effectively "read its own manual".
     */
    public generateSystemPromptInventory(): string {
        const skillsList = Array.from(this.skills.values())
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(s => `- ${s.id} (${s.name}): ${s.description}`)
            .join('\n');

        const toolsList = Array.from(this.tools.values())
            .sort((a, b) => a.definition.name.localeCompare(b.definition.name))
            .map(t => `- ${t.definition.name}: ${t.definition.description}`)
            .join('\n');

        return `
You have the following specialized Skills enabled (use the skill id for \`set_active_skill\`):
${skillsList}

You have the following Tools available (only call tools that are exposed to your current Skill):
${toolsList}

When you need to perform a specific type of task (e.g. coding vs data analysis),
you should delegate to the appropriate Skill using the internal planning mechanism.
`;
    }
}

// Export a global instance
export const registry = CapabilityRegistry.getInstance();

