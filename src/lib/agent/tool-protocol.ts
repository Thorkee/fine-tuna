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

  const dropTrailingToolExchange = () => {
    if (out.length === 0) return;
    // Drop trailing tool messages.
    while (out.length > 0 && out[out.length - 1]?.role === 'tool') {
      out.pop();
    }
    // If those tool messages belonged to a preceding assistant(tool_calls), drop it too.
    const last = out[out.length - 1];
    if (last && hasAssistantToolCalls(last)) {
      out.pop();
    }
  };

  const flushPending = (nextRole?: Message['role']) => {
    if (!pendingAssistant) return;

    const required = requiredIds ?? new Set<string>();
    const hasRequired = required.size > 0;
    const hasAnyTool = toolMessages.length > 0;
    const satisfiesAll =
      !hasRequired || Array.from(required).every(id => seenToolIds.has(id));
    const followedByNonAssistant = typeof nextRole === 'string' && nextRole !== 'assistant';

    // Bedrock requires the assistant response immediately after tool results.
    // If a user/system message appears before that assistant response, drop the
    // whole tool exchange so the history remains replayable. Also drop any
    // trailing prior tool exchange that would now end directly before user/system.
    if (hasAnyTool && satisfiesAll && !followedByNonAssistant) {
      out.push(pendingAssistant, ...toolMessages);
    } else if (followedByNonAssistant) {
      dropTrailingToolExchange();
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
          const id = m.tool_call_id;
          // If assistant tool_call ids are known, keep only matching tool results.
          if (requiredIds && requiredIds.size > 0 && !requiredIds.has(id)) {
            continue;
          }
          // Dedupe repeated tool results for the same id.
          if (seenToolIds.has(id)) continue;
          toolMessages.push(m);
          seenToolIds.add(id);
        }
        // Drop tool messages without ids; they can't be safely associated.
        continue;
      }

      // Any non-tool message ends the tool block.
      flushPending(m.role);
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

