import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import { create } from "zustand";

import type { NotebookSearchResult } from "./notebookRetrieval";

export type NotebookModeKind = "search" | "ask";

export interface NotebookAskResult {
  query: string;
  text: string;
  streamingText: string;
  streaming: boolean;
  error?: boolean;
  stopped?: boolean;
  sourceMode?: "complete" | "retrieved";
  sources?: NotebookSearchResult | null;
  usage?: ThreadTokenUsageSnapshot | null;
}

interface NotebookModeState {
  activeProjectKey: string | null;
  selectedThreadKeys: ReadonlySet<string>;
  mode: NotebookModeKind;
  lastSubmittedQuery: string;
  searchResult: NotebookSearchResult | null;
  askResult: NotebookAskResult | null;
  enter: (projectKey: string) => void;
  exit: () => void;
  toggleProject: (projectKey: string) => void;
  setMode: (mode: NotebookModeKind) => void;
  toggleSourceThread: (threadKey: string) => void;
  clearSourceThreads: () => void;
  clearResults: () => void;
  setSearchResult: (query: string, result: NotebookSearchResult) => void;
  startAsk: (
    query: string,
    options: {
      sourceMode: "complete" | "retrieved";
      sources: NotebookSearchResult | null;
    },
  ) => void;
  appendAskDelta: (delta: string) => void;
  setAskUsage: (usage: ThreadTokenUsageSnapshot) => void;
  finishAsk: () => void;
  failAsk: (text: string) => void;
  stopAsk: () => void;
}

const emptySelection = () => new Set<string>();

const blankResults = {
  lastSubmittedQuery: "",
  searchResult: null,
  askResult: null,
};

export const useNotebookModeStore = create<NotebookModeState>((set, get) => ({
  activeProjectKey: null,
  selectedThreadKeys: emptySelection(),
  mode: "search",
  ...blankResults,
  enter: (projectKey) =>
    set({
      activeProjectKey: projectKey,
      selectedThreadKeys: emptySelection(),
      mode: "search",
      ...blankResults,
    }),
  exit: () =>
    set({
      activeProjectKey: null,
      selectedThreadKeys: emptySelection(),
      mode: "search",
      ...blankResults,
    }),
  toggleProject: (projectKey) =>
    set((state) =>
      state.activeProjectKey === projectKey
        ? {
            activeProjectKey: null,
            selectedThreadKeys: emptySelection(),
            mode: "search",
            ...blankResults,
          }
        : {
            activeProjectKey: projectKey,
            selectedThreadKeys: emptySelection(),
            mode: "search",
            ...blankResults,
          },
    ),
  setMode: (mode) => {
    if (get().askResult?.streaming) return;
    set({ mode });
  },
  toggleSourceThread: (threadKey) =>
    set((state) => {
      // Source selection defines the result universe. Once a result exists, the
      // sidebar is locked until the query is cleared so stale chunks cannot look
      // like they came from the current selection.
      if (state.searchResult || state.askResult || state.lastSubmittedQuery) {
        return state;
      }
      const next = new Set(state.selectedThreadKeys);
      if (next.has(threadKey)) {
        next.delete(threadKey);
      } else {
        next.add(threadKey);
      }
      return { selectedThreadKeys: next };
    }),
  clearSourceThreads: () => set({ selectedThreadKeys: emptySelection() }),
  clearResults: () => set(blankResults),
  setSearchResult: (query, result) =>
    set({
      lastSubmittedQuery: query,
      searchResult: result,
      askResult: null,
    }),
  startAsk: (query, options) =>
    set({
      lastSubmittedQuery: query,
      searchResult: null,
      askResult: {
        query,
        text: "",
        streamingText: "",
        streaming: true,
        sourceMode: options.sourceMode,
        sources: options.sources,
        usage: null,
      },
    }),
  appendAskDelta: (delta) =>
    set((state) => ({
      askResult: state.askResult
        ? {
            ...state.askResult,
            streamingText: state.askResult.streamingText + delta,
          }
        : null,
    })),
  setAskUsage: (usage) =>
    set((state) => ({
      askResult: state.askResult
        ? {
            ...state.askResult,
            usage,
          }
        : null,
    })),
  finishAsk: () =>
    set((state) => ({
      askResult: state.askResult
        ? {
            ...state.askResult,
            text: state.askResult.streamingText,
            streaming: false,
          }
        : null,
    })),
  failAsk: (text) =>
    set((state) => ({
      askResult: state.askResult
        ? {
            ...state.askResult,
            text,
            streamingText: text,
            streaming: false,
            error: true,
          }
        : null,
    })),
  stopAsk: () =>
    set((state) => ({
      askResult: state.askResult
        ? {
            ...state.askResult,
            text: state.askResult.streamingText || "Stopped before any answer was received.",
            streaming: false,
            stopped: true,
          }
        : null,
    })),
}));
