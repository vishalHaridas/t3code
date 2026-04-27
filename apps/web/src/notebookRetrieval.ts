import type { Thread } from "./types";

const DEFAULT_SOURCE_CHAR_BUDGET = 70_000;
const SEGMENT_TARGET_CHARS = 4_800;
const SEGMENT_OVERLAP_MESSAGES = 1;
const MAX_SEGMENTS_PER_THREAD = 14;
const MAX_ANCHORS_PER_THREAD = 8;
const TOKEN_ESTIMATE_CHARS = 4;

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "any",
  "are",
  "because",
  "been",
  "but",
  "can",
  "did",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "into",
  "its",
  "just",
  "like",
  "not",
  "now",
  "our",
  "out",
  "over",
  "should",
  "that",
  "the",
  "then",
  "there",
  "this",
  "was",
  "what",
  "when",
  "where",
  "which",
  "why",
  "will",
  "with",
  "would",
  "you",
]);

const FUTURE_ANCHOR_PATTERNS = [
  /\b(back to|come back|circle back|get back)\b/i,
  /\b(do|fix|handle|add|support|build|revisit|consider|investigate)\b.{0,80}\b(later|next|future|eventually|follow[- ]?up)\b/i,
  /\b(later|next|future|eventually|follow[- ]?up)\b.{0,80}\b(do|fix|handle|add|support|build|revisit|consider|investigate)\b/i,
  /\b(need to|should|we should|we can|todo|pin|park)\b/i,
];

export interface PreparedNotebookSource {
  threadCount: number;
  messageCount: number;
  sourceChars: number;
  sourceCharBudget: number;
  estimatedTokens: number;
  mode: "complete" | "retrieved";
  promptSource: string;
}

export interface NotebookSearchChunkMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  ordinal: number;
  matchedTerms: string[];
}

export interface NotebookSearchChunk {
  id: string;
  text: string;
  startOrdinal: number;
  endOrdinal: number;
  startedAt: string;
  endedAt: string;
  matchedTerms: string[];
  messages: NotebookSearchChunkMessage[];
}

export interface NotebookSearchThreadResult {
  threadId: Thread["id"];
  title: string;
  createdAt: string;
  updatedAt?: string | undefined;
  chunks: NotebookSearchChunk[];
}

export interface NotebookSearchResult {
  query: string;
  queryTerms: string[];
  threadCount: number;
  messageCount: number;
  sourceChars: number;
  estimatedTokens: number;
  threads: NotebookSearchThreadResult[];
}

interface PrepareNotebookSourcesOptions {
  sourceCharBudget?: number;
}

interface NotebookMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  ordinal: number;
}

interface NotebookThreadSource {
  thread: Thread;
  messages: NotebookMessage[];
  text: string;
}

interface Segment {
  threadIndex: number;
  thread: Thread;
  startOrdinal: number;
  endOrdinal: number;
  startedAt: string;
  endedAt: string;
  messages: NotebookMessage[];
  text: string;
  terms: Map<string, number>;
}

interface Anchor {
  text: string;
}

function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]{1,}/g)
      ?.filter((term) => !STOP_WORDS.has(term)) ?? []
  );
}

function termCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of tokenize(text)) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

function approximateTokens(chars: number): number {
  return Math.ceil(chars / TOKEN_ESTIMATE_CHARS);
}

function formatMessage(message: NotebookMessage): string {
  return `### ${message.role.toUpperCase()}\n\n${message.text}`;
}

function makeThreadSources(threads: readonly Thread[]): NotebookThreadSource[] {
  return threads.map((thread) => {
    const messages = thread.messages
      .filter(
        (message) =>
          !message.streaming && (message.role === "user" || message.role === "assistant"),
      )
      .map((message, index) => ({
        id: String(message.id),
        role: message.role as "user" | "assistant",
        text: message.text.trim(),
        createdAt: message.createdAt,
        ordinal: index + 1,
      }))
      .filter((message) => message.text.length > 0);
    return {
      thread,
      messages,
      text: messages.map(formatMessage).join("\n\n"),
    };
  });
}

function formatThreadHeader(source: NotebookThreadSource, threadIndex: number): string {
  const { thread, messages } = source;
  const lines = [`## Thread ${threadIndex + 1}: ${thread.title}`, ""];
  lines.push(`- Created: ${thread.createdAt}`);
  if (thread.updatedAt) {
    lines.push(`- Updated: ${thread.updatedAt}`);
  }
  lines.push(`- Included messages: ${messages.length}`);
  lines.push(`- Approx tokens: ${approximateTokens(source.text.length)}`);
  return lines.join("\n");
}

