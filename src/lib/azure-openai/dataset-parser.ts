// Dataset Parsing & Understanding Service
// Handles: multi-format support, schema inference, unstandardized data, reformatting for training

import type { ProjectContext, ColumnSchema, FileFormat } from '@/types';
import { getConfiguredLlmProvider } from '@/lib/llm/provider';
import { getLlmRuntime } from '@/lib/llm/runtime';

// ============= Types =============

export interface ParsedDataset {
    id: string;
    originalName: string;
    format: FileFormat;
    schema: InferredSchema;
    statistics: DatasetStatistics;
    quality: DataQualityAssessment;
    samples: Record<string, unknown>[];
    issues: DataIssue[];
    recommendations: string[];
}

export interface InferredSchema {
    columns: ColumnDefinition[];
    primaryKey?: string;
    relationships: ColumnRelationship[];
    inferredIntent?: string; // What this data might be for
}

export interface ColumnDefinition {
    name: string;
    originalName: string; // In case we renamed it
    type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'array' | 'unknown';
    semanticType?: 'id' | 'label' | 'text' | 'category' | 'timestamp' | 'numeric_feature' | 'embedding';
    nullable: boolean;
    uniqueRatio: number; // 0-1, ratio of unique values
    sampleValues: string[];
    distribution?: {
        type: 'uniform' | 'normal' | 'skewed' | 'categorical';
        stats?: Record<string, number>;
    };
}

export interface ColumnRelationship {
    from: string;
    to: string;
    type: 'one-to-one' | 'one-to-many' | 'many-to-many';
    joinKey?: boolean;
}

export interface DatasetStatistics {
    rowCount: number;
    columnCount: number;
    sizeBytes: number;
    nullPercentage: number;
    duplicateRows: number;
    textStats?: {
        avgLength: number;
        maxLength: number;
        minLength: number;
        languages: string[];
    };
}

export interface DataQualityAssessment {
    overallScore: number; // 0-100
    completeness: number; // % of non-null values
    consistency: number; // Format uniformity
    accuracy: number; // Detected anomalies
    timeliness: number; // If timestamps, how recent
    issues: DataIssue[];
    usableForTraining: boolean;
    recommendedActions: string[];
}

export interface DataIssue {
    id: string;
    severity: 'critical' | 'warning' | 'info';
    type: 'missing_values' | 'format_inconsistency' | 'encoding' | 'duplicates' | 'outliers' | 'imbalance' | 'schema_mismatch';
    column?: string;
    description: string;
    affectedRows: number;
    suggestedFix: string;
    autoFixable: boolean;
}

export interface MergeStrategy {
    type: 'concat' | 'join' | 'union';
    joinKeys?: string[];
    conflictResolution: 'keep_first' | 'keep_last' | 'merge' | 'ask_user';
    schemaAlignment: AlignmentAction[];
}

export interface AlignmentAction {
    action: 'rename' | 'convert' | 'drop' | 'add' | 'fill';
    column: string;
    details: Record<string, unknown>;
}

export interface TrainingDataset {
    format: 'jsonl' | 'csv' | 'parquet';
    schema: {
        inputColumn: string;
        outputColumn: string;
        metadataColumns?: string[];
    };
    splits: {
        train: string; // S3 path
        validation: string;
        test: string;
    };
    statistics: {
        totalSamples: number;
        trainSamples: number;
        valSamples: number;
        testSamples: number;
        avgTokenLength?: number;
    };
}

// ============= Schema Inference =============

const SCHEMA_INFERENCE_FUNCTION = {
    name: 'infer_dataset_schema',
    description: 'Analyze dataset samples and infer comprehensive schema',
    parameters: {
        type: 'object' as const,
        properties: {
            columns: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        type: { type: 'string', enum: ['string', 'number', 'boolean', 'date', 'json', 'array', 'unknown'] },
                        semanticType: { type: 'string', enum: ['id', 'label', 'text', 'category', 'timestamp', 'numeric_feature', 'embedding'] },
                        isNullable: { type: 'boolean' },
                        description: { type: 'string' },
                    },
                },
            },
            primaryKey: { type: 'string' },
            inferredIntent: { type: 'string', description: 'What this dataset seems to be for' },
            dataQualityIssues: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        column: { type: 'string' },
                        issue: { type: 'string' },
                        severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
                        suggestedFix: { type: 'string' },
                    },
                },
            },
            recommendedLabelColumn: { type: 'string' },
            recommendedFeatureColumns: { type: 'array', items: { type: 'string' } },
        },
        required: ['columns', 'inferredIntent'],
    },
};

/**
 * Infer schema from dataset samples using LLM
 */
