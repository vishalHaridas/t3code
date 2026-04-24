import { create } from "zustand";

export type NotebookChatRole = "user" | "assistant";

export interface NotebookChatMessage {
  id: string;
  role: NotebookChatRole;
  text: string;
  createdAt: string;
  streaming?: boolean;
  error?: boolean;
}

interface NotebookModeState {
  activeProjectKey: string | null;
  selectedThreadKeys: ReadonlySet<string>;
  messages: NotebookChatMessage[];
  enter: (projectKey: string) => void;
  exit: () => void;
  toggleProject: (projectKey: string) => void;
  toggleSourceThread: (threadKey: string) => void;
  clearSourceThreads: () => void;
  appendMessage: (message: NotebookChatMessage) => void;
  appendAssistantDelta: (messageId: string, delta: string) => void;
  finishAssistantMessage: (messageId: string) => void;
  failAssistantMessage: (messageId: string, text: string) => void;
}

const emptySelection = () => new Set<string>();

export const useNotebookModeStore = create<NotebookModeState>((set) => ({
  activeProjectKey: null,
  selectedThreadKeys: emptySelection(),
  messages: [],
  enter: (projectKey) =>
    set({
      activeProjectKey: projectKey,
      selectedThreadKeys: emptySelection(),
      messages: [],
    }),
  exit: () =>
    set({
      activeProjectKey: null,
      selectedThreadKeys: emptySelection(),
      messages: [],
    }),
  toggleProject: (projectKey) =>
    set((state) =>
      state.activeProjectKey === projectKey
        ? {
            activeProjectKey: null,
            selectedThreadKeys: emptySelection(),
            messages: [],
          }
        : {
            activeProjectKey: projectKey,
            selectedThreadKeys: emptySelection(),
            messages: [],
          },
    ),
  toggleSourceThread: (threadKey) =>
    set((state) => {
      const next = new Set(state.selectedThreadKeys);
      if (next.has(threadKey)) {
        next.delete(threadKey);
      } else {
        next.add(threadKey);
      }
      return { selectedThreadKeys: next };
    }),
  clearSourceThreads: () => set({ selectedThreadKeys: emptySelection() }),
  appendMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
    })),
  appendAssistantDelta: (messageId, delta) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId ? { ...message, text: message.text + delta } : message,
      ),
    })),
  finishAssistantMessage: (messageId) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId ? { ...message, streaming: false } : message,
      ),
    })),
  failAssistantMessage: (messageId, text) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId ? { ...message, text, streaming: false, error: true } : message,
      ),
    })),
}));