function formatCompleteSources(sources: readonly NotebookThreadSource[]): string {
  const lines = [
    "# Selected T3 Code Threads",
    "",
    "The selected sources fit in the notebook budget, so complete user/assistant messages are included. Tool calls, tool results, diffs, approvals, and system messages are excluded.",
    "",
  ];

  sources.forEach((source, threadIndex) => {
    lines.push(formatThreadHeader(source, threadIndex), "", source.text, "");
  });

  return lines.join("\n").trim();
}

function buildSegments(sources: readonly NotebookThreadSource[]): Segment[] {
  const segments: Segment[] = [];

  sources.forEach((source, threadIndex) => {
    let start = 0;
    while (start < source.messages.length) {
      const segmentMessages: NotebookMessage[] = [];
      let chars = 0;
      let cursor = start;
      while (
        cursor < source.messages.length &&
        (chars < SEGMENT_TARGET_CHARS || segmentMessages.length < 2)
      ) {
        const message = source.messages[cursor];
        if (!message) break;
        segmentMessages.push(message);
        chars += message.text.length;
        cursor += 1;
      }

      if (segmentMessages.length === 0) break;
      const text = segmentMessages.map(formatMessage).join("\n\n");
      const first = segmentMessages[0];
      const last = segmentMessages[segmentMessages.length - 1];
      segments.push({
        threadIndex,
        thread: source.thread,
        startOrdinal: first?.ordinal ?? 1,
        endOrdinal: last?.ordinal ?? first?.ordinal ?? 1,
        startedAt: first?.createdAt ?? source.thread.createdAt,
        endedAt: last?.createdAt ?? first?.createdAt ?? source.thread.createdAt,
        messages: segmentMessages,
        text,
        terms: termCounts(text),
      });

      if (cursor >= source.messages.length) break;
      start = Math.max(cursor - SEGMENT_OVERLAP_MESSAGES, start + 1);
    }
  });

  return segments;
}

