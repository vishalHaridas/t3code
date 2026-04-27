import type { ModelSelection, ProjectId, ProviderKind, ServerProvider } from "@t3tools/contracts";
import { ThreadId as ThreadIdSchema } from "@t3tools/contracts";
import { parseScopedThreadKey } from "@t3tools/client-runtime";
import { createModelSelection } from "@t3tools/shared/model";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  SearchIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

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
import { useServerConfig, useServerKeybindings } from "../rpc/serverState";
import { selectProjectByRef, selectThreadByRef, useStore } from "../store";
import ChatMarkdown from "./ChatMarkdown";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

const NOTEBOOK_PROMPT_LIMIT = 150_000;
const NOTEBOOK_SOURCE_BUDGET_SAFETY_MARGIN = 1_000;
const EMPTY_PROVIDERS: ServerProvider[] = [];

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

function NotebookChunkExcerpt(props: { chunk: NotebookSearchChunk }) {
  const timeRange =
    props.chunk.startedAt === props.chunk.endedAt
      ? formatNotebookTime(props.chunk.startedAt)
      : `${formatNotebookTime(props.chunk.startedAt)} - ${formatNotebookTime(props.chunk.endedAt)}`;

  return (
    <article className="border-t border-border/60 first:border-t-0">
      <div className="flex items-center gap-3 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="w-16 shrink-0 text-right font-mono">
          {props.chunk.startOrdinal === props.chunk.endOrdinal
            ? `M${props.chunk.startOrdinal}`
            : `M${props.chunk.startOrdinal}-${props.chunk.endOrdinal}`}
        </span>
        <span className="h-px flex-1 bg-border/80" />
        <span>{timeRange}</span>
      </div>
      <div className="divide-y divide-border/40">
        {props.chunk.messages.map((message) => (
          <div key={message.id} className="grid grid-cols-[4.25rem_1fr] gap-3 px-3 py-3">
            <div className="select-none text-right text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {message.role}
            </div>
            <div className="min-w-0 text-sm leading-relaxed text-foreground/90">
              <div className="whitespace-pre-wrap">
                {highlightChunkText(message.text, message.matchedTerms)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
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
        <span className="shrink-0 text-xs text-muted-foreground">
          {props.thread.chunks.length} chunk
          {props.thread.chunks.length === 1 ? "" : "s"}
        </span>
      </button>
      {props.collapsed ? null : (
        <div>
          {props.thread.chunks.map((chunk) => (
            <NotebookChunkExcerpt key={chunk.id} chunk={chunk} />
          ))}
        </div>
      )}
    </section>
  );
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
  const finishAsk = useNotebookModeStore((state) => state.finishAsk);
  const failAsk = useNotebookModeStore((state) => state.failAsk);
  const exitNotebookMode = useNotebookModeStore((state) => state.exit);
  const selectedRefs = useMemo(
    () => [...selectedThreadKeys].flatMap((key) => parseScopedThreadKey(key) ?? []),
    [selectedThreadKeys],
  );
  const releaseDetailSubscriptionsRef = useRef<ReadonlyArray<() => void>>([]);
  const [question, setQuestion] = useState("");
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

  const sourceCharBudget = useMemo(() => {
    const promptWithoutSources = buildNotebookPrompt({
      preparedSource: "",
      question: question || " ",
    });
    return Math.max(
      0,
      NOTEBOOK_PROMPT_LIMIT - promptWithoutSources.length - NOTEBOOK_SOURCE_BUDGET_SAFETY_MARGIN,
    );
  }, [question]);
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
  const promptTooLarge = promptPreview.length > NOTEBOOK_PROMPT_LIMIT;
  const askInFlight = askResult?.streaming === true;
  const hasResult = Boolean(searchResult || askResult);
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
      streamUnsubscribe?.();
    };
  }, [streamUnsubscribe]);

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

    const unsubscribe = api.orchestration.notebookTurn(
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
        if (event.type === "error") {
          failAsk(event.message);
          return;
        }
        finishAsk();
      },
    );
    setStreamUnsubscribe(() => unsubscribe);
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
    startAsk,
  ]);

  const submit = useCallback(() => {
    if (mode === "search") {
      submitSearch();
      return;
    }
    submitAsk();
  }, [mode, submitAsk, submitSearch]);

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
            Search selected threads locally, or ask a model-backed question.
          </p>
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
            <div className={mode === "search" ? "opacity-55" : ""}>
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
            </div>
          </div>

          <div className="rounded-lg border border-input bg-card p-2 shadow-xs">
            <div className="flex gap-2">
              <Textarea
                value={question}
                onChange={(event) => handleQuestionChange(event.target.value)}
                placeholder={
                  selectedRefs.length === 0
                    ? "Select thread sources from the sidebar first"
                    : mode === "search"
                      ? "Search selected threads"
                      : "Ask about selected threads"
                }
                className="min-h-20 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
                disabled={askInFlight}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
              <Button className="self-end" disabled={!canSubmit} onClick={submit}>
                {askInFlight ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : mode === "search" ? (
                  <SearchIcon className="size-4" />
                ) : (
                  <SendIcon className="size-4" />
                )}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{sourceLabel}</span>
            <span>-</span>
            <span>{preparedAskSources.sourceChars.toLocaleString()} source chars</span>
            <span>-</span>
            <span>{preparedAskSources.estimatedTokens.toLocaleString()} est. ask tokens</span>
            <span>-</span>
            <span>
              {preparedAskSources.mode === "complete"
                ? "complete ask source"
                : "retrieved ask source"}
            </span>
            {hasResult ? (
              <>
                <span>-</span>
                <span>clear the query to change sources</span>
              </>
            ) : null}
            {promptTooLarge ? (
              <>
                <span>-</span>
                <span className="text-destructive">ask prompt too large</span>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto w-full max-w-5xl">
          {!searchResult && !askResult ? (
            <div className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
              Select one or more threads, enter a query, then run Search for folded chunks or Ask
              for one model-backed answer.
            </div>
          ) : null}

          {searchResult ? <NotebookSearchResults result={searchResult} /> : null}

          {askResult ? (
            <div className="space-y-3">
              <section
                className={`rounded-lg border p-4 ${
                  askResult.error
                    ? "border-destructive/30 bg-destructive/10"
                    : "border-border bg-card"
                }`}
              >
                <div className="mb-3 flex justify-end text-xs text-muted-foreground">
                  <span>
                    {askResult.streaming
                      ? "Working..."
                      : askResult.sourceMode === "complete"
                        ? "complete sources"
                        : "retrieved sources"}
                  </span>
                </div>
                {askResult.streaming ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2Icon className="size-4 animate-spin" />
                    Waiting for the complete answer...
                  </div>
                ) : askResult.error ? (
                  <div className="whitespace-pre-wrap text-sm leading-relaxed">
                    {askResult.text}
                  </div>
                ) : (
                  <ChatMarkdown text={askResult.text} cwd={project?.cwd} isStreaming={false} />
                )}
              </section>

              {askResult.sources && !askResult.streaming ? (
                <details className="rounded-lg border border-border bg-card/40">
                  <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                    Sources
                  </summary>
                  <div className="border-t border-border p-3">
                    {askResult.sourceMode === "complete" ? (
                      <div className="text-sm text-muted-foreground">
                        Ask used complete selected thread messages because they fit the prompt
                        budget.
                      </div>
                    ) : (
                      <NotebookSearchResults
                        result={askResult.sources}
                        title="Retrieved chunks sent to Ask"
                      />
                    )}
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
