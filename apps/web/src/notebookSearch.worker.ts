import type { Thread } from "./types";
import { prepareNotebookSearchResult } from "./notebookRetrieval";

export type NotebookSearchWorkerRequest =
  | {
      type: "search";
      runId: string;
      query: string;
      threads: Thread[];
    }
  | {
      type: "cancel";
      runId: string;
    };

export type NotebookSearchWorkerResponse =
  | {
      type: "result";
      runId: string;
      result: ReturnType<typeof prepareNotebookSearchResult>;
    }
  | {
      type: "cancelled";
      runId: string;
    }
  | {
      type: "error";
      runId: string;
      message: string;
    };

const cancelledRunIds = new Set<string>();

self.addEventListener("message", (event: MessageEvent<NotebookSearchWorkerRequest>) => {
  const message = event.data;

  if (message.type === "cancel") {
    cancelledRunIds.add(message.runId);
    postMessage({ type: "cancelled", runId: message.runId } satisfies NotebookSearchWorkerResponse);
    return;
  }

  try {
    // The worker owns the expensive corpus scan, so React can keep painting and
    // handling input while a large selected notebook is searched.
    const result = prepareNotebookSearchResult(message.threads, message.query);
    if (cancelledRunIds.has(message.runId)) {
      cancelledRunIds.delete(message.runId);
      postMessage({
        type: "cancelled",
        runId: message.runId,
      } satisfies NotebookSearchWorkerResponse);
      return;
    }

    postMessage({
      type: "result",
      runId: message.runId,
      result,
    } satisfies NotebookSearchWorkerResponse);
  } catch (error) {
    postMessage({
      type: "error",
      runId: message.runId,
      message: error instanceof Error ? error.message : "Notebook search failed.",
    } satisfies NotebookSearchWorkerResponse);
  }
});
