import type { HuggingFaceSkillPreferences, SkillPreferences } from '@/types';

const HF_TOOL_GATES: Array<{
    pref: keyof HuggingFaceSkillPreferences;
    tools: string[];
}> = [
    { pref: 'search_hub', tools: ['hf_hub_search'] },
    { pref: 'explore_datasets', tools: ['hf_dataset_explore'] },
    { pref: 'query_dataset', tools: ['hf_dataset_query'] },
    { pref: 'get_documentation', tools: ['hf_get_documentation'] },
    { pref: 'run_spaces', tools: ['hf_space_run'] },
    { pref: 'train_model', tools: ['hf_job_run', 'hf_job_status', 'hf_job_logs', 'hf_job_cancel'] },
];

function isEnabled(value: boolean | undefined): boolean {
    return value !== false;
}

export function getDisabledToolsFromSkillPreferences(preferences?: SkillPreferences): Set<string> {
    const disabled = new Set<string>();
    const hf = preferences?.huggingface;
    if (!hf) return disabled;

    for (const gate of HF_TOOL_GATES) {
        if (!isEnabled(hf[gate.pref])) {
            for (const tool of gate.tools) {
                disabled.add(tool);
            }
        }
    }
    return disabled;
}
