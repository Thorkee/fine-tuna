import type { ArtifactType } from './types';

export const CANVAS_ARTIFACT_IDS = [
    'plan',
    'analysis',
    'intent',
    'research',
    'curation',
    'providers',
    'training',
    'export',
    'sandbox',
    'desktop',
    'document',
    'spreadsheet',
] as const;

export type CanvasArtifactId = typeof CANVAS_ARTIFACT_IDS[number];

export const CANVAS_ARTIFACT_ID_SET: ReadonlySet<string> = new Set(CANVAS_ARTIFACT_IDS);

export const DELIVERABLE_ARTIFACT_IDS = [
    'document',
    'spreadsheet',
    'export',
] as const;

export type DeliverableArtifactId = typeof DELIVERABLE_ARTIFACT_IDS[number];

export const DELIVERABLE_ARTIFACT_ID_SET: ReadonlySet<string> = new Set(DELIVERABLE_ARTIFACT_IDS);

export function isDeliverableArtifactId(id?: string | null): boolean {
    return Boolean(id && DELIVERABLE_ARTIFACT_ID_SET.has(id));
}

const TYPE_TO_CANVAS_ID: Partial<Record<ArtifactType, CanvasArtifactId>> = {
    plan: 'plan',
    dataset: 'curation',
    visualization: 'analysis',
    model_card: 'export',
    document: 'document',
    spreadsheet: 'spreadsheet',
};

function normalizeAliasKey(input: string): string {
    return String(input || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
}

// Accept common/legacy artifact ids and map to canonical Canvas ids.
const ID_ALIASES: Partial<Record<string, CanvasArtifactId>> = {
    // Web research / sources
    web_search: 'research',
    web_research: 'research',
    websearch: 'research',
    search: 'research',
    sources: 'research',
    citations: 'research',
    research_notes: 'research',

    // Provider comparison
    provider_comparison: 'providers',
    providers_comparison: 'providers',
    compare_providers: 'providers',

    // Python sandbox
    python_sandbox: 'sandbox',
    python: 'sandbox',

    // Desktop
    desktop: 'desktop',

    // Data curation
    data_curation: 'curation',

    // Documents
    doc: 'document',
    docx: 'document',
    report: 'document',
    convo_summary_doc: 'document',

    // Spreadsheets
    sheet: 'spreadsheet',
    spreadsheet: 'spreadsheet',
    xlsx: 'spreadsheet',
    excel: 'spreadsheet',
};

export function normalizeArtifactId(id: string, type?: ArtifactType | string): string {
    const trimmed = String(id || '').trim();
    if (!trimmed) return trimmed;
    if (CANVAS_ARTIFACT_ID_SET.has(trimmed)) {
        return trimmed;
    }

    const alias = ID_ALIASES[normalizeAliasKey(trimmed)];
    if (alias) return alias;

    const candidate = typeof type === 'string' ? type : trimmed;
    const mapped = TYPE_TO_CANVAS_ID[candidate as ArtifactType];
    return mapped ?? trimmed;
}
