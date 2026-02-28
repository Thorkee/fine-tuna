import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
    return NextResponse.json({
        ok: true,
        service: 'tuna-app',
        llmProvider: (process.env.TUNA_LLM_PROVIDER || 'aws_bedrock').trim() || 'aws_bedrock',
        timestamp: new Date().toISOString(),
    });
}