function inverseDocumentFrequency(segments: readonly Segment[]): Map<string, number> {
  const documentFrequency = new Map<string, number>();
  for (const segment of segments) {
    for (const term of segment.terms.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [term, frequency] of documentFrequency) {
    idf.set(term, Math.log(1 + (segments.length + 1) / (frequency + 0.5)));
  }
  return idf;
}

function queryWantsUserVoice(question: string): boolean {
  return /\b(i|me|my|ask|asked|say|said|tell|told)\b/i.test(question);
}

function queryWantsChronology(question: string): boolean {
  return /\b(timeline|evolve|evolved|over time|progress|changed|history|first|later|then|eventually)\b/i.test(
    question,
  );
}

function queryWantsFuturePlans(question: string): boolean {
  return /\b(future|later|next|planned|plans|todo|to do|decided|should|get back|come back|revisit|follow[- ]?up)\b/i.test(
    question,
  );
}

function scoreSegment(
  segment: Segment,
  queryTerms: readonly string[],
  idf: ReadonlyMap<string, number>,
  question: string,
): number {
  let score = 0;
  for (const term of queryTerms) {
    const frequency = [...segment.terms].reduce(
      (total, [segmentTerm, count]) => total + (segmentTerm.startsWith(term) ? count : 0),
      0,
    );
    if (frequency > 0) {
      score += (1 + Math.log(frequency)) * (idf.get(term) ?? 1);
    }
  }

  if (queryWantsUserVoice(question) && /\n### USER\n/.test(segment.text)) {
    score += 0.6;
  }
  if (
    queryWantsFuturePlans(question) &&
    FUTURE_ANCHOR_PATTERNS.some((pattern) => pattern.test(segment.text))
  ) {
    score += 2.5;
  }

  return score;
}

function hasPrefixMatch(text: string, queryTerm: string): boolean {
  return tokenize(text).some((term) => term.startsWith(queryTerm));
}

function matchedTextTerms(text: string, queryTerms: readonly string[]): string[] {
  return queryTerms.filter((term) => hasPrefixMatch(text, term));
}

function matchedSegmentTerms(segment: Segment, queryTerms: readonly string[]): string[] {
  return matchedTextTerms(segment.text, queryTerms);
}

function collectAnchors(sources: readonly NotebookThreadSource[], question: string): Anchor[] {
  if (!queryWantsFuturePlans(question)) return [];

  const anchors: Anchor[] = [];
  sources.forEach((source) => {
    for (const message of source.messages) {
      const sentences = message.text
        .split(/(?<=[.!?])\s+|\n+/)
        .map((sentence) => sentence.trim())
        .filter(Boolean);
      for (const sentence of sentences) {
        if (!FUTURE_ANCHOR_PATTERNS.some((pattern) => pattern.test(sentence))) continue;
        anchors.push({
          text: sentence,
        });
        break;
      }
    }
  });

  return anchors.slice(0, sources.length * MAX_ANCHORS_PER_THREAD);
}

function selectSegments(
  sources: readonly NotebookThreadSource[],
  question: string,
): { segments: Segment[]; anchors: Anchor[] } {
  const segments = buildSegments(sources);
  const idf = inverseDocumentFrequency(segments);
  const queryTerms = [...new Set(tokenize(question))];
  const scored = segments
    .map((segment) => ({
      segment,
      score: scoreSegment(segment, queryTerms, idf, question),
    }))
    .toSorted((a, b) => b.score - a.score);

  const selected = new Map<string, Segment>();
  const perThreadCount = new Map<number, number>();
  const addSegment = (segment: Segment) => {
    const key = `${segment.thread.id}:${segment.startOrdinal}:${segment.endOrdinal}`;
    const count = perThreadCount.get(segment.threadIndex) ?? 0;
    if (count >= MAX_SEGMENTS_PER_THREAD) return;
    selected.set(key, segment);
    perThreadCount.set(segment.threadIndex, count + 1);
  };

  for (const source of sources) {
    const threadSegments = segments.filter((segment) => segment.thread.id === source.thread.id);
    if (threadSegments[0]) addSegment(threadSegments[0]);
    const last = threadSegments[threadSegments.length - 1];
    if (last) addSegment(last);
  }

  for (const { segment, score } of scored) {
    if (score <= 0 && selected.size > 0) continue;
    addSegment(segment);
  }

  if (queryWantsChronology(question)) {
    for (const source of sources) {
      const threadSegments = segments.filter((segment) => segment.thread.id === source.thread.id);
      const stride = Math.max(1, Math.floor(threadSegments.length / 4));
      for (let index = 0; index < threadSegments.length; index += stride) {
        const segment = threadSegments[index];
        if (segment) addSegment(segment);
      }
    }
  }

  const anchors = collectAnchors(sources, question);
  for (const anchor of anchors) {
    const containing = segments.find((segment) => segment.text.includes(anchor.text));
    if (containing) {
      addSegment(containing);
    }
  }

  return {
    segments: [...selected.values()].toSorted(
      (a, b) => a.threadIndex - b.threadIndex || a.startOrdinal - b.startOrdinal,
    ),
    anchors,
  };
}

function selectSearchSegments(
  sources: readonly NotebookThreadSource[],
  query: string,
): { segments: Segment[]; queryTerms: string[] } {
  const segments = buildSegments(sources);
  const idf = inverseDocumentFrequency(segments);
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) {
    return { segments: [], queryTerms };
  }

  // Search mode is intentionally stricter than Ask retrieval: it only shows
  // windows with prefix token matches, so "test" finds "tests" and "testing"
  // without drifting into fuzzy/semantic behavior.
  const selected = segments
    .map((segment) => ({
      segment,
      score: scoreSegment(segment, queryTerms, idf, query),
      matchedTerms: matchedSegmentTerms(segment, queryTerms),
    }))
    .filter((item) => item.score > 0 && item.matchedTerms.length > 0)
    .toSorted(
      (a, b) =>
        a.segment.threadIndex - b.segment.threadIndex ||
        b.score - a.score ||
        a.segment.startOrdinal - b.segment.startOrdinal,
    );

  const perThreadCount = new Map<number, number>();
  const capped: Segment[] = [];
  for (const item of selected) {
    const count = perThreadCount.get(item.segment.threadIndex) ?? 0;
    if (count >= MAX_SEGMENTS_PER_THREAD) continue;
    perThreadCount.set(item.segment.threadIndex, count + 1);
    capped.push(item.segment);
  }

  return {
    segments: capped.toSorted(
      (a, b) =>
        a.threadIndex - b.threadIndex ||
        a.startedAt.localeCompare(b.startedAt) ||
        a.startOrdinal - b.startOrdinal,
    ),
    queryTerms,
  };
}