export async function inferSchema(
    samples: Record<string, unknown>[],
    filename: string,
    context: ProjectContext
): Promise<InferredSchema> {
    const prompt = `
Analyze this dataset and infer its schema.

Filename: ${filename}
Sample rows (first 5):
${JSON.stringify(samples.slice(0, 5), null, 2)}

For each column, determine:
1. The data type (string, number, boolean, date, json, array)
2. The semantic meaning (id, label, text, category, timestamp, numeric_feature)
3. Whether it could be a label/target for ML training
4. Any quality issues you notice

Also infer:
- What this dataset is likely used for
- Which column would be the best label/target
- Which columns are good features
`;

    try {
        const llm = getLlmRuntime(getConfiguredLlmProvider());
        const result = await llm.functionCall(
            [{ role: 'user', content: prompt }],
            [SCHEMA_INFERENCE_FUNCTION],
            context
        );

        const args = result.arguments as Record<string, unknown>;
        const columns = (args.columns as Array<Record<string, unknown>>).map(col => ({
            name: col.name as string,
            originalName: col.name as string,
            type: col.type as ColumnDefinition['type'],
            semanticType: col.semanticType as ColumnDefinition['semanticType'],
            nullable: col.isNullable as boolean ?? false,
            uniqueRatio: 0, // Will be calculated separately
            sampleValues: [],
        }));

        return {
            columns,
            primaryKey: args.primaryKey as string | undefined,
            relationships: [],
            inferredIntent: args.inferredIntent as string,
        };
    } catch (error) {
        console.error('Schema inference error:', error);
        throw error;
    }
}

// ============= Multi-Dataset Processing =============

/**
 * Analyze multiple datasets and determine merge strategy
 */
export async function analyzeMultipleDatasets(
    datasets: ParsedDataset[],
    context: ProjectContext
): Promise<{
    canMerge: boolean;
    strategy?: MergeStrategy;
    conflicts: string[];
    recommendations: string[];
}> {
    if (datasets.length === 1) {
        return {
            canMerge: true,
            strategy: undefined,
            conflicts: [],
            recommendations: [],
        };
    }

    const prompt = `
Analyze these ${datasets.length} datasets and determine how to merge them:

${datasets.map((d, i) => `
Dataset ${i + 1}: ${d.originalName}
- Columns: ${d.schema.columns.map(c => `${c.name}(${c.type})`).join(', ')}
- Rows: ${d.statistics.rowCount}
- Inferred purpose: ${d.schema.inferredIntent || 'unknown'}
`).join('\n')}

Determine:
1. Can these datasets be merged? If so, how?
2. What join keys should be used?
3. How to handle schema differences?
4. Any conflicts that need user resolution?
`;

    try {
        const llm = getLlmRuntime(getConfiguredLlmProvider());
        const response = await llm.chat(
            [{ role: 'user', content: prompt }],
            context,
            { temperature: 0.3 }
        );

        // Parse the response for merge strategy
        // In production, use structured output
        const canMerge = !response.toLowerCase().includes('cannot be merged');

        return {
            canMerge,
            strategy: canMerge ? {
                type: 'join',
                conflictResolution: 'ask_user',
                schemaAlignment: [],
            } : undefined,
            conflicts: [],
            recommendations: [response],
        };
    } catch (error) {
        console.error('Multi-dataset analysis error:', error);
        throw error;
    }
}

// ============= Data Quality Assessment =============

/**
 * Comprehensive data quality assessment
 */
export function assessDataQuality(
    samples: Record<string, unknown>[],
    schema: InferredSchema
): DataQualityAssessment {
    const issues: DataIssue[] = [];
    let completeness = 100;
    let consistency = 100;

    // Check for missing values
    for (const col of schema.columns) {
        const nullCount = samples.filter(s => s[col.name] === null || s[col.name] === undefined || s[col.name] === '').length;
        const nullRatio = nullCount / samples.length;

        if (nullRatio > 0.1) {
            issues.push({
                id: `missing_${col.name}`,
                severity: nullRatio > 0.5 ? 'critical' : 'warning',
                type: 'missing_values',
                column: col.name,
                description: `${(nullRatio * 100).toFixed(1)}% missing values`,
                affectedRows: nullCount,
                suggestedFix: nullRatio > 0.5 ? 'Drop column or impute' : 'Impute with median/mode',
                autoFixable: nullRatio < 0.3,
            });
            completeness -= nullRatio * 10;
        }
    }

    // Check for duplicates
    const uniqueRows = new Set(samples.map(s => JSON.stringify(s))).size;
    const duplicateRatio = 1 - (uniqueRows / samples.length);
    if (duplicateRatio > 0.05) {
        issues.push({
            id: 'duplicate_rows',
            severity: duplicateRatio > 0.2 ? 'critical' : 'warning',
            type: 'duplicates',
            description: `${(duplicateRatio * 100).toFixed(1)}% duplicate rows`,
            affectedRows: samples.length - uniqueRows,
            suggestedFix: 'Remove duplicate rows',
            autoFixable: true,
        });
        consistency -= duplicateRatio * 20;
    }

    // Check class imbalance for label columns
    const labelCol = schema.columns.find(c => c.semanticType === 'label');
    if (labelCol) {
        const valueCounts: Record<string, number> = {};
        samples.forEach(s => {
            const val = String(s[labelCol.name] || 'null');
            valueCounts[val] = (valueCounts[val] || 0) + 1;
        });

        const counts = Object.values(valueCounts);
        const maxCount = Math.max(...counts);
        const minCount = Math.min(...counts);
        const imbalanceRatio = maxCount / minCount;

        if (imbalanceRatio > 5) {
            issues.push({
                id: 'class_imbalance',
                severity: imbalanceRatio > 10 ? 'critical' : 'warning',
                type: 'imbalance',
                column: labelCol.name,
                description: `Class imbalance ratio: ${imbalanceRatio.toFixed(1)}:1`,
                affectedRows: samples.length,
                suggestedFix: 'Apply oversampling, undersampling, or class weights',
                autoFixable: true,
            });
        }
    }

    const overallScore = Math.max(0, Math.min(100, (completeness + consistency) / 2));

    return {
        overallScore,
        completeness: Math.max(0, completeness),
        consistency: Math.max(0, consistency),
        accuracy: 100 - issues.filter(i => i.severity === 'critical').length * 10,
        timeliness: 100, // Would need timestamp analysis
        issues,
        usableForTraining: overallScore >= 60 && !issues.some(i => i.severity === 'critical'),
        recommendedActions: issues.map(i => i.suggestedFix),
    };
}

