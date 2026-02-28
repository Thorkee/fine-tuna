"use client";

import { useCallback, useMemo } from "react";

import { useArtifactScopeId } from "@/lib/artifact-scope";
import {
  DEFAULT_SANDBOX_CODE,
  resolveArtifactScopeId,
  useProjectStore,
} from "@/lib/store";

const EMPTY_ARTIFACTS: { id: string; type: string; data: unknown }[] = [];

export function useProjectArtifacts(scopeId?: string | null) {
  const contextScopeId = useArtifactScopeId();
  const resolvedScopeId = useMemo(
    () => resolveArtifactScopeId(scopeId ?? contextScopeId),
    [contextScopeId, scopeId]
  );

  const activeArtifact = useProjectStore(
    (s) => s.artifactStateByScope[resolvedScopeId]?.activeArtifact ?? null
  );
  const artifacts = useProjectStore(
    (s) => s.artifactStateByScope[resolvedScopeId]?.artifacts ?? EMPTY_ARTIFACTS
  );
  const sandboxCode = useProjectStore(
    (s) => s.artifactStateByScope[resolvedScopeId]?.sandboxCode ?? DEFAULT_SANDBOX_CODE
  );

  const setActiveArtifact = useProjectStore((s) => s.setActiveArtifact);
  const addArtifact = useProjectStore((s) => s.addArtifact);
  const clearArtifacts = useProjectStore((s) => s.clearArtifacts);
  const setSandboxCode = useProjectStore((s) => s.setSandboxCode);

  const setActiveArtifactForScope = useCallback(
    (id: string | null) => setActiveArtifact(resolvedScopeId, id),
    [resolvedScopeId, setActiveArtifact]
  );
  const addArtifactForScope = useCallback(
    (artifact: { id: string; type: string; data: unknown }) =>
      addArtifact(resolvedScopeId, artifact),
    [addArtifact, resolvedScopeId]
  );
  const clearArtifactsForScope = useCallback(
    () => clearArtifacts(resolvedScopeId),
    [clearArtifacts, resolvedScopeId]
  );
  const setSandboxCodeForScope = useCallback(
    (code: string) => setSandboxCode(resolvedScopeId, code),
    [resolvedScopeId, setSandboxCode]
  );

  return {
    scopeId: resolvedScopeId,
    activeArtifact,
    artifacts,
    sandboxCode,
    setActiveArtifact: setActiveArtifactForScope,
    addArtifact: addArtifactForScope,
    clearArtifacts: clearArtifactsForScope,
    setSandboxCode: setSandboxCodeForScope,
  };
}