function formatRetrievedSources(input: {
  sources: readonly NotebookThreadSource[];
  question: string;
  segments: readonly Segment[];
  anchors: readonly Anchor[];
  sourceCharBudget: number;
}): string {
  const lines = [
    "# Prepared T3 Code Thread Sources",
    "",
    "The selected sources were too large to include completely, so this prompt includes a local multi-resolution retrieval pack. Tool calls, tool results, diffs, approvals, and system messages are excluded.",
    "",
    "## Source Map",
    "",
  ];

  input.sources.forEach((source, threadIndex) => {
    lines.push(formatThreadHeader(source, threadIndex), "");
  });

  if (input.anchors.length > 0) {
    lines.push("## Planning / Follow-up Anchors", "");
    input.anchors.forEach((anchor) => {
      lines.push(`- ${anchor.text}`);
    });
    lines.push("");
  }

  lines.push("## Retrieved Conversation Windows", "");
  let chars = lines.join("\n").length;
  for (const segment of input.segments) {
    const block = [`### ${segment.thread.title}`, "", segment.text, ""].join("\n");
    if (chars + block.length > input.sourceCharBudget) break;
    lines.push(block);
    chars += block.length;
  }

  return lines.join("\n").trim();
}

export function prepareNotebookSources(
  threads: readonly Thread[],
  question: string,
  options: PrepareNotebookSourcesOptions = {},
): PreparedNotebookSource {
  const sourceCharBudget = Math.max(0, options.sourceCharBudget ?? DEFAULT_SOURCE_CHAR_BUDGET);
  const sources = makeThreadSources(threads);
  const sourceChars = sources.reduce((total, source) => total + source.text.length, 0);
  const messageCount = sources.reduce((total, source) => total + source.messages.length, 0);
  const completePromptSource = formatCompleteSources(sources);

  if (completePromptSource.length <= sourceCharBudget) {
    return {
      threadCount: sources.length,
      messageCount,
      sourceChars,
      sourceCharBudget,
      estimatedTokens: approximateTokens(completePromptSource.length),
      mode: "complete",
      promptSource: completePromptSource,
    };
  }

  const { segments, anchors } = selectSegments(sources, question);
  const promptSource = formatRetrievedSources({
    sources,
    question,
    segments,
    anchors,
    sourceCharBudget,
  });
  return {
    threadCount: sources.length,
    messageCount,
    sourceChars,
    sourceCharBudget,
    estimatedTokens: approximateTokens(promptSource.length),
    mode: "retrieved",
    promptSource,
  };
}

export function prepareNotebookSearchResult(
  threads: readonly Thread[],
  query: string,
): NotebookSearchResult {
  const sources = makeThreadSources(threads);
  const sourceChars = sources.reduce((total, source) => total + source.text.length, 0);
  const messageCount = sources.reduce((total, source) => total + source.messages.length, 0);
  const { segments, queryTerms } = selectSearchSegments(sources, query);
  const segmentsByThread = new Map<number, Segment[]>();

  for (const segment of segments) {
    const existing = segmentsByThread.get(segment.threadIndex) ?? [];
    existing.push(segment);
    segmentsByThread.set(segment.threadIndex, existing);
  }

  // The UI renders one fold per thread, but only threads with matching chunks
  // are returned. This keeps empty searches explicit at the top level.
  const resultThreads = sources.flatMap((source, threadIndex) => {
    const threadSegments = segmentsByThread.get(threadIndex) ?? [];
    if (threadSegments.length === 0) return [];
    return [
      {
        threadId: source.thread.id,
        title: source.thread.title,
        createdAt: source.thread.createdAt,
        updatedAt: source.thread.updatedAt,
        chunks: threadSegments
          .toSorted(
            (a, b) => a.startedAt.localeCompare(b.startedAt) || a.startOrdinal - b.startOrdinal,
          )
          .map((segment) => ({
            id: `${source.thread.id}:${segment.startOrdinal}:${segment.endOrdinal}`,
            text: segment.text,
            startOrdinal: segment.startOrdinal,
            endOrdinal: segment.endOrdinal,
            startedAt: segment.startedAt,
            endedAt: segment.endedAt,
            matchedTerms: matchedSegmentTerms(segment, queryTerms),
            // Keep message structure for the UI. It avoids parsing "### USER"
            // text back into roles and lets Search reuse chat-like rendering.
            messages: segment.messages.map((message) => ({
              id: message.id,
              role: message.role,
              text: message.text,
              createdAt: message.createdAt,
              ordinal: message.ordinal,
              matchedTerms: matchedTextTerms(message.text, queryTerms),
            })),
          })),
      },
    ];
  });

  const resultChars = resultThreads.reduce(
    (total, thread) => total + thread.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
    0,
  );

  return {
    query: query.trim(),
    queryTerms,
    threadCount: sources.length,
    messageCount,
    sourceChars,
    estimatedTokens: approximateTokens(resultChars),
    threads: resultThreads,
  };
}
