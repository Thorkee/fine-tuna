"use client";

import { useMemo } from "react";

import ArtifactLoadingState from "@/app/components/ui/ArtifactLoadingState";

import { useProjectArtifacts } from "@/lib/hooks/useProjectArtifacts";
import ClarificationCard, {
  isClarificationPayload,
  type ClarificationPayload,
  type ClarificationResponseState,
} from "@/app/components/ui/ClarificationCard";

type ClarificationArtifactData = ClarificationPayload & {
  response?: ClarificationResponseState;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type ClarificationArtifactProps = {
  artifactId: string;
  onSend: (response: string) => void;
  disabled?: boolean;
};

export default function ClarificationArtifact({
  artifactId,
  onSend,
  disabled,
}: ClarificationArtifactProps) {
  const { artifacts, addArtifact } = useProjectArtifacts();
  const artifact = useMemo(() => artifacts.find((a) => a.id === artifactId), [artifacts, artifactId]);

  if (!artifact) {
    return (
      <ArtifactLoadingState
        title="Preparing clarification..."
        description="This should only take a moment."
        className="p-2 sm:p-3"
      />
    );
  }

  if (!isClarificationPayload(artifact.data)) {
    return (
      <div className="p-4 text-sm text-zinc-500 dark:text-zinc-400">
        Clarification details are not available.
      </div>
    );
  }

  const data = artifact.data as ClarificationArtifactData;
  const response = isRecord(data.response) ? (data.response as ClarificationResponseState) : undefined;
  const responseKey = response?.answeredAt ?? "unanswered";
  const isLocked = Boolean(response?.answeredAt);

  const handleRecordResponse = (state: ClarificationResponseState) => {
    addArtifact({
      id: artifactId,
      type: "clarification",
      data: { ...(data as ClarificationPayload), response: state },
    });
  };

  return (
    <div className="p-2 sm:p-3 animate-fade-in-up">
      <ClarificationCard
        key={`${artifactId}:${responseKey}`}
        payload={data as ClarificationPayload}
        disabled={disabled || isLocked}
        onSend={onSend}
        onRecordResponse={handleRecordResponse}
        initialAnswers={response?.answers}
        initialCustomAnswers={response?.customAnswers}
        initialNotes={response?.notes}
      />
    </div>
  );
}
