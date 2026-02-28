import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { sanitizeMessagesForToolProtocol } from '../tool-protocol';

function assistantToolCall(id: string, name = 'test_tool'): Message {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name, arguments: '{}' },
      },
    ],
  };
}

function toolResult(id: string, name = 'test_tool'): Message {
  return {
    role: 'tool',
    tool_call_id: id,
    name,
    content: JSON.stringify({ ok: true }),
  };
}

describe('sanitizeMessagesForToolProtocol', () => {
  it('keeps complete tool exchange when followed by assistant', () => {
    const messages: Message[] = [
      assistantToolCall('tooluse_a'),
      toolResult('tooluse_a'),
      { role: 'assistant', content: 'Done.' },
    ];

    const out = sanitizeMessagesForToolProtocol(messages);

    expect(out).toHaveLength(3);
    expect(out[0]?.role).toBe('assistant');
    expect(out[1]?.role).toBe('tool');
    expect(out[2]?.role).toBe('assistant');
  });

  it('drops completed tool exchange when a user message interrupts before assistant response', () => {
    const messages: Message[] = [
      assistantToolCall('tooluse_a'),
      toolResult('tooluse_a'),
      { role: 'user', content: 'continue' },
    ];

    const out = sanitizeMessagesForToolProtocol(messages);

    expect(out).toEqual([{ role: 'user', content: 'continue' }]);
  });

  it('keeps only tool results that match expected tool_call ids', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'tooluse_a',
            type: 'function',
            function: { name: 'first_tool', arguments: '{}' },
          },
          {
            id: 'tooluse_b',
            type: 'function',
            function: { name: 'second_tool', arguments: '{}' },
          },
        ],
      },
      toolResult('tooluse_x', 'unexpected_tool'),
      toolResult('tooluse_a', 'first_tool'),
      toolResult('tooluse_a', 'first_tool'),
      toolResult('tooluse_b', 'second_tool'),
      { role: 'assistant', content: 'All set.' },
    ];

    const out = sanitizeMessagesForToolProtocol(messages);

    expect(out).toHaveLength(4);
    expect(out[0]?.role).toBe('assistant');
    expect(out[1]?.role).toBe('tool');
    expect(out[2]?.role).toBe('tool');
    expect((out[1] as Message).tool_call_id).toBe('tooluse_a');
    expect((out[2] as Message).tool_call_id).toBe('tooluse_b');
    expect(out[3]?.role).toBe('assistant');
  });

  it('drops dangling chained tool exchanges before a user interruption', () => {
    const messages: Message[] = [
      assistantToolCall('tooluse_a', 'first_tool'),
      toolResult('tooluse_a', 'first_tool'),
      assistantToolCall('tooluse_b', 'second_tool'),
      toolResult('tooluse_b', 'second_tool'),
      { role: 'user', content: 'try again' },
    ];

    const out = sanitizeMessagesForToolProtocol(messages);

    expect(out).toEqual([{ role: 'user', content: 'try again' }]);
  });
});

