import type { Message } from '@/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasAssistantToolCalls(m: Message): boolean {
  return m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
}

function extractToolCallIds(toolCalls: unknown[]): string[] {
  const ids: string[] = [];
  for (const call of toolCalls) {
    if (isRecord(call) && typeof call.id === 'string' && call.id.trim()) {
      ids.push(call.id);
    }
  }
  return ids;
}

/**
 * Sanitize message history to obey OpenAI/Azure tool-call protocol.
 *
 * Rules enforced:
 * - `tool` messages may only appear after an `assistant` message containing `tool_calls`.
 * - An `assistant` message with `tool_calls` must be followed by tool responses (and, when ids
 *   are available, all tool_call ids must be satisfied) before any other role appears.
 *
 * Any incomplete/orphaned tool exchange is dropped.
 */
export function sanitizeMessagesForToolProtocol(messages: Message[]): Message[] {
  const out: Message[] = [];

  let pendingAssistant: Message | null = null;
  let requiredIds: Set<string> | null = null;
  let toolMessages: Message[] = [];
  let seenToolIds = new Set<string>();

  const flushPending = () => {
    if (!pendingAssistant) return;

    const required = requiredIds ?? new Set<string>();
    const hasRequired = required.size > 0;
    const hasAnyTool = toolMessages.length > 0;
    const satisfiesAll =
      !hasRequired || Array.from(required).every(id => seenToolIds.has(id));

    if (hasAnyTool && satisfiesAll) {
      out.push(pendingAssistant, ...toolMessages);
    }

    pendingAssistant = null;
    requiredIds = null;
    toolMessages = [];
    seenToolIds = new Set<string>();
  };

  for (const m of messages) {
    if (pendingAssistant) {
      if (m.role === 'tool') {
        // tool_call_id is required by the tool-call protocol.
        if (typeof m.tool_call_id === 'string' && m.tool_call_id.trim()) {
          toolMessages.push(m);
          seenToolIds.add(m.tool_call_id);
        }
        // Drop tool messages without ids; they can't be safely associated.
        continue;
      }

      // Any non-tool message ends the tool block.
      flushPending();
    }

    if (m.role === 'tool') {
      // Orphan tool message — drop.
      continue;
    }

    if (hasAssistantToolCalls(m)) {
      pendingAssistant = m;
      requiredIds = new Set(extractToolCallIds(m.tool_calls ?? []));
      toolMessages = [];
      seenToolIds = new Set<string>();
      continue;
    }

    out.push(m);
  }

  flushPending();
  return out;
}

/**
 * Group messages into blocks that preserve tool-call sequencing:
 * - assistant(tool_calls)+tool(...) messages are one block
 * - everything else is a single-message block
 */
export function chunkMessagesForToolProtocol(messages: Message[]): Message[][] {
  const blocks: Message[][] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (hasAssistantToolCalls(m)) {
      const block: Message[] = [m];
      i += 1;
      while (i < messages.length && messages[i]!.role === 'tool') {
        block.push(messages[i]!);
        i += 1;
      }
      blocks.push(block);
      continue;
    }

    // Tool messages should not appear here when sanitized, but keep a defensive block.
    blocks.push([m]);
    i += 1;
  }
  return blocks;
}

export function flattenMessageBlocks(blocks: Message[][]): Message[] {
  const out: Message[] = [];
  for (const block of blocks) out.push(...block);
  return out;
}

