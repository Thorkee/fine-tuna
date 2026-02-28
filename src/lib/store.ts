// Global state management using Zustand
// Manages project context and UI state

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
    ProjectContext,
    ProjectMode,
    UploadedFile,
    Message,
    ProviderOption,
    TrainingMetrics,
} from '@/types';

// ============= Project Store =============

type ArtifactRecord = { id: string; type: string; data: unknown };

type ArtifactScopeState = {
    activeArtifact: string | null;
    artifacts: ArtifactRecord[];
    sandboxCode: string;
};

export const DEFAULT_SANDBOX_CODE = "print('Hello, World!')";
export const DEFAULT_ARTIFACT_SCOPE_ID = "default";

export function resolveArtifactScopeId(scopeId?: string | null): string {
    if (typeof scopeId !== "string") return DEFAULT_ARTIFACT_SCOPE_ID;
    const trimmed = scopeId.trim();
    return trimmed ? trimmed : DEFAULT_ARTIFACT_SCOPE_ID;
}

const createArtifactScopeState = (overrides?: Partial<ArtifactScopeState>): ArtifactScopeState => ({
    activeArtifact: null,
    artifacts: [],
    sandboxCode: DEFAULT_SANDBOX_CODE,
    ...overrides,
});

const isArtifactStateEmpty = (state?: ArtifactScopeState) => {
    if (!state) return true;
    if (state.activeArtifact) return false;
    if (state.artifacts.length > 0) return false;
    return state.sandboxCode === DEFAULT_SANDBOX_CODE;
};

interface ProjectState {
    // Current project
    currentProject: ProjectContext | null;

    // UI State
    currentStep: number;
    isAnimating: boolean;
    mode: ProjectMode;

    // Artifact State (scoped per chat/share)
    artifactStateByScope: Record<string, ArtifactScopeState>;

    // Actions
    setProject: (project: ProjectContext) => void;
    updateDataContext: (files: UploadedFile[]) => void;
    updateEDAContext: (eda: ProjectContext['edaContext']) => void;
    updateGoalContext: (goal: ProjectContext['goalContext']) => void;
    updateProviderContext: (provider: ProjectContext['providerContext']) => void;
    updateTrainingContext: (training: ProjectContext['trainingContext']) => void;

    setCurrentStep: (step: number) => void;
    setIsAnimating: (animating: boolean) => void;
    setMode: (mode: ProjectMode) => void;

    // Artifact Actions
    setActiveArtifact: (scopeId: string, id: string | null) => void;
    addArtifact: (scopeId: string, artifact: ArtifactRecord) => void;
    clearArtifacts: (scopeId: string) => void;
    setSandboxCode: (scopeId: string, code: string) => void;
    migrateArtifactScope: (
        fromScopeId: string,
        toScopeId: string,
        options?: { onlyIfTargetEmpty?: boolean; clearSource?: boolean }
    ) => void;

    resetProject: () => void;
}

const initialProject: ProjectContext = {
    projectId: '',
    userId: '',
    mode: 'own_data',
    createdAt: new Date(),
    dataContext: null,
    edaContext: null,
    goalContext: null,
    preparationContext: null,
    providerContext: null,
    trainingContext: null,
    exportContext: null,
};

