import type { Thread } from "./types";

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

export interface PreparedNotebookSource {
  threadCount: number;
  messageCount: number;
  sourceChars: number;
  estimatedTokens: number;
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
  messages: NotebookSearchChunkMessage[];
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

function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]{1,}/g)
      ?.filter((term) => !STOP_WORDS.has(term)) ?? []
  );
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
    "Complete user/assistant messages are included. Tool calls, tool results, diffs, approvals, and system messages are excluded.",
    "",
  ];

  sources.forEach((source, threadIndex) => {
    lines.push(formatThreadHeader(source, threadIndex), "", source.text, "");
  });

  return lines.join("\n").trim();
}

function hasPrefixMatch(text: string, queryTerm: string): boolean {
  return tokenize(text).some((term) => term.startsWith(queryTerm));
}

function matchedTextTerms(text: string, queryTerms: readonly string[]): string[] {
  return queryTerms.filter((term) => hasPrefixMatch(text, term));
}

export function prepareNotebookSources(
  threads: readonly Thread[],
  _question: string,
): PreparedNotebookSource {
  const sources = makeThreadSources(threads);
  const sourceChars = sources.reduce((total, source) => total + source.text.length, 0);
  const messageCount = sources.reduce((total, source) => total + source.messages.length, 0);
  const completePromptSource = formatCompleteSources(sources);

  return {
    threadCount: sources.length,
    messageCount,
    sourceChars,
    estimatedTokens: approximateTokens(completePromptSource.length),
    promptSource: completePromptSource,
  };
}

export function prepareNotebookSearchResult(
  threads: readonly Thread[],
  query: string,
): NotebookSearchResult {
  const sources = makeThreadSources(threads);
  const sourceChars = sources.reduce((total, source) => total + source.text.length, 0);
  const messageCount = sources.reduce((total, source) => total + source.messages.length, 0);
  const queryTerms = [...new Set(tokenize(query))];

  // The UI renders one fold per thread, but only threads with matching chunks
  // are returned. This keeps empty searches explicit at the top level.
  const resultThreads = sources.flatMap((source) => {
    const messagesByOrdinal = new Map(source.messages.map((message) => [message.ordinal, message]));
    const matchingOrdinals = source.messages
      .filter((message) => matchedTextTerms(message.text, queryTerms).length > 0)
      .map((message) => message.ordinal);
    if (matchingOrdinals.length === 0) return [];

    return [
      {
        threadId: source.thread.id,
        title: source.thread.title,
        createdAt: source.thread.createdAt,
        updatedAt: source.thread.updatedAt,
        messages: source.messages.map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
          ordinal: message.ordinal,
          matchedTerms: matchedTextTerms(message.text, queryTerms),
        })),
        chunks: [...matchingOrdinals]
          .toSorted((a, b) => a - b)
          .flatMap((ordinal) => {
            const message = messagesByOrdinal.get(ordinal);
            if (!message) return [];
            const matchedTerms = matchedTextTerms(message.text, queryTerms);
            return [
              {
                id: `${source.thread.id}:${message.ordinal}`,
                text: formatMessage(message),
                startOrdinal: message.ordinal,
                endOrdinal: message.ordinal,
                startedAt: message.createdAt,
                endedAt: message.createdAt,
                matchedTerms,
                messages: [
                  {
                    id: message.id,
                    role: message.role,
                    text: message.text,
                    createdAt: message.createdAt,
                    ordinal: message.ordinal,
                    matchedTerms,
                  },
                ],
              },
            ];
          }),
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
