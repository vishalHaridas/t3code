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
  usage?: ThreadTokenUsageSnapshot | null;
}

export interface NotebookSearchRun {
  query: string;
  running: boolean;
  stopped?: boolean;
  error?: string;
}

interface NotebookModeState {
  activeProjectKey: string | null;
  selectedThreadKeys: ReadonlySet<string>;
  sourceAddBlocked: boolean;
  mode: NotebookModeKind;
  lastSubmittedQuery: string;
  searchRun: NotebookSearchRun | null;
  searchResult: NotebookSearchResult | null;
  askResult: NotebookAskResult | null;
  enter: (projectKey: string) => void;
  exit: () => void;
  toggleProject: (projectKey: string) => void;
  setMode: (mode: NotebookModeKind) => void;
  setSourceAddBlocked: (blocked: boolean) => void;
  setSourceThreads: (threadKeys: readonly string[]) => void;
  toggleSourceThread: (threadKey: string) => void;
  clearSourceThreads: () => void;
  clearResults: () => void;
  startSearch: (query: string) => void;
  finishSearch: (query: string, result: NotebookSearchResult) => void;
  failSearch: (query: string, error: string) => void;
  cancelSearch: () => void;
  stopSearch: () => void;
  startAsk: (query: string) => void;
  appendAskDelta: (delta: string) => void;
  setAskUsage: (usage: ThreadTokenUsageSnapshot) => void;
  finishAsk: () => void;
  failAsk: (text: string) => void;
  stopAsk: () => void;
}

const emptySelection = () => new Set<string>();

const blankResults = {
  lastSubmittedQuery: "",
  searchRun: null,
  searchResult: null,
  askResult: null,
};

export const useNotebookModeStore = create<NotebookModeState>((set, get) => ({
  activeProjectKey: null,
  selectedThreadKeys: emptySelection(),
  sourceAddBlocked: false,
  mode: "search",
  ...blankResults,
  enter: (projectKey) =>
    set({
      activeProjectKey: projectKey,
      selectedThreadKeys: emptySelection(),
      sourceAddBlocked: false,
      mode: "search",
      ...blankResults,
    }),
  exit: () =>
    set({
      activeProjectKey: null,
      selectedThreadKeys: emptySelection(),
      sourceAddBlocked: false,
      mode: "search",
      ...blankResults,
    }),
  toggleProject: (projectKey) =>
    set((state) =>
      state.activeProjectKey === projectKey
        ? {
            activeProjectKey: null,
            selectedThreadKeys: emptySelection(),
            sourceAddBlocked: false,
            mode: "search",
            ...blankResults,
          }
        : {
            activeProjectKey: projectKey,
            selectedThreadKeys: emptySelection(),
            sourceAddBlocked: false,
            mode: "search",
            ...blankResults,
          },
    ),
  setMode: (mode) => {
    const state = get();
    if (state.askResult?.streaming || state.searchRun?.running) return;
    set({ mode });
  },
  setSourceAddBlocked: (blocked) =>
    set((state) => (state.sourceAddBlocked === blocked ? state : { sourceAddBlocked: blocked })),
  setSourceThreads: (threadKeys) =>
    set((state) => {
      if (state.searchRun || state.searchResult || state.askResult || state.lastSubmittedQuery) {
        return state;
      }
      if (state.sourceAddBlocked) return state;
      return { selectedThreadKeys: new Set(threadKeys) };
    }),
  toggleSourceThread: (threadKey) =>
    set((state) => {
      // Source selection defines the result universe. Once a result exists, the
      // sidebar is locked until the query is cleared so stale chunks cannot look
      // like they came from the current selection.
      if (state.searchRun || state.searchResult || state.askResult || state.lastSubmittedQuery) {
        return state;
      }
      const next = new Set(state.selectedThreadKeys);
      if (next.has(threadKey)) {
        next.delete(threadKey);
      } else {
        if (state.sourceAddBlocked) return state;
        next.add(threadKey);
      }
      return { selectedThreadKeys: next };
    }),
  clearSourceThreads: () => set({ selectedThreadKeys: emptySelection() }),
  clearResults: () => set(blankResults),
  startSearch: (query) =>
    set({
      lastSubmittedQuery: query,
      searchRun: {
        query,
        running: true,
      },
      askResult: null,
    }),
  finishSearch: (query, result) =>
    set((state) =>
      state.searchRun?.query === query
        ? {
            searchRun: null,
            searchResult: result,
            askResult: null,
          }
        : state,
    ),
  failSearch: (query, error) =>
    set((state) =>
      state.searchRun?.query === query
        ? {
            searchRun: {
              query,
              running: false,
              error,
            },
          }
        : state,
    ),
  cancelSearch: () => set({ searchRun: null }),
  stopSearch: () =>
    set((state) =>
      state.searchRun
        ? {
            searchRun: {
              query: state.searchRun.query,
              running: false,
              stopped: true,
            },
          }
        : state,
    ),
  startAsk: (query) =>
    set({
      lastSubmittedQuery: query,
      searchRun: null,
      searchResult: null,
      askResult: {
        query,
        text: "",
        streamingText: "",
        streaming: true,
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