export const useProjectStore = create<ProjectState>()(
    persist(
        (set) => ({
            currentProject: null,
            currentStep: 1,
            isAnimating: false,
            mode: 'own_data',
            artifactStateByScope: {},

            setProject: (project) => set({ currentProject: project }),

            updateDataContext: (files) => set((state) => ({
                currentProject: state.currentProject ? {
                    ...state.currentProject,
                    dataContext: {
                        files,
                        totalRows: files.reduce((acc, f) => acc + (f.size / 100), 0), // Estimate
                        totalSize: files.reduce((acc, f) => acc + f.size, 0),
                        formats: [...new Set(files.map(f => f.format))],
                    },
                } : null,
            })),

            updateEDAContext: (eda) => set((state) => ({
                currentProject: state.currentProject ? {
                    ...state.currentProject,
                    edaContext: eda,
                } : null,
            })),

            updateGoalContext: (goal) => set((state) => ({
                currentProject: state.currentProject ? {
                    ...state.currentProject,
                    goalContext: goal,
                } : null,
            })),

            updateProviderContext: (provider) => set((state) => ({
                currentProject: state.currentProject ? {
                    ...state.currentProject,
                    providerContext: provider,
                } : null,
            })),

            updateTrainingContext: (training) => set((state) => ({
                currentProject: state.currentProject ? {
                    ...state.currentProject,
                    trainingContext: training,
                } : null,
            })),

            setCurrentStep: (step) => set({ currentStep: step }),
            setIsAnimating: (animating) => set({ isAnimating: animating }),
            setMode: (mode) => set({ mode }),

            setActiveArtifact: (scopeId, id) => set((state) => {
                const resolvedScopeId = resolveArtifactScopeId(scopeId);
                const prev = state.artifactStateByScope[resolvedScopeId] ?? createArtifactScopeState();
                return {
                    artifactStateByScope: {
                        ...state.artifactStateByScope,
                        [resolvedScopeId]: { ...prev, activeArtifact: id },
                    },
                };
            }),
            addArtifact: (scopeId, artifact) => set((state) => {
                const resolvedScopeId = resolveArtifactScopeId(scopeId);
                const prev = state.artifactStateByScope[resolvedScopeId] ?? createArtifactScopeState();
                // Check if artifact already exists to update it or add new
                const exists = prev.artifacts.find(a => a.id === artifact.id);
                const nextArtifacts = exists
                    ? prev.artifacts.map(a => a.id === artifact.id ? artifact : a)
                    : [...prev.artifacts, artifact];
                return {
                    artifactStateByScope: {
                        ...state.artifactStateByScope,
                        [resolvedScopeId]: { ...prev, artifacts: nextArtifacts },
                    },
                };
            }),
            clearArtifacts: (scopeId) => set((state) => {
                const resolvedScopeId = resolveArtifactScopeId(scopeId);
                const prev = state.artifactStateByScope[resolvedScopeId] ?? createArtifactScopeState();
                return {
                    artifactStateByScope: {
                        ...state.artifactStateByScope,
                        [resolvedScopeId]: { ...prev, activeArtifact: null, artifacts: [] },
                    },
                };
            }),

            setSandboxCode: (scopeId, code) => set((state) => {
                const resolvedScopeId = resolveArtifactScopeId(scopeId);
                const prev = state.artifactStateByScope[resolvedScopeId] ?? createArtifactScopeState();
                return {
                    artifactStateByScope: {
                        ...state.artifactStateByScope,
                        [resolvedScopeId]: { ...prev, sandboxCode: code },
                    },
                };
            }),
            migrateArtifactScope: (fromScopeId, toScopeId, options) => set((state) => {
                const resolvedFrom = resolveArtifactScopeId(fromScopeId);
                const resolvedTo = resolveArtifactScopeId(toScopeId);
                if (resolvedFrom === resolvedTo) return {};
                const from = state.artifactStateByScope[resolvedFrom];
                if (!from) return {};
                const to = state.artifactStateByScope[resolvedTo];
                const onlyIfTargetEmpty = options?.onlyIfTargetEmpty ?? true;
                if (onlyIfTargetEmpty && !isArtifactStateEmpty(to)) return {};
                const nextByScope = { ...state.artifactStateByScope, [resolvedTo]: from };
                if (options?.clearSource !== false) {
                    delete nextByScope[resolvedFrom];
                }
                return { artifactStateByScope: nextByScope };
            }),

            resetProject: () => set({
                currentProject: { ...initialProject, projectId: crypto.randomUUID() },
                currentStep: 1,
                artifactStateByScope: {},
            }),
        }),
        {
            name: 'tuna-project',
            version: 2,
            migrate: (persistedState, version) => {
                // v1 persisted chat/canvas-specific state (artifacts, activeArtifact, sandboxCode),
                // which caused cross-chat leakage (e.g. opening a "new chat" could rehydrate the
                // previous chat's canvas). From v2 onward we only persist project-level fields.
                const state = (persistedState ?? {}) as Record<string, unknown>;
                if (version < 2) {
                    delete state.activeArtifact;
                    delete state.artifacts;
                    delete state.sandboxCode;
                }
                return state as unknown as ProjectState;
            },
            partialize: (state) => ({
                currentProject: state.currentProject,
                currentStep: state.currentStep,
                mode: state.mode,
            }),
        }
    )
);

// ============= Chat Store =============

interface ChatState {
    messages: Message[];
    isTyping: boolean;
    thoughtSteps: { title: string; content: string; status: 'pending' | 'active' | 'complete' }[];

    addMessage: (message: Message) => void;
    setMessages: (messages: Message[]) => void;
    setIsTyping: (typing: boolean) => void;
    addThoughtStep: (step: { title: string; content: string; status: 'pending' | 'active' | 'complete' }) => void;
    updateThoughtStep: (index: number, status: 'pending' | 'active' | 'complete') => void;
    clearChat: () => void;
}

export const useChatStore = create<ChatState>()((set) => ({
    messages: [],
    isTyping: false,
    thoughtSteps: [],

    addMessage: (message) => set((state) => ({
        messages: [...state.messages, message],
    })),

    setMessages: (messages) => set({ messages }),

    setIsTyping: (typing) => set({ isTyping: typing }),

    addThoughtStep: (step) => set((state) => ({
        thoughtSteps: [...state.thoughtSteps, step],
    })),

    updateThoughtStep: (index, status) => set((state) => ({
        thoughtSteps: state.thoughtSteps.map((s, i) =>
            i === index ? { ...s, status } : s
        ),
    })),

    clearChat: () => set({ messages: [], thoughtSteps: [] }),
}));

// ============= Providers Store =============

interface ProvidersState {
    providers: ProviderOption[];
    selectedProvider: ProviderOption | null;
    isLoading: boolean;

    setProviders: (providers: ProviderOption[]) => void;
    selectProvider: (provider: ProviderOption) => void;
    setIsLoading: (loading: boolean) => void;
}

export const useProvidersStore = create<ProvidersState>()((set) => ({
    providers: [],
    selectedProvider: null,
    isLoading: false,

    setProviders: (providers) => set({ providers }),
    selectProvider: (provider) => set({ selectedProvider: provider }),
    setIsLoading: (loading) => set({ isLoading: loading }),
}));

// ============= Training Store =============

interface TrainingState {
    jobId: string | null;
    status: string;
    metrics: TrainingMetrics | null;
    logs: string[];
    isRunning: boolean;

    setJobId: (id: string) => void;
    setStatus: (status: string) => void;
    updateMetrics: (metrics: TrainingMetrics) => void;
    addLog: (log: string) => void;
    setIsRunning: (running: boolean) => void;
    reset: () => void;
}

export const useTrainingStore = create<TrainingState>()((set) => ({
    jobId: null,
    status: 'idle',
    metrics: null,
    logs: [],
    isRunning: false,

    setJobId: (id) => set({ jobId: id }),
    setStatus: (status) => set({ status }),
    updateMetrics: (metrics) => set({ metrics }),
    addLog: (log) => set((state) => ({ logs: [...state.logs, log] })),
    setIsRunning: (running) => set({ isRunning: running }),
    reset: () => set({ jobId: null, status: 'idle', metrics: null, logs: [], isRunning: false }),
}));
