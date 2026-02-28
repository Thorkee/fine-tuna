"use client";

import { createContext, useContext } from "react";

const ArtifactScopeContext = createContext<string | null>(null);
const ArtifactChatIdContext = createContext<string | null>(null);

export function ArtifactScopeProvider(props: {
  scopeId?: string | null;
  chatId?: string | null;
  children: React.ReactNode;
}) {
  const { scopeId, chatId, children } = props;
  return (
    <ArtifactScopeContext.Provider value={scopeId ?? null}>
      <ArtifactChatIdContext.Provider value={chatId ?? null}>
        {children}
      </ArtifactChatIdContext.Provider>
    </ArtifactScopeContext.Provider>
  );
}

export function useArtifactScopeId(): string | null {
  return useContext(ArtifactScopeContext);
}

export function useArtifactChatId(): string | null {
  return useContext(ArtifactChatIdContext);
}
