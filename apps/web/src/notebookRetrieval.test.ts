import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import { prepareNotebookSearchResult, prepareNotebookSources } from "./notebookRetrieval";
import type { ChatMessage, Thread } from "./types";

function message(
  ordinal: number,
  role: ChatMessage["role"],
  text: string,
  streaming = false,
): ChatMessage {
  return {
    id: `message-${ordinal}` as ChatMessage["id"],
    role,
    text,
    createdAt: `2026-04-25T00:00:${String(ordinal).padStart(2, "0")}.000Z`,
    streaming,
  };
}

function thread(messages: ChatMessage[], title = "Notebook retrieval"): Thread {
  return {
    id: "thread-1" as Thread["id"],
    environmentId: "environment-1" as Thread["environmentId"],
    codexThreadId: null,
    projectId: "project-1" as Thread["projectId"],
    title,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4-mini",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages,
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-25T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
  };
}

describe("prepareNotebookSources", () => {
  it("includes complete selected messages", () => {
    const prepared = prepareNotebookSources(
      [
        thread([
          message(1, "user", "Can we build notebook memory?"),
          message(2, "assistant", "Yes, start with selected user and assistant messages."),
          message(3, "system", "hidden"),
          message(4, "assistant", "streaming draft", true),
        ]),
      ],
      "What did we discuss?",
    );

    expect(prepared.promptSource).toContain("Can we build notebook memory?");
    expect(prepared.promptSource).toContain("selected user and assistant messages");
    expect(prepared.promptSource).not.toContain("hidden");
    expect(prepared.promptSource).not.toContain("streaming draft");
    expect(prepared.promptSource).not.toContain("Thread ID:");
    expect(prepared.promptSource).not.toContain("M1");
  });

  it("keeps complete selected messages even for large sources", () => {
    const filler = "implementation notes ".repeat(2_400);
    const prepared = prepareNotebookSources(
      [
        thread([
          message(1, "user", filler),
          message(2, "assistant", "We should get back to token accounting later."),
          message(3, "user", filler),
          message(4, "assistant", "The retrieval system should prefer coherent windows."),
        ]),
      ],
      "Any things we decided or planned for the future?",
    );

    expect(prepared.promptSource).toContain("implementation notes implementation notes");
    expect(prepared.promptSource).toContain("get back to token accounting later");
    expect(prepared.promptSource).toContain("The retrieval system should prefer coherent windows.");
    expect(prepared.promptSource).not.toContain("Retrieved Conversation Windows");
    expect(prepared.promptSource).not.toContain("Source 1");
    expect(prepared.promptSource).not.toContain("Thread ID:");
    expect(prepared.promptSource).not.toContain("M2");
  });
});

describe("prepareNotebookSearchResult", () => {
  it("returns focused chunks grouped by matching thread", () => {
    const result = prepareNotebookSearchResult(
      [
        thread(
          [
            message(1, "user", "Where is sourceCharBudget calculated?"),
            message(2, "assistant", "sourceCharBudget is derived from the notebook prompt limit."),
          ],
          "Budget thread",
        ),
        {
          ...thread([message(1, "user", "Unrelated notes about project setup.")], "Other thread"),
          id: "thread-2" as Thread["id"],
        },
      ],
      "sourceCharBudget",
    );

    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.title).toBe("Budget thread");
    expect(result.threads[0]?.chunks).toHaveLength(2);
    expect(result.threads[0]?.chunks[0]?.matchedTerms).toContain("sourceCharBudget");
    expect(result.threads[0]?.chunks[0]?.text).toContain("sourceCharBudget");
    expect(result.threads[0]?.chunks[0]?.messages[0]?.role).toBe("user");
    expect(result.threads[0]?.chunks[0]?.messages).toHaveLength(1);
    expect(result.threads[0]?.messages).toHaveLength(2);
    expect(result.threads[0]?.chunks[0]?.startedAt).toBe("2026-04-25T00:00:01.000Z");
  });

  it("does not return complete sources when the full source would fit", () => {
    const result = prepareNotebookSearchResult(
      [thread([message(1, "user", "Tiny exact match for notebook search.")])],
      "notebook",
    );

    expect(result.threads[0]?.chunks).toHaveLength(1);
    expect(result.threads[0]?.chunks[0]?.text).toContain("Tiny exact match");
    expect(result.threads[0]?.chunks[0]?.text).not.toContain("The selected sources fit");
  });

  it("returns an empty result when no query terms match", () => {
    const result = prepareNotebookSearchResult(
      [thread([message(1, "user", "Notebook retrieval notes.")])],
      "websocket",
    );

    expect(result.queryTerms).toEqual(["websocket"]);
    expect(result.threads).toEqual([]);
  });

  it("matches common words without stop-word filtering", () => {
    const result = prepareNotebookSearchResult(
      [thread([message(1, "user", "The implementation notes are ready.")])],
      "the",
    );

    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.chunks[0]?.matchedTerms).toEqual(["the"]);
    expect(result.threads[0]?.chunks[0]?.messages[0]?.matchedTerms).toEqual(["the"]);
  });

  it("matches continuous phrases instead of separate query words", () => {
    const result = prepareNotebookSearchResult(
      [
        thread([
          message(1, "user", "Please make the smallest working implementation today."),
          message(
            2,
            "assistant",
            "We can make it smaller, but the implementation is already working.",
          ),
        ]),
      ],
      "make the smallest working implementation",
    );

    expect(result.queryTerms).toEqual(["make the smallest working implementation"]);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.chunks).toHaveLength(1);
    expect(result.threads[0]?.chunks[0]?.messages[0]?.ordinal).toBe(1);
  });

  it("matches case-insensitive continuous substrings", () => {
    const result = prepareNotebookSearchResult(
      [thread([message(1, "user", "Ship the smallest working implementation today.")])],
      "SMALLEST WORKING IMPLEM",
    );

    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.chunks[0]?.matchedTerms).toEqual(["SMALLEST WORKING IMPLEM"]);
  });

  it("scans every selected message without capping per-thread matches", () => {
    const result = prepareNotebookSearchResult(
      [thread(Array.from({ length: 20 }, (_, index) => message(index + 1, "user", "needle")))],
      "needle",
    );

    expect(result.threads[0]?.chunks).toHaveLength(20);
  });
});
