import { describe, expect, it } from "vitest";

import { createStreamParser, type StreamMessageLike } from "../stream-parser";

function createHarness() {
  let message: StreamMessageLike = { content: "" };
  let idCounter = 0;
  const parser = createStreamParser<StreamMessageLike>({
    updateAssistant: (updater) => {
      message = updater(message);
    },
    updateReasoningOwner: (updater) => {
      message = updater(message);
    },
    createId: () => `segment-${++idCounter}`,
  });
  return {
    parser,
    getMessage: () => message,
  };
}

describe("stream parser trace routing", () => {
  it("keeps answer content empty for TRACE-only streams until finalization", () => {
    const { parser, getMessage } = createHarness();

    parser.appendContentDelta("TRACE: checking files\n");
    parser.flushStreamBuffer();
    parser.closeActiveTraceSegment();

    const message = getMessage();
    expect(message.content).toBe("");
    expect(message.traceSegments?.length).toBe(1);
    expect(message.traceSegments?.[0]?.text).toBe("checking files");
  });

  it("promotes the final trace segment into answer content when enabled", () => {
    const { parser, getMessage } = createHarness();

    parser.appendContentDelta("TRACE: final answer from trace\n");
    parser.flushStreamBuffer();
    parser.closeActiveTraceSegment();
    parser.promoteFinalTraceSegment({ promote: true });

    const message = getMessage();
    expect(message.content).toBe("final answer from trace");
    expect(message.traceSegments).toBeUndefined();
  });

  it("keeps trace separate from answer when promotion is disabled", () => {
    const { parser, getMessage } = createHarness();

    parser.appendContentDelta("TRACE: keep this in trace\n");
    parser.flushStreamBuffer();
    parser.closeActiveTraceSegment();
    parser.promoteFinalTraceSegment({ promote: false });

    const message = getMessage();
    expect(message.content).toBe("");
    expect(message.traceSegments?.length).toBe(1);
    expect(message.traceSegments?.[0]?.text).toBe("keep this in trace");
  });

  it("auto-promotes trace to answer when called with no options and answer is empty", () => {
    const { parser, getMessage } = createHarness();

    parser.appendContentDelta("TRACE: this should become the answer\n");
    parser.flushStreamBuffer();
    parser.closeActiveTraceSegment();
    parser.promoteFinalTraceSegment();

    const message = getMessage();
    expect(message.content).toBe("this should become the answer");
    expect(message.traceSegments).toBeUndefined();
  });

  it("does not auto-promote trace when answer already has content", () => {
    const { parser, getMessage } = createHarness();

    parser.appendContentDelta("Here is my answer.\n");
    parser.appendContentDelta("TRACE: some progress note\n");
    parser.flushStreamBuffer();
    parser.closeActiveTraceSegment();
    parser.promoteFinalTraceSegment();

    const message = getMessage();
    expect(message.content).toContain("Here is my answer.");
    expect(message.traceSegments?.length).toBe(1);
    expect(message.traceSegments?.[0]?.text).toBe("some progress note");
  });

  it("routes unprefixed text as answer content by default", () => {
    const { parser, getMessage } = createHarness();

    parser.appendContentDelta("Hello, this is a normal response.\n");
    parser.flushStreamBuffer();

    const message = getMessage();
    expect(message.content).toContain("Hello, this is a normal response.");
    expect(message.traceSegments).toBeUndefined();
  });

  it("FINAL: marker switches from trace back to answer mode", () => {
    const { parser, getMessage } = createHarness();

    parser.appendContentDelta("TRACE: reading files\n");
    parser.appendContentDelta("FINAL: Here is the result.\n");
    parser.flushStreamBuffer();

    const message = getMessage();
    expect(message.content).toContain("Here is the result.");
    expect(message.traceSegments?.length).toBe(1);
  });
});