// ============= Training Format Conversion =============

/**
 * Convert dataset to training format (JSONL with instruction/input/output)
 */
export async function convertToTrainingFormat(
    dataset: ParsedDataset,
    config: {
        inputColumns: string[];
        outputColumn: string;
        instructionTemplate?: string;
        trainRatio?: number;
        valRatio?: number;
        testRatio?: number;
    },
    context: ProjectContext
): Promise<{
    trainData: Record<string, unknown>[];
    valData: Record<string, unknown>[];
    testData: Record<string, unknown>[];
    format: 'instruction' | 'completion' | 'chat';
}> {
    const { inputColumns, outputColumn, instructionTemplate, trainRatio = 0.8, valRatio = 0.1, testRatio = 0.1 } = config;

    // Shuffle samples
    const shuffled = [...dataset.samples].sort(() => Math.random() - 0.5);

    // Split
    const trainEnd = Math.floor(shuffled.length * trainRatio);
    const valEnd = trainEnd + Math.floor(shuffled.length * valRatio);

    const trainSamples = shuffled.slice(0, trainEnd);
    const valSamples = shuffled.slice(trainEnd, valEnd);
    const testSamples = shuffled.slice(valEnd);

    // Convert to instruction format
    const template = instructionTemplate || `Given the following information:\n{input}\n\nProvide the {output_type}:`;

    const convertSample = (sample: Record<string, unknown>) => {
        const inputText = inputColumns.map(col => `${col}: ${sample[col]}`).join('\n');
        const instruction = template
            .replace('{input}', inputText)
            .replace('{output_type}', outputColumn);

        return {
            instruction,
            input: '',
            output: String(sample[outputColumn] || ''),
        };
    };

    return {
        trainData: trainSamples.map(convertSample),
        valData: valSamples.map(convertSample),
        testData: testSamples.map(convertSample),
        format: 'instruction',
    };
}

// ============= Auto-Cleaning =============

/**
 * Apply automatic fixes for data issues
 */
export function applyAutoFixes(
    samples: Record<string, unknown>[],
    issues: DataIssue[]
): {
    cleanedSamples: Record<string, unknown>[];
    appliedFixes: string[];
    remainingIssues: DataIssue[];
} {
    const cleanedSamples = [...samples];
    const appliedFixes: string[] = [];
    const remainingIssues: DataIssue[] = [];

    for (const issue of issues) {
        if (!issue.autoFixable) {
            remainingIssues.push(issue);
            continue;
        }

        switch (issue.type) {
            case 'duplicates':
                // Remove duplicates
                const seen = new Set<string>();
                const deduped = cleanedSamples.filter(s => {
                    const key = JSON.stringify(s);
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
                if (deduped.length < cleanedSamples.length) {
                    cleanedSamples.length = 0;
                    cleanedSamples.push(...deduped);
                    appliedFixes.push(`Removed ${samples.length - deduped.length} duplicate rows`);
                }
                break;

            case 'missing_values':
                // Fill with mode for categorical, median for numeric
                if (issue.column) {
                    const values = cleanedSamples
                        .map(s => s[issue.column!])
                        .filter(v => v !== null && v !== undefined && v !== '');

                    if (values.length > 0) {
                        // Simple mode/median calculation
                        const fillValue = typeof values[0] === 'number'
                            ? values.sort((a, b) => (a as number) - (b as number))[Math.floor(values.length / 2)]
                            : values.sort((a, b) =>
                                values.filter(v => v === b).length - values.filter(v => v === a).length
                            )[0];

                        let fillCount = 0;
                        cleanedSamples.forEach(s => {
                            if (s[issue.column!] === null || s[issue.column!] === undefined || s[issue.column!] === '') {
                                s[issue.column!] = fillValue;
                                fillCount++;
                            }
                        });

                        if (fillCount > 0) {
                            appliedFixes.push(`Filled ${fillCount} missing values in ${issue.column} with ${fillValue}`);
                        }
                    }
                }
                break;

            default:
                remainingIssues.push(issue);
        }
    }

    return {
        cleanedSamples,
        appliedFixes,
        remainingIssues,
    };
}
