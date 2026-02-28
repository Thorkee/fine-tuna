"use client";

import {
  buildMessageRow,
  type MessageStatus,
  type ReasoningSegment,
  type RenderBlock,
  type TraceSegment,
} from "@/lib/agent/message-row";

export type Chat = {
    id: string;
    title: string;
    created_at: string;
    user_id: string;
};

export type { MessageStatus, TraceSegment, ReasoningSegment, RenderBlock };

export type Message = {
    id: string;
    chat_id: string;
    role: 'user' | 'assistant';
    content: string;
    files?: AttachedFile[];
    status?: MessageStatus;
    reasoning_summary?: string;
    reasoning_segments?: ReasoningSegment[];
    trace_segments?: TraceSegment[];
    render_order?: RenderBlock[];
    created_at: string;
};

export type AgentRun = {
    id: string;
    chat_id: string;
    status: string;
    error?: string | null;
    created_at: string;
    updated_at: string;
};

export type AttachedFile = {
    id: string;
    name: string;
    size: number;
    mimeType?: string;
    storagePath?: string;
    uploadStatus?: 'uploading' | 'ready' | 'error';
    error?: string;
};

type ApiErrorPayload = { error?: unknown; code?: unknown };

function hasMeaningfulMessagePayload(body: Record<string, unknown>): boolean {
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (content) return true;

  const files = body.files;
  if (Array.isArray(files) && files.length > 0) return true;

  const status = body.status;
  if (status && typeof status === "object") {
    const phase = (status as { phase?: unknown }).phase;
    if (typeof phase === "string") return true;

    const events = (status as { events?: unknown }).events;
    if (Array.isArray(events) && events.length > 0) return true;
  }

  if (typeof body.reasoning_summary === "string" && body.reasoning_summary.trim()) return true;
  if (Array.isArray(body.reasoning_segments) && body.reasoning_segments.length > 0) return true;
  if (Array.isArray(body.trace_segments) && body.trace_segments.length > 0) return true;
  if (Array.isArray(body.render_order) && body.render_order.length > 0) return true;

  return false;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers,
  });

  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const payload: unknown = isJson ? await response.json().catch(() => null) : await response.text().catch(() => "");

  if (!response.ok) {
    const apiPayload = payload && typeof payload === "object" ? (payload as ApiErrorPayload) : null;
    const message =
      typeof apiPayload?.error === "string"
        ? apiPayload.error
        : `Request failed (${response.status})`;
    const error = new Error(message);
    if (typeof apiPayload?.code === "string") {
      (error as { code?: string }).code = apiPayload.code;
    }
    throw error;
  }

  return payload as T;
}

export const db = {
    async createChat(title: string, opts?: { id?: string }) {
        return await apiJson<Chat>("/api/chat", {
            method: "POST",
            body: JSON.stringify({ title, id: opts?.id }),
        });
    },

    async getChats() {
        return await apiJson<Chat[]>("/api/chat");
    },

    async getChat(chatId: string) {
        return await apiJson<Chat>(`/api/chat/${encodeURIComponent(chatId)}`);
    },

    async updateChatTitle(chatId: string, title: string) {
        return await apiJson<Chat>(`/api/chat/${encodeURIComponent(chatId)}`, {
            method: "PATCH",
            body: JSON.stringify({ title }),
        });
    },

    async deleteChat(chatId: string) {
        const response = await fetch(`/api/chat/${encodeURIComponent(chatId)}`, {
            method: 'DELETE',
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => null);
            const message =
                typeof payload?.error === 'string'
                    ? payload.error
                    : `Failed to delete chat (${response.status})`;
            const error = new Error(message);
            if (payload && typeof payload === 'object' && 'code' in payload) {
                const code = (payload as { code?: unknown }).code;
                if (typeof code === 'string') {
                    (error as { code?: string }).code = code;
                }
            }
            throw error;
        }
    },

    async addMessage(
        chatId: string,
        role: 'user' | 'assistant',
        content: string,
        files?: AttachedFile[],
        status?: MessageStatus,
        reasoningSummary?: string,
        reasoningSegments?: ReasoningSegment[],
        traceSegments?: TraceSegment[],
        renderOrder?: RenderBlock[],
        createdAt?: string
    ) {
        const row = buildMessageRow({
            chatId,
            role,
            content,
            files,
            status,
            reasoningSummary,
            reasoningSegments,
            traceSegments,
            renderOrder,
            createdAt,
        });
        return await apiJson<Message>(`/api/chat/${encodeURIComponent(chatId)}/messages`, {
            method: "POST",
            body: JSON.stringify(row),
        });
    },

    async upsertMessage(input: {
        id: string;
        chatId: string;
        role: 'user' | 'assistant';
        content: string;
        files?: AttachedFile[];
        status?: MessageStatus;
        reasoningSummary?: string;
        reasoningSegments?: ReasoningSegment[];
        traceSegments?: TraceSegment[];
        renderOrder?: RenderBlock[];
        createdAt?: string;
    }): Promise<Message | null> {
        const row = buildMessageRow({
            id: input.id,
            chatId: input.chatId,
            role: input.role,
            content: input.content,
            files: input.files,
            status: input.status,
            reasoningSummary: input.reasoningSummary,
            reasoningSegments: input.reasoningSegments,
            traceSegments: input.traceSegments,
            renderOrder: input.renderOrder,
            createdAt: input.createdAt,
        });
        if (!hasMeaningfulMessagePayload(row)) {
            return null;
        }
        return await apiJson<Message>(`/api/chat/${encodeURIComponent(input.chatId)}/messages`, {
            method: "PUT",
            body: JSON.stringify(row),
        });
    },

    async createRun(chatId: string, opts?: { id?: string }) {
        return await apiJson<AgentRun>(`/api/chat/${encodeURIComponent(chatId)}/runs`, {
            method: "POST",
            body: JSON.stringify({ id: opts?.id }),
        });
    },

    async updateRunStatus(runId: string, status: string, errorMessage?: string) {
        return await apiJson<AgentRun>(`/api/runs/${encodeURIComponent(runId)}`, {
            method: "PATCH",
            body: JSON.stringify({ status, error: errorMessage }),
        });
    },

    async getActiveRun(chatId: string) {
        return await apiJson<AgentRun | null>(`/api/chat/${encodeURIComponent(chatId)}/runs`);
    },

    async getMessages(chatId: string) {
        return await apiJson<Message[]>(`/api/chat/${encodeURIComponent(chatId)}/messages`);
    }
};
