import type { ModelSelection, ProjectId, ProviderKind, ServerProvider } from "@t3tools/contracts";
import { ThreadId as ThreadIdSchema } from "@t3tools/contracts";
import { parseScopedThreadKey } from "@t3tools/client-runtime";
import { createModelSelection } from "@t3tools/shared/model";
import { clampNotebookPromptCharLimit, getNotebookPromptCharLimit } from "@t3tools/shared/notebook";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  Loader2Icon,
  SearchIcon,
  SendIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { cn } from "~/lib/utils";
import {
  useEffectiveComposerModelState,
  useComposerDraftStore,
  DraftId,
} from "../composerDraftStore";
import { readEnvironmentApi } from "../environmentApi";
import { useSettings } from "../hooks/useSettings";
import { useNotebookModeStore } from "../notebookModeStore";
import type {
  NotebookSearchChunk,
  NotebookSearchResult,
  NotebookSearchThreadResult,
} from "../notebookRetrieval";
import { prepareNotebookSearchResult, prepareNotebookSources } from "../notebookRetrieval";
import { formatContextWindowTokens } from "../lib/contextWindow";
import { useServerConfig, useServerKeybindings } from "../rpc/serverState";
import { selectProjectByRef, selectThreadByRef, useStore } from "../store";
import ChatMarkdown from "./ChatMarkdown";
import { MessageCopyButton } from "./chat/MessageCopyButton";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { Button } from "./ui/button";

const NOTEBOOK_SOURCE_BUDGET_SAFETY_MARGIN = 1_000;
const EMPTY_PROVIDERS: ServerProvider[] = [];

function getCompleteSourcePressure(input: { estimatedTokens: number; promptLimitChars: number }) {
  const hardLimit = Math.max(1, Math.floor(input.promptLimitChars / 4));
  const softLimit = hardLimit * 0.3;
  const collapseStart = hardLimit * 0.45;
  const collapseEnd = hardLimit * 0.8;
  let danger = 0;

  if (input.estimatedTokens <= softLimit) {
    danger = 0.3 * (input.estimatedTokens / softLimit);
  } else if (input.estimatedTokens <= collapseStart) {
    const t = (input.estimatedTokens - softLimit) / (collapseStart - softLimit);
    danger = 0.3 + t * 0.4;
  } else {
    const t = Math.min(1, (input.estimatedTokens - collapseStart) / (collapseEnd - collapseStart));
    danger = 0.7 + t ** 2 * 0.3;
  }

  if (danger >= 0.9) {
    return {
      className:
        "border-red-950/40 bg-red-950/25 text-red-950 dark:border-red-300/25 dark:bg-red-950/35 dark:text-red-200",
      label: "Over budget",
      hardLimit,
    };
  }
  if (danger >= 0.7) {
    return {
      className:
        "border-red-700/35 bg-red-500/12 text-red-800 dark:border-red-300/25 dark:bg-red-950/30 dark:text-red-200",
      label: "At the edge",
      hardLimit,
    };
  }
  if (danger >= 0.5) {
    return {
      className:
        "border-orange-600/35 bg-orange-500/12 text-orange-800 dark:border-orange-300/25 dark:bg-orange-950/28 dark:text-orange-200",
      label: "Getting tight",
      hardLimit,
    };
  }
  if (danger >= 0.3) {
    return {
      className:
        "border-yellow-600/35 bg-yellow-500/12 text-yellow-800 dark:border-yellow-300/25 dark:bg-yellow-950/25 dark:text-yellow-100",
      label: "Moderate",
      hardLimit,
    };
  }
  return {
    className:
      "border-emerald-600/30 bg-emerald-500/10 text-emerald-800 dark:border-emerald-300/25 dark:bg-emerald-950/25 dark:text-emerald-100",
    label: "Comfortable",
    hardLimit,
  };
}

