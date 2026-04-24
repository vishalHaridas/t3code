import type { ModelSelection, ProjectId, ProviderKind, ServerProvider } from "@t3tools/contracts";
import { ThreadId as ThreadIdSchema } from "@t3tools/contracts";
import { parseScopedThreadKey } from "@t3tools/client-runtime";
import { createModelSelection } from "@t3tools/shared/model";
import { SendIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  useEffectiveComposerModelState,
  useComposerDraftStore,
  DraftId,
} from "../composerDraftStore";
import { readEnvironmentApi } from "../environmentApi";
import { useSettings } from "../hooks/useSettings";
import { newMessageId } from "../lib/utils";
import { useNotebookModeStore } from "../notebookModeStore";
import { selectProjectByRef, selectThreadByRef, useStore } from "../store";
import { useServerConfig, useServerKeybindings } from "../rpc/serverState";
import type { Thread } from "../types";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

const NOTEBOOK_PROMPT_LIMIT = 110_000;
const EMPTY_PROVIDERS: ServerProvider[] = [];

function formatNotebookSourceDump(threads: readonly Thread[]): string {
  const lines: string[] = [
    "# Selected T3 Code Threads",
    "",
    "Use only these selected thread messages as source material. The dump intentionally excludes tool calls, tool results, diffs, approvals, and system messages.",
    "",
  ];

  threads.forEach((thread, threadIndex) => {
    const messages = thread.messages.filter(
      (message) => !message.streaming && (message.role === "user" || message.role === "assistant"),
    );
    lines.push(`## Source ${threadIndex + 1}: ${thread.title}`, "");
    lines.push(`- Thread ID: ${thread.id}`);
    lines.push(`- Created: ${thread.createdAt}`);
    if (thread.updatedAt) {
      lines.push(`- Updated: ${thread.updatedAt}`);
    }
    lines.push(`- Included messages: ${messages.length}`, "");

    messages.forEach((message, messageIndex) => {
      lines.push(`### ${messageIndex + 1}. ${message.role.toUpperCase()}`);
      lines.push(`_Created: ${message.createdAt}_`, "");
      lines.push(message.text.trim(), "");
    });
  });

  return lines.join("\n").trim();
}

