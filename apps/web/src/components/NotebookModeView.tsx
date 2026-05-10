import type {
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { ThreadId as ThreadIdSchema } from "@t3tools/contracts";
import { parseScopedThreadKey, scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
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
  SquareCheckBigIcon,
  TriangleAlertIcon,
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
import { isElectron } from "../env";
import { useSettings } from "../hooks/useSettings";
import { useNotebookModeStore } from "../notebookModeStore";
import type {
  NotebookSearchChunk,
  NotebookSearchResult,
  NotebookSearchThreadResult,
} from "../notebookRetrieval";
import { prepareNotebookSources } from "../notebookRetrieval";
import NotebookSearchWorker from "../notebookSearch.worker?worker";
import type { NotebookSearchWorkerResponse } from "../notebookSearch.worker";
import { formatContextWindowTokens } from "../lib/contextWindow";
import { deriveLogicalProjectKeyFromSettings } from "../logicalProject";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { useServerConfig, useServerKeybindings } from "../rpc/serverState";
import {
  selectProjectByRef,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  selectThreadByRef,
  useStore,
} from "../store";
import ChatMarkdown from "./ChatMarkdown";
import { MessageCopyButton } from "./chat/MessageCopyButton";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { NotebookModeIcon } from "./NotebookModeIcon";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { SidebarTrigger } from "./ui/sidebar";

const EMPTY_PROVIDERS: ServerProvider[] = [];

function getContextHealth(input: {
  estimatedTokens: number;
  promptLimitChars: number;
  promptTooLarge: boolean;
  hasSources: boolean;
}) {
  const hardLimit = Math.max(1, Math.floor(input.promptLimitChars / 4));
  if (!input.hasSources) {
    return {
      className: "text-muted-foreground",
      icon: "healthy" as const,
      label: "Context Health",
      title: "Select sources to estimate how reliably Ask can use the available context.",
      hardLimit,
    };
  }
  if (input.promptTooLarge) {
    return {
      className: "text-destructive",
      icon: "error" as const,
      label: "Ask prompt too large",
      title: "Prompt exceeds the available context budget. Deselect sources to continue.",
      hardLimit,
    };
  }
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
      className: "text-red-800 dark:text-red-200",
      icon: "warning" as const,
      label: "Context Health: Unstable",
      title: "High risk of context confusion, incorrect associations, and unreliable retrieval.",
      hardLimit,
    };
  }
  if (danger >= 0.7) {
    return {
      className: "text-red-700 dark:text-red-200",
      icon: "warning" as const,
      label: "Context Health: Degrading",
      title: "Important details may be overlooked as context becomes dense and semantically noisy.",
      hardLimit,
    };
  }
  if (danger >= 0.5) {
    return {
      className: "text-orange-800 dark:text-orange-200",
      icon: "healthy" as const,
      label: "Context Health: Strained",
      title: "Growing context size may reduce recall accuracy and increase missed details.",
      hardLimit,
    };
  }
  if (danger >= 0.3) {
    return {
      className: "text-yellow-800 dark:text-yellow-100",
      icon: "healthy" as const,
      label: "Context Health: Strained",
      title: "Growing context size may reduce recall accuracy and increase missed details.",
      hardLimit,
    };
  }
  return {
    className: "text-emerald-800 dark:text-emerald-100",
    icon: "healthy" as const,
    label: "Context Health: Healthy",
    title: "The model should reliably track context and retrieve relevant details.",
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
  const pattern = new RegExp(escapedTerms.join("|"), "gi");
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
                <button
                  type="button"
                  className="flex h-5 w-full items-center justify-center border-b border-border/40 bg-muted/10 text-muted-foreground/25 transition-colors hover:bg-muted/30 hover:text-foreground/75 disabled:cursor-default disabled:hover:bg-muted/10 disabled:hover:text-muted-foreground/25"
                  disabled={!canExpandPrevious || !previousChunkId}
                  title="Reveal previous chat"
                  onClick={() => {
                    if (previousChunkId) expandChunk(previousChunkId, "previous");
                  }}
                >
                  <ArrowUpIcon className="size-3.5" />
                </button>
                <div className="divide-y divide-border/35">
                  {messages.map((message) => (
                    <NotebookSearchMessage
                      key={message.id}
                      message={message}
                      matchedTerms={range.matchedTerms}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  className="flex h-5 w-full items-center justify-center border-t border-border/40 bg-muted/10 text-muted-foreground/25 transition-colors hover:bg-muted/30 hover:text-foreground/75 disabled:cursor-default disabled:hover:bg-muted/10 disabled:hover:text-muted-foreground/25"
                  disabled={!canExpandNext || !nextChunkId}
                  title="Reveal next chat"
                  onClick={() => {
                    if (nextChunkId) expandChunk(nextChunkId, "next");
                  }}
                >
                  <ArrowDownIcon className="size-3.5" />
                </button>
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
  const searchRun = useNotebookModeStore((state) => state.searchRun);
  const searchResult = useNotebookModeStore((state) => state.searchResult);
  const askResult = useNotebookModeStore((state) => state.askResult);
  const setMode = useNotebookModeStore((state) => state.setMode);
  const setSourceAddBlocked = useNotebookModeStore((state) => state.setSourceAddBlocked);
  const setSourceThreads = useNotebookModeStore((state) => state.setSourceThreads);
  const clearResults = useNotebookModeStore((state) => state.clearResults);
  const clearSourceThreads = useNotebookModeStore((state) => state.clearSourceThreads);
  const startSearch = useNotebookModeStore((state) => state.startSearch);
  const finishSearch = useNotebookModeStore((state) => state.finishSearch);
  const failSearch = useNotebookModeStore((state) => state.failSearch);
  const cancelSearch = useNotebookModeStore((state) => state.cancelSearch);
  const stopSearch = useNotebookModeStore((state) => state.stopSearch);
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
  const searchWorkerRef = useRef<Worker | null>(null);
  const searchRunIdRef = useRef<string | null>(null);
  const [question, setQuestion] = useState("");
  const settings = useSettings();
  const keybindings = useServerKeybindings();
  const serverConfig = useServerConfig();
  const providers = serverConfig?.providers ?? EMPTY_PROVIDERS;
  const providerInstanceEntries = useMemo(
    () => deriveProviderInstanceEntries(providers),
    [providers],
  );
  const providerModels = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers),
    [providers, settings],
  );
  const allProjectThreadKeys = useStore(
    useShallow(
      useMemo(
        () => (state) => {
          if (!activeProjectKey) return [];
          return selectSidebarThreadsAcrossEnvironments(state).flatMap((thread) => {
            const threadProject = selectProjectByRef(state, {
              environmentId: thread.environmentId,
              projectId: thread.projectId,
            });
            if (!threadProject) return [];
            const threadProjectKey = deriveLogicalProjectKeyFromSettings(threadProject, settings);
            if (threadProjectKey !== activeProjectKey) return [];
            return [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))];
          });
        },
        [activeProjectKey, settings],
      ),
    ),
  );
  const activeNotebookProject = useStore(
    useMemo(
      () => (state) => {
        if (!activeProjectKey) return undefined;
        return selectProjectsAcrossEnvironments(state).find(
          (candidate) =>
            deriveLogicalProjectKeyFromSettings(candidate, settings) === activeProjectKey,
        );
      },
      [activeProjectKey, settings],
    ),
  );
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
  const draftActiveInstanceId =
    useComposerDraftStore((state) => {
      const draft = activeProjectKey
        ? state.getComposerDraft(DraftId.make(`notebook:${activeProjectKey}`))
        : null;
      return draft?.activeProvider ?? null;
    }) ?? null;
  const selectedInstanceId: ProviderInstanceId =
    draftActiveInstanceId ??
    selectedThreads[0]?.modelSelection.instanceId ??
    project?.defaultModelSelection?.instanceId ??
    providerInstanceEntries.find((entry) => entry.enabled && entry.isAvailable)?.instanceId ??
    providerInstanceEntries[0]?.instanceId ??
    ("codex" as ProviderInstanceId);
  const selectedProvider: ProviderDriverKind =
    providerInstanceEntries.find((entry) => entry.instanceId === selectedInstanceId)?.driverKind ??
    ("codex" as ProviderDriverKind);
  const draftId = DraftId.make(`notebook:${activeProjectKey ?? "inactive"}`);
  const effectiveModelState = useEffectiveComposerModelState({
    draftId,
    providers,
    selectedProvider,
    selectedInstanceId,
    threadModelSelection: selectedThreads[0]?.modelSelection,
    projectModelSelection: project?.defaultModelSelection,
    settings,
  });
  const selectedModelSelection = effectiveModelState.selectedModel
    ? createModelSelection(
        selectedInstanceId,
        effectiveModelState.selectedModel,
        effectiveModelState.modelOptions?.[selectedInstanceId],
      )
    : (selectedThreads[0]?.modelSelection ?? project?.defaultModelSelection);
  const setModelSelection = useComposerDraftStore((state) => state.setModelSelection);
  const notebookPromptLimit = useMemo(
    () => clampNotebookPromptCharLimit(getNotebookPromptCharLimit(selectedModelSelection)),
    [selectedModelSelection],
  );

  const preparedAskSources = useMemo(
    () => prepareNotebookSources(selectedThreads, question || " "),
    [question, selectedThreads],
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
  const askPromptTooLarge = mode === "ask" && promptTooLarge;
  const searchInFlight = searchRun?.running === true;
  const askInFlight = askResult?.streaming === true;
  const mutableControlsDisabled = askInFlight || searchInFlight;
  const canSubmit =
    selectedRefs.length > 0 &&
    loadingSourceCount === 0 &&
    question.trim().length > 0 &&
    !searchInFlight &&
    !askInFlight &&
    Boolean(project?.cwd) &&
    (mode === "search" || (!askPromptTooLarge && Boolean(selectedModelSelection)));

  useEffect(() => {
    setSourceAddBlocked(askPromptTooLarge);
    return () => setSourceAddBlocked(false);
  }, [askPromptTooLarge, setSourceAddBlocked]);

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
      searchWorkerRef.current?.terminate();
      searchWorkerRef.current = null;
      searchRunIdRef.current = null;
    };
  }, []);

  const terminateSearchWorker = useCallback(() => {
    // Terminating is the hard cancel: the browser stops the worker even if it is
    // in the middle of scanning a huge message corpus.
    searchWorkerRef.current?.terminate();
    searchWorkerRef.current = null;
    searchRunIdRef.current = null;
  }, []);

  const submitSearch = useCallback(() => {
    const query = question.trim();
    if (!canSubmit || query.length === 0) return;
    terminateSearchWorker();
    const runId = crypto.randomUUID();
    const worker = new NotebookSearchWorker();
    searchWorkerRef.current = worker;
    searchRunIdRef.current = runId;
    startSearch(query);

    worker.addEventListener("message", (event: MessageEvent<NotebookSearchWorkerResponse>) => {
      const message = event.data;
      if (message.runId !== searchRunIdRef.current) return;
      terminateSearchWorker();
      if (message.type === "result") {
        finishSearch(query, message.result);
        return;
      }
      if (message.type === "error") {
        failSearch(query, message.message);
        return;
      }
      stopSearch();
    });
    worker.addEventListener("error", () => {
      if (searchRunIdRef.current !== runId) return;
      terminateSearchWorker();
      failSearch(query, "Notebook search worker failed.");
    });

    // Threads are copied into the worker by structured clone. That is deliberate
    // for this prototype: the worker receives a stable snapshot of the selected
    // sources for the submitted query.
    worker.postMessage(
      {
        type: "search",
        runId,
        query,
        threads: selectedThreads,
      },
      [],
    );
  }, [
    canSubmit,
    failSearch,
    finishSearch,
    question,
    selectedThreads,
    startSearch,
    stopSearch,
    terminateSearchWorker,
  ]);

  const submitAsk = useCallback(() => {
    const query = question.trim();
    if (!canSubmit || !project || !selectedModelSelection || query.length === 0) return;
    const api = readEnvironmentApi(project.environmentId);
    if (!api) return;

    const prompt = buildNotebookPrompt({
      preparedSource: preparedAskSources.promptSource,
      question: query,
    });

    startAsk(query);

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
    preparedAskSources.promptSource,
    project,
    question,
    selectedModelSelection,
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

  const stopRunningSearch = useCallback(() => {
    terminateSearchWorker();
    stopSearch();
  }, [stopSearch, terminateSearchWorker]);

  const handleQuestionChange = useCallback(
    (value: string) => {
      if (searchWorkerRef.current) {
        terminateSearchWorker();
        cancelSearch();
      }
      setQuestion(value);
      if (value.trim().length === 0) {
        clearResults();
      }
    },
    [cancelSearch, clearResults, terminateSearchWorker],
  );
  const clearNotebookSources = useCallback(() => {
    if (selectedRefs.length === 0) {
      if (allProjectThreadKeys.length === 0) return;
      setSourceThreads(allProjectThreadKeys);
      clearResults();
      return;
    }
    clearSourceThreads();
    clearResults();
  }, [
    allProjectThreadKeys,
    clearResults,
    clearSourceThreads,
    selectedRefs.length,
    setSourceThreads,
  ]);

  const sourceLabel =
    loadingSourceCount > 0
      ? `${selectedThreads.length}/${selectedRefs.length}`
      : selectedRefs.length;
  const contextHealth = getContextHealth({
    estimatedTokens: preparedAskSources.estimatedTokens,
    promptLimitChars: notebookPromptLimit,
    promptTooLarge: askPromptTooLarge,
    hasSources: selectedRefs.length > 0,
  });
  const sourceTitle = `${preparedAskSources.estimatedTokens.toLocaleString()} / ${contextHealth.hardLimit.toLocaleString()} est. ask tokens; ${preparedAskSources.sourceChars.toLocaleString()} source chars${
    selectedRefs.length > 0 ? ". Click to deselect all sources." : ". Click to select all sources."
  }`;
  const askUsageFooter = askResult
    ? formatNotebookUsageFooter({
        inputTokens: askResult.usage?.lastInputTokens ?? askResult.usage?.inputTokens ?? null,
        outputTokens: askResult.usage?.lastOutputTokens ?? askResult.usage?.outputTokens ?? null,
      })
    : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header
        className={cn(
          "border-b border-border px-3 sm:px-5",
          isElectron
            ? "drag-region flex h-[52px] items-center wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]"
            : "py-2 sm:py-3",
        )}
      >
        <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <h2 className="min-w-0 shrink truncate text-sm font-medium text-foreground">
              Notebook mode
            </h2>
            {activeNotebookProject ? (
              <Badge variant="outline" className="min-w-0 shrink overflow-hidden">
                <span className="min-w-0 truncate">{activeNotebookProject.name}</span>
              </Badge>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
            <Button
              className="shrink-0"
              variant="outline"
              size="xs"
              onClick={exitNotebookMode}
              disabled={askInFlight}
              title="Exit notebook mode"
              aria-label="Exit notebook mode"
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        </div>
      </header>

      <div className="shrink-0 border-b border-border px-5 py-4">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex gap-1">
              {(["search", "ask"] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                    mode === candidate
                      ? "bg-muted/50 text-foreground"
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
                activeInstanceId={selectedInstanceId}
                model={effectiveModelState.selectedModel}
                lockedProvider={null}
                instanceEntries={providerInstanceEntries}
                keybindings={keybindings}
                modelOptionsByInstance={providerModels}
                onInstanceModelChange={(instanceId, model) => {
                  if (askInFlight) return;
                  setModelSelection(draftId, createModelSelection(instanceId, model));
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
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <button
                  type="button"
                  className="group inline-flex h-6 w-10 cursor-pointer items-center gap-1 rounded px-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                  title={sourceTitle}
                  onClick={clearNotebookSources}
                >
                  <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center">
                    {selectedRefs.length > 0 ? (
                      <>
                        <FileTextIcon className="absolute size-3.5 transition-opacity group-hover:opacity-0" />
                        <XIcon className="absolute size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
                      </>
                    ) : (
                      <>
                        <FileTextIcon className="absolute size-3.5 transition-opacity group-hover:opacity-0" />
                        <SquareCheckBigIcon className="absolute size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
                      </>
                    )}
                  </span>
                  <span className="w-3 text-left tabular-nums">{sourceLabel}</span>
                </button>
                {mode === "ask" ? (
                  <>
                    <span className="h-4 w-px bg-border/70" aria-hidden="true" />
                    <span
                      className={cn(
                        "inline-flex h-6 cursor-help items-center gap-1.5 transition-colors",
                        contextHealth.className,
                      )}
                      title={contextHealth.title}
                    >
                      {contextHealth.icon === "error" ? (
                        <AlertCircleIcon className="size-3.5" />
                      ) : contextHealth.icon === "warning" ? (
                        <TriangleAlertIcon className="size-3.5" />
                      ) : (
                        <CheckCircle2Icon className="size-3.5" />
                      )}
                      {contextHealth.label}
                    </span>
                  </>
                ) : null}
              </div>
              <Button
                disabled={!searchInFlight && !askInFlight && !canSubmit}
                onClick={
                  searchInFlight ? stopRunningSearch : askInFlight ? stopStreamingAsk : submit
                }
                title={searchInFlight ? "Stop search" : askInFlight ? "Stop generation" : undefined}
              >
                {searchInFlight || askInFlight ? (
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
          {!searchRun && !searchResult && !askResult ? (
            <div className="flex min-h-[42vh] items-center justify-center px-5 text-muted-foreground">
              <div className="w-full max-w-2xl">
                <div className="mb-8 flex items-center gap-4">
                  <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground/70">
                    Notebook
                  </span>
                  <span className="h-px flex-1 bg-border/70" aria-hidden="true" />
                </div>
                <div className="space-y-5">
                  <p className="text-xl font-medium tracking-normal text-foreground/90">
                    Select one or more threads,{" "}
                    <span className="font-normal text-muted-foreground">then enter a query.</span>
                  </p>
                  <div className="space-y-3 pl-1">
                    <div className="grid grid-cols-[1.5rem_1fr] items-baseline gap-3 text-sm">
                      <SearchIcon className="size-4 self-center text-muted-foreground/70" />
                      <span className="min-w-0 truncate leading-relaxed">
                        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-foreground/80">
                          Search
                        </span>{" "}
                        selected thread conversations for exact matches.
                      </span>
                    </div>
                    <div className="grid grid-cols-[1.5rem_1fr] items-baseline gap-3 text-sm">
                      <NotebookModeIcon className="size-4 self-center text-muted-foreground/70" />
                      <span className="min-w-0 truncate leading-relaxed">
                        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-foreground/80">
                          Ask
                        </span>{" "}
                        across the selected conversation history.
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {searchRun ? (
            <div className="mb-3 flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
              {searchRun.running ? (
                <>
                  <Loader2Icon className="size-4 animate-spin" />
                  Searching...
                </>
              ) : searchRun.error ? (
                <span className="text-destructive">{searchRun.error}</span>
              ) : searchRun.stopped ? (
                <span>Search stopped.</span>
              ) : null}
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
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