function buildNotebookPrompt(input: { preparedSource: string; question: string }): string {
  return [
    "You are answering a one-shot question about selected conversations between a user and an agent.",
    "Use only the user/assistant messages provided below.",
    "Important limits:",
    "- You only know what appears in those messages.",
    "- You do not know hidden tool calls, tool results, file changes, diffs, or system/runtime state unless they are explicitly described in the messages.",
    "- Do not claim to have verified anything outside the provided conversation.",
    "Answer the question directly. If the messages do not support a confident answer, say so briefly and state what is missing.",
    "",
    input.preparedSource,
    "",
    "## Question",
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

function formatNotebookTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function highlightChunkText(text: string, terms: readonly string[]) {
  if (terms.length === 0) return text;
  const escapedTerms = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`\\b(?:${escapedTerms.join("|")})[\\w-]*`, "gi");
  let highlightIndex = 0;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const matched = match[0];
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark
        key={`${matched.toLowerCase()}:${highlightIndex++}`}
        className="rounded-sm bg-primary/25 px-0.5 text-foreground"
      >
        {matched}
      </mark>,
    );
    cursor = start + matched.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function NotebookSearchMessage(props: {
  message: NotebookSearchChunk["messages"][number];
  matchedTerms: readonly string[];
}) {
  const terms =
    props.message.matchedTerms.length > 0 ? props.message.matchedTerms : props.matchedTerms;
  return (
    <div className="grid grid-cols-[5.75rem_1fr] gap-3 px-3 py-3">
      <div className="select-none text-right">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {props.message.role}
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground/70">
          {formatNotebookTime(props.message.createdAt)}
        </div>
      </div>
      <div className="min-w-0 text-sm leading-relaxed text-foreground/90">
        <div className="whitespace-pre-wrap">{highlightChunkText(props.message.text, terms)}</div>
      </div>
    </div>
  );
}

type NotebookSearchRange = {
  chunkIds: string[];
  startOrdinal: number;
  endOrdinal: number;
  matchedTerms: string[];
};

function mergeNotebookSearchRanges(chunks: readonly NotebookSearchChunk[]): NotebookSearchRange[] {
  const ranges: NotebookSearchRange[] = [];
  for (const chunk of chunks) {
    const previous = ranges[ranges.length - 1];
    if (previous && chunk.startOrdinal <= previous.endOrdinal + 1) {
      previous.chunkIds.push(chunk.id);
      previous.endOrdinal = Math.max(previous.endOrdinal, chunk.endOrdinal);
      previous.matchedTerms = [...new Set([...previous.matchedTerms, ...chunk.matchedTerms])];
      continue;
    }
    ranges.push({
      chunkIds: [chunk.id],
      startOrdinal: chunk.startOrdinal,
      endOrdinal: chunk.endOrdinal,
      matchedTerms: [...chunk.matchedTerms],
    });
  }
  return ranges;
}

function NotebookSearchResults(props: {
  result: NotebookSearchResult;
  title?: string;
  defaultCollapsed?: boolean;
}) {
  const [collapsedThreads, setCollapsedThreads] = useState<ReadonlySet<string>>(() => new Set());

  if (props.result.threads.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
        No matches in selected threads.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {props.title ? (
        <div className="text-xs font-medium uppercase text-muted-foreground">{props.title}</div>
      ) : null}
      {props.result.threads.map((thread) => {
        const collapsed =
          collapsedThreads.has(String(thread.threadId)) || (props.defaultCollapsed ?? false);
        return (
          <NotebookThreadFold
            key={String(thread.threadId)}
            thread={thread}
            collapsed={collapsed}
            onToggle={() => {
              setCollapsedThreads((current) => {
                const next = new Set(current);
                const key = String(thread.threadId);
                if (next.has(key)) {
                  next.delete(key);
                } else {
                  next.add(key);
                }
                return next;
              });
            }}
          />
        );
      })}
    </div>
  );
}

function NotebookThreadFold(props: {
  thread: NotebookSearchThreadResult;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const messageByOrdinal = useMemo(
    () => new Map(props.thread.messages.map((message) => [message.ordinal, message])),
    [props.thread.messages],
  );
  const [expandedRanges, setExpandedRanges] = useState<
    Record<string, { start: number; end: number }>
  >(() => ({}));
  const chunks = props.thread.chunks.map((chunk) => {
    const expanded = expandedRanges[chunk.id];
    return {
      ...chunk,
      startOrdinal: expanded?.start ?? chunk.startOrdinal,
      endOrdinal: expanded?.end ?? chunk.endOrdinal,
    };
  });
  const ranges = mergeNotebookSearchRanges(chunks);
  const firstOrdinal = props.thread.messages[0]?.ordinal ?? 1;
  const lastOrdinal = props.thread.messages[props.thread.messages.length - 1]?.ordinal ?? 1;
  const expandChunk = (chunkId: string, direction: "previous" | "next") => {
    const chunk = props.thread.chunks.find((candidate) => candidate.id === chunkId);
    if (!chunk) return;
    setExpandedRanges((current) => {
      const existing = current[chunkId] ?? {
        start: chunk.startOrdinal,
        end: chunk.endOrdinal,
      };
      return {
        ...current,
        [chunkId]:
          direction === "previous"
            ? { ...existing, start: Math.max(firstOrdinal, existing.start - 1) }
            : { ...existing, end: Math.min(lastOrdinal, existing.end + 1) },
      };
    });
  };

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card/40">
      <button
        type="button"
        className="flex w-full items-center gap-2 border-b border-border/70 bg-muted/30 px-3 py-2 text-left text-sm"
        onClick={props.onToggle}
      >
        {props.collapsed ? (
          <ChevronRightIcon className="size-4 text-muted-foreground" />
        ) : (
          <ChevronDownIcon className="size-4 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{props.thread.title}</span>
      </button>
      {props.collapsed ? null : (
        <div className="divide-y divide-border/60">
          {ranges.map((range) => {
            const previousChunkId = range.chunkIds[0];
            const nextChunkId = range.chunkIds[range.chunkIds.length - 1];
            const canExpandPrevious = range.startOrdinal > firstOrdinal;
            const canExpandNext = range.endOrdinal < lastOrdinal;
            const messages = [];
            for (let ordinal = range.startOrdinal; ordinal <= range.endOrdinal; ordinal += 1) {
              const message = messageByOrdinal.get(ordinal);
              if (message) messages.push(message);
            }
            return (
              <article key={range.chunkIds.join(":")} className="group/notebook-search-result">
                <div className="flex h-7 items-center justify-center border-b border-border/40 bg-muted/20">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground opacity-70 hover:opacity-100 disabled:opacity-25"
                    disabled={!canExpandPrevious || !previousChunkId}
                    title="Reveal previous chat"
                    onClick={() => {
                      if (previousChunkId) expandChunk(previousChunkId, "previous");
                    }}
                  >
                    <ArrowUpIcon className="size-3.5" />
                  </Button>
                </div>
                <div className="divide-y divide-border/35">
                  {messages.map((message) => (
                    <NotebookSearchMessage
                      key={message.id}
                      message={message}
                      matchedTerms={range.matchedTerms}
                    />
                  ))}
                </div>
                <div className="flex h-7 items-center justify-center border-t border-border/40 bg-muted/20">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground opacity-70 hover:opacity-100 disabled:opacity-25"
                    disabled={!canExpandNext || !nextChunkId}
                    title="Reveal next chat"
                    onClick={() => {
                      if (nextChunkId) expandChunk(nextChunkId, "next");
                    }}
                  >
                    <ArrowDownIcon className="size-3.5" />
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function formatNotebookUsageFooter(input: {
  inputTokens: number | null;
  outputTokens: number | null;
}): string | null {
  const parts = [
    input.inputTokens !== null ? `${formatContextWindowTokens(input.inputTokens)} in` : null,
    input.outputTokens !== null ? `${formatContextWindowTokens(input.outputTokens)} out` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `Tokens: ${parts.join(" · ")}` : null;
}

export function NotebookModeView(props: { projectId: ProjectId }) {
  const activeProjectKey = useNotebookModeStore((state) => state.activeProjectKey);
  const selectedThreadKeys = useNotebookModeStore((state) => state.selectedThreadKeys);
  const mode = useNotebookModeStore((state) => state.mode);
  const searchResult = useNotebookModeStore((state) => state.searchResult);
  const askResult = useNotebookModeStore((state) => state.askResult);
  const setMode = useNotebookModeStore((state) => state.setMode);
  const clearResults = useNotebookModeStore((state) => state.clearResults);
  const setSearchResult = useNotebookModeStore((state) => state.setSearchResult);
  const startAsk = useNotebookModeStore((state) => state.startAsk);
  const appendAskDelta = useNotebookModeStore((state) => state.appendAskDelta);
  const setAskUsage = useNotebookModeStore((state) => state.setAskUsage);
  const finishAsk = useNotebookModeStore((state) => state.finishAsk);
  const failAsk = useNotebookModeStore((state) => state.failAsk);
  const stopAsk = useNotebookModeStore((state) => state.stopAsk);
  const exitNotebookMode = useNotebookModeStore((state) => state.exit);
  const selectedRefs = useMemo(
    () => [...selectedThreadKeys].flatMap((key) => parseScopedThreadKey(key) ?? []),
    [selectedThreadKeys],
  );
  const releaseDetailSubscriptionsRef = useRef<ReadonlyArray<() => void>>([]);
  const streamUnsubscribeRef = useRef<(() => void) | null>(null);
  const [question, setQuestion] = useState("");
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
  const notebookPromptLimit = useMemo(
    () => clampNotebookPromptCharLimit(getNotebookPromptCharLimit(selectedModelSelection)),
    [selectedModelSelection],
  );

  const sourceCharBudget = useMemo(() => {
    const promptWithoutSources = buildNotebookPrompt({
      preparedSource: "",
      question: question || " ",
    });
    return Math.max(
      0,
      notebookPromptLimit - promptWithoutSources.length - NOTEBOOK_SOURCE_BUDGET_SAFETY_MARGIN,
    );
  }, [notebookPromptLimit, question]);
  const preparedAskSources = useMemo(
    () =>
      prepareNotebookSources(selectedThreads, question || " ", {
        sourceCharBudget,
      }),
    [question, selectedThreads, sourceCharBudget],
  );
  const loadingSourceCount = selectedRefs.length - selectedThreads.length;
  const promptPreview = useMemo(
    () =>
      buildNotebookPrompt({
        preparedSource: preparedAskSources.promptSource,
        question: question || " ",
      }),
    [preparedAskSources.promptSource, question],
  );
  const promptTooLarge = promptPreview.length > notebookPromptLimit;
  const askInFlight = askResult?.streaming === true;
  const mutableControlsDisabled = askInFlight;
  const canSubmit =
    selectedRefs.length > 0 &&
    loadingSourceCount === 0 &&
    question.trim().length > 0 &&
    !askInFlight &&
    !promptTooLarge &&
    Boolean(project?.cwd) &&
    (mode === "search" || Boolean(selectedModelSelection));

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
      streamUnsubscribeRef.current?.();
      streamUnsubscribeRef.current = null;
    };
  }, []);

  const submitSearch = useCallback(() => {
    const query = question.trim();
    if (!canSubmit || query.length === 0) return;
    // Search is pure client-side retrieval. It clears any prior answer/result
    // and replaces it with the folded chunk result for this query.
    const result = prepareNotebookSearchResult(selectedThreads, query);
    setSearchResult(query, result);
  }, [canSubmit, question, selectedThreads, setSearchResult]);

  const submitAsk = useCallback(() => {
    const query = question.trim();
    if (!canSubmit || !project || !selectedModelSelection || query.length === 0) return;
    const api = readEnvironmentApi(project.environmentId);
    if (!api) return;

    const visibleSources = prepareNotebookSearchResult(selectedThreads, query);
    if (preparedAskSources.mode === "retrieved" && visibleSources.threads.length === 0) {
      startAsk(query, {
        sourceMode: preparedAskSources.mode,
        sources: visibleSources,
      });
      failAsk("No matching sources were found in the selected threads.");
      return;
    }

    const prompt = buildNotebookPrompt({
      preparedSource: preparedAskSources.promptSource,
      question: query,
    });

    startAsk(query, {
      sourceMode: preparedAskSources.mode,
      sources: visibleSources,
    });

    streamUnsubscribeRef.current?.();
    streamUnsubscribeRef.current = null;

    try {
      streamUnsubscribeRef.current = api.orchestration.notebookTurn(
        {
          threadId: ThreadIdSchema.make(`notebook-${crypto.randomUUID()}`),
          cwd: project.cwd,
          modelSelection: selectedModelSelection as ModelSelection,
          prompt,
        },
        (event) => {
          // The provider streams deltas, but this UI intentionally buffers them
          // so Ask mode behaves like a one-shot result instead of a chat stream.
          if (event.type === "delta") {
            appendAskDelta(event.delta);
            return;
          }
          if (event.type === "usage") {
            setAskUsage(event.usage);
            return;
          }
          streamUnsubscribeRef.current = null;
          if (event.type === "error") {
            failAsk(event.message);
            return;
          }
          finishAsk();
        },
        {
          onError: (message) => {
            streamUnsubscribeRef.current = null;
            failAsk(message);
          },
        },
      );
    } catch (error) {
      streamUnsubscribeRef.current = null;
      failAsk(error instanceof Error ? error.message : "Failed to start notebook ask.");
    }
  }, [
    appendAskDelta,
    canSubmit,
    failAsk,
    finishAsk,
    preparedAskSources.mode,
    preparedAskSources.promptSource,
    project,
    question,
    selectedModelSelection,
    selectedThreads,
    setAskUsage,
    startAsk,
  ]);

  const submit = useCallback(() => {
    if (mode === "search") {
      submitSearch();
      return;
    }
    submitAsk();
  }, [mode, submitAsk, submitSearch]);

  const stopStreamingAsk = useCallback(() => {
    streamUnsubscribeRef.current?.();
    streamUnsubscribeRef.current = null;
    stopAsk();
  }, [stopAsk]);

  const handleQuestionChange = useCallback(
    (value: string) => {
      setQuestion(value);
      if (value.trim().length === 0) {
        clearResults();
      }
    },
    [clearResults],
  );

  const sourceLabel =
    selectedRefs.length === 0
      ? "No sources"
      : loadingSourceCount > 0
        ? `${selectedThreads.length}/${selectedRefs.length} sources loaded`
        : `${selectedRefs.length} source${selectedRefs.length === 1 ? "" : "s"} selected`;
  const completeSourcePressure = getCompleteSourcePressure({
    estimatedTokens: preparedAskSources.estimatedTokens,
    promptLimitChars: notebookPromptLimit,
  });
  const askUsageFooter = askResult
    ? formatNotebookUsageFooter({
        inputTokens: askResult.usage?.lastInputTokens ?? askResult.usage?.inputTokens ?? null,
        outputTokens: askResult.usage?.lastOutputTokens ?? askResult.usage?.outputTokens ?? null,
      })
    : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">Notebook mode</h2>
        </div>
        <Button variant="outline" size="sm" onClick={exitNotebookMode} disabled={askInFlight}>
          <XIcon className="size-3.5" />
          Exit
        </Button>
      </header>

      <div className="shrink-0 border-b border-border px-5 py-4">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-lg border border-border bg-muted/30 p-1">
              {(["search", "ask"] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    mode === candidate
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  disabled={mutableControlsDisabled}
                  onClick={() => setMode(candidate)}
                >
                  {candidate === "search" ? "Search" : "Ask"}
                </button>
              ))}
            </div>
            {mode === "ask" ? (
              <ProviderModelPicker
                compact
                provider={selectedProvider}
                model={effectiveModelState.selectedModel}
                lockedProvider={null}
                providers={providers}
                keybindings={keybindings}
                modelOptionsByProvider={providerModels}
                onProviderModelChange={(provider, model) => {
                  if (askInFlight) return;
                  setModelSelection(draftId, createModelSelection(provider, model));
                }}
              />
            ) : null}
          </div>

          <div className="space-y-2 rounded-lg border border-input bg-card p-2 shadow-xs">
            <div className="flex items-end gap-2">
              <textarea
                value={question}
                onChange={(event) => handleQuestionChange(event.target.value)}
                placeholder={
                  selectedRefs.length === 0
                    ? "Select thread sources from the sidebar first"
                    : mode === "search"
                      ? "Search selected threads"
                      : "Ask about selected threads"
                }
                className="field-sizing-content max-h-28 min-h-9 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-1.5 text-sm leading-5 outline-none placeholder:text-muted-foreground/72"
                disabled={askInFlight}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border/70 bg-muted/30 px-2 py-1"
                  title={`${preparedAskSources.sourceChars.toLocaleString()} source chars, ${preparedAskSources.estimatedTokens.toLocaleString()} est. ask tokens`}
                >
                  <FileTextIcon className="size-3.5" />
                  {sourceLabel}
                </span>
                {selectedRefs.length > 0 ? (
                  <span
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 transition-colors",
                      preparedAskSources.mode === "complete"
                        ? completeSourcePressure.className
                        : "border-border/70 bg-muted/30",
                    )}
                    title={
                      preparedAskSources.mode === "complete"
                        ? `${completeSourcePressure.label}: ${preparedAskSources.estimatedTokens.toLocaleString()} / ${completeSourcePressure.hardLimit.toLocaleString()} est. ask tokens`
                        : "Relevant chunks are retrieved from selected messages"
                    }
                  >
                    {preparedAskSources.mode === "complete" ? (
                      <CheckCircle2Icon className="size-3.5" />
                    ) : (
                      <SearchIcon className="size-3.5" />
                    )}
                    {preparedAskSources.mode === "complete"
                      ? "Complete source"
                      : "Retrieved source"}
                  </span>
                ) : null}
                {promptTooLarge ? (
                  <span
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-destructive"
                    title={`${preparedAskSources.estimatedTokens.toLocaleString()} est. ask tokens`}
                  >
                    <AlertCircleIcon className="size-3.5" />
                    Ask prompt too large
                  </span>
                ) : null}
              </div>
              <Button
                disabled={!askInFlight && !canSubmit}
                onClick={askInFlight ? stopStreamingAsk : submit}
                title={askInFlight ? "Stop generation" : undefined}
              >
                {askInFlight ? (
                  <SquareIcon className="size-4 fill-current" />
                ) : mode === "search" ? (
                  <SearchIcon className="size-4" />
                ) : (
                  <SendIcon className="size-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto w-full max-w-5xl">
          {!searchResult && !askResult ? (
            <div className="flex min-h-[42vh] items-center justify-center px-5 text-center text-sm text-muted-foreground">
              <p className="max-w-md leading-relaxed">
                Select one or more threads, enter a query, then run Search for folded chunks or Ask
                for one model-backed answer.
              </p>
            </div>
          ) : null}

          {searchResult ? <NotebookSearchResults result={searchResult} /> : null}

          {askResult ? (
            <div className="space-y-3">
              <section
                className={`group/notebook-answer px-1 py-2 ${
                  askResult.error
                    ? "rounded-lg border border-destructive/30 bg-destructive/10 p-4"
                    : ""
                }`}
              >
                {askResult.streaming ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <Loader2Icon className="size-4 animate-spin" />
                        Working...
                      </div>
                      {askResult.streamingText.trim().length > 0 ? (
                        <div className="opacity-0 transition-opacity duration-200 group-hover/notebook-answer:opacity-100">
                          <MessageCopyButton
                            text={askResult.streamingText}
                            size="icon-xs"
                            variant="outline"
                            className="border-border/50 bg-background/35 text-muted-foreground/45 shadow-none hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground/70"
                          />
                        </div>
                      ) : null}
                    </div>
                    {askResult.streamingText.length > 0 ? (
                      <ChatMarkdown text={askResult.streamingText} cwd={project?.cwd} isStreaming />
                    ) : null}
                  </div>
                ) : askResult.error ? (
                  <div className="whitespace-pre-wrap text-sm leading-relaxed">
                    {askResult.text}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {askResult.stopped ? (
                      <div className="text-xs text-muted-foreground">Stopped</div>
                    ) : null}
                    <ChatMarkdown text={askResult.text} cwd={project?.cwd} isStreaming={false} />
                    <div className="flex items-center gap-2">
                      {askUsageFooter ? (
                        <div className="text-xs text-muted-foreground">{askUsageFooter}</div>
                      ) : null}
                      {askResult.text.trim().length > 0 ? (
                        <div className="opacity-0 transition-opacity duration-200 group-hover/notebook-answer:opacity-100">
                          <MessageCopyButton
                            text={askResult.text}
                            size="icon-xs"
                            variant="outline"
                            className="border-border/50 bg-background/35 text-muted-foreground/45 shadow-none hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground/70"
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
              </section>

              {askResult.sources && askResult.sourceMode === "retrieved" && !askResult.streaming ? (
                <details className="rounded-lg border border-border bg-card/40">
                  <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                    Sources
                  </summary>
                  <div className="border-t border-border p-3">
                    <NotebookSearchResults
                      result={askResult.sources}
                      title="Retrieved chunks sent to Ask"
                    />
                  </div>
                </details>
              ) : null}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