function buildNotebookPrompt(input: {
  sourceDump: string;
  notebookHistory: readonly { role: "user" | "assistant"; text: string }[];
  question: string;
}): string {
  const history = input.notebookHistory
    .map((message) => `${message.role.toUpperCase()}:\n${message.text.trim()}`)
    .join("\n\n");

  return [
    "You are in T3 Code Notebook mode. Answer questions about selected historical implementation threads.",
    "Do not perform coding actions. Do not use tools. If the selected sources do not contain enough evidence, say what is missing.",
    "",
    input.sourceDump,
    "",
    history ? "## Notebook Chat So Far\n\n" + history + "\n" : "",
    "## Current Question",
    input.question.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function modelOptionsByProvider(providers: readonly ServerProvider[]) {
  return {
    codex: providers.find((provider) => provider.provider === "codex")?.models ?? [],
    claudeAgent: providers.find((provider) => provider.provider === "claudeAgent")?.models ?? [],
    cursor: providers.find((provider) => provider.provider === "cursor")?.models ?? [],
    opencode: providers.find((provider) => provider.provider === "opencode")?.models ?? [],
  } satisfies Record<ProviderKind, ReadonlyArray<ServerProvider["models"][number]>>;
}

export function NotebookModeView(props: { projectId: ProjectId }) {
  const activeProjectKey = useNotebookModeStore((state) => state.activeProjectKey);
  const selectedThreadKeys = useNotebookModeStore((state) => state.selectedThreadKeys);
  const notebookMessages = useNotebookModeStore((state) => state.messages);
  const appendMessage = useNotebookModeStore((state) => state.appendMessage);
  const appendAssistantDelta = useNotebookModeStore((state) => state.appendAssistantDelta);
  const finishAssistantMessage = useNotebookModeStore((state) => state.finishAssistantMessage);
  const failAssistantMessage = useNotebookModeStore((state) => state.failAssistantMessage);
  const exitNotebookMode = useNotebookModeStore((state) => state.exit);
  const selectedRefs = useMemo(
    () => [...selectedThreadKeys].flatMap((key) => parseScopedThreadKey(key) ?? []),
    [selectedThreadKeys],
  );
  const releaseDetailSubscriptionsRef = useRef<ReadonlyArray<() => void>>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamUnsubscribe, setStreamUnsubscribe] = useState<(() => void) | null>(null);
  const settings = useSettings();
  const keybindings = useServerKeybindings();
  const serverConfig = useServerConfig();
  const providers = serverConfig?.providers ?? EMPTY_PROVIDERS;
  const providerModels = useMemo(() => modelOptionsByProvider(providers), [providers]);
  const project = useStore(
    useMemo(
      () => (state) => {
        const environmentId = selectedRefs[0]?.environmentId;
        return environmentId
          ? selectProjectByRef(state, {
              environmentId,
              projectId: props.projectId,
            })
          : undefined;
      },
      [props.projectId, selectedRefs],
    ),
  );
  const selectedThreads = useStore(
    useShallow(
      useMemo(
        () => (state) =>
          selectedRefs.flatMap((ref) => {
            const thread = selectThreadByRef(state, ref);
            return thread ? [thread] : [];
          }),
        [selectedRefs],
      ),
    ),
  );
  const selectedProvider: ProviderKind =
    useComposerDraftStore((state) => {
      const draft = activeProjectKey
        ? state.getComposerDraft(DraftId.make(`notebook:${activeProjectKey}`))
        : null;
      return draft?.activeProvider ?? null;
    }) ??
    selectedThreads[0]?.modelSelection.provider ??
    project?.defaultModelSelection?.provider ??
    "codex";
  const draftId = DraftId.make(`notebook:${activeProjectKey ?? "inactive"}`);
  const effectiveModelState = useEffectiveComposerModelState({
    draftId,
    providers,
    selectedProvider,
    threadModelSelection: selectedThreads[0]?.modelSelection,
    projectModelSelection: project?.defaultModelSelection,
    settings,
  });
  const selectedModelSelection = effectiveModelState.selectedModel
    ? createModelSelection(
        selectedProvider,
        effectiveModelState.selectedModel,
        effectiveModelState.modelOptions?.[selectedProvider],
      )
    : (selectedThreads[0]?.modelSelection ?? project?.defaultModelSelection);
  const setModelSelection = useComposerDraftStore((state) => state.setModelSelection);
  const sourceDump = useMemo(() => formatNotebookSourceDump(selectedThreads), [selectedThreads]);
  const loadingSourceCount = selectedRefs.length - selectedThreads.length;
  const promptPreview = useMemo(
    () =>
      buildNotebookPrompt({
        sourceDump,
        notebookHistory: notebookMessages.filter((message) => !message.streaming),
        question: question || " ",
      }),
    [notebookMessages, question, sourceDump],
  );
  const promptTooLarge = promptPreview.length > NOTEBOOK_PROMPT_LIMIT;
  const canSubmit =
    selectedRefs.length > 0 &&
    loadingSourceCount === 0 &&
    question.trim().length > 0 &&
    !busy &&
    !promptTooLarge &&
    Boolean(project?.cwd) &&
    Boolean(selectedModelSelection);

  useEffect(() => {
    let cancelled = false;

    void import("../environments/runtime/service").then(({ retainThreadDetailSubscription }) => {
      if (cancelled) return;
      releaseDetailSubscriptionsRef.current.forEach((release) => release());
      releaseDetailSubscriptionsRef.current = selectedRefs.map((ref) =>
        retainThreadDetailSubscription(ref.environmentId, ref.threadId),
      );
    });

    return () => {
      cancelled = true;
      releaseDetailSubscriptionsRef.current.forEach((release) => release());
      releaseDetailSubscriptionsRef.current = [];
    };
  }, [selectedRefs]);

  useEffect(() => {
    return () => {
      streamUnsubscribe?.();
    };
  }, [streamUnsubscribe]);

  const submit = useCallback(() => {
    if (!canSubmit || !project || !selectedModelSelection) return;
    const api = readEnvironmentApi(project.environmentId);
    if (!api) return;

    const now = new Date().toISOString();
    const userMessage = {
      id: newMessageId(),
      role: "user" as const,
      text: question.trim(),
      createdAt: now,
    };
    const assistantMessage = {
      id: newMessageId(),
      role: "assistant" as const,
      text: "",
      createdAt: now,
      streaming: true,
    };
    const prompt = buildNotebookPrompt({
      sourceDump,
      notebookHistory: notebookMessages.filter((message) => !message.streaming),
      question,
    });

    appendMessage(userMessage);
    appendMessage(assistantMessage);
    setQuestion("");
    setBusy(true);

    const unsubscribe = api.orchestration.notebookTurn(
      {
        threadId: ThreadIdSchema.make(`notebook-${crypto.randomUUID()}`),
        cwd: project.cwd,
        modelSelection: selectedModelSelection as ModelSelection,
        prompt,
      },
      (event) => {
        if (event.type === "delta") {
          appendAssistantDelta(assistantMessage.id, event.delta);
          return;
        }
        if (event.type === "error") {
          failAssistantMessage(assistantMessage.id, event.message);
          setBusy(false);
          return;
        }
        finishAssistantMessage(assistantMessage.id);
        setBusy(false);
      },
    );
    setStreamUnsubscribe(() => unsubscribe);
  }, [
    appendAssistantDelta,
    appendMessage,
    canSubmit,
    failAssistantMessage,
    finishAssistantMessage,
    notebookMessages,
    project,
    question,
    selectedModelSelection,
    sourceDump,
  ]);

  const sourceLabel =
    selectedRefs.length === 0
      ? "No sources selected"
      : loadingSourceCount > 0
        ? `${selectedThreads.length}/${selectedRefs.length} sources loaded`
        : `${selectedRefs.length} source${selectedRefs.length === 1 ? "" : "s"} selected`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">Notebook mode</h2>
          <p className="truncate text-xs text-muted-foreground">
            Raw prototype over selected user/assistant thread messages
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={exitNotebookMode}>
          <XIcon className="size-3.5" />
          Exit
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
          {notebookMessages.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
              Select one or more threads in the current project, then ask about implementation
              history, pivots, bugs, or refactors.
            </div>
          ) : (
            notebookMessages.map((message) => (
              <div
                key={message.id}
                className={`rounded-lg border p-3 text-sm ${
                  message.role === "user"
                    ? "ml-auto max-w-[80%] border-primary/30 bg-primary/10"
                    : message.error
                      ? "mr-auto max-w-[88%] border-destructive/30 bg-destructive/10"
                      : "mr-auto max-w-[88%] border-border bg-card"
                }`}
              >
                <div className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
                  {message.role}
                </div>
                <div className="whitespace-pre-wrap leading-relaxed">
                  {message.text || (message.streaming ? "Thinking..." : "")}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-border px-5 py-3">
        <div className="mx-auto w-full max-w-4xl space-y-2">
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              {sourceLabel} - {sourceDump.length.toLocaleString()} source chars
              {promptTooLarge ? " - too large" : ""}
            </span>
            <ProviderModelPicker
              compact
              provider={selectedProvider}
              model={effectiveModelState.selectedModel}
              lockedProvider={null}
              providers={providers}
              keybindings={keybindings}
              modelOptionsByProvider={providerModels}
              onProviderModelChange={(provider, model) => {
                setModelSelection(draftId, createModelSelection(provider, model));
              }}
            />
          </div>
          <div className="flex gap-2">
            <Textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={
                selectedRefs.length === 0
                  ? "Select thread sources from the sidebar first"
                  : "Ask about the selected implementation threads"
              }
              className="min-h-24 resize-none"
              disabled={busy}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <Button className="self-end" disabled={!canSubmit} onClick={submit}>
              <SendIcon className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
