import { describe, expect, it } from "vitest";

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
    modelSelection: { provider: "codex", model: "gpt-5.4-mini" } as Thread["modelSelection"],
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
  it("includes complete selected messages when sources fit the budget", () => {
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

    expect(prepared.mode).toBe("complete");
    expect(prepared.promptSource).toContain("Can we build notebook memory?");
    expect(prepared.promptSource).toContain("selected user and assistant messages");
    expect(prepared.promptSource).not.toContain("hidden");
    expect(prepared.promptSource).not.toContain("streaming draft");
    expect(prepared.promptSource).not.toContain("Thread ID:");
    expect(prepared.promptSource).not.toContain("M1");
  });

  it("switches to retrieved windows for large sources and keeps future-plan anchors", () => {
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

    expect(prepared.mode).toBe("retrieved");
    expect(prepared.promptSource).toContain("## Planning / Follow-up Anchors");
    expect(prepared.promptSource).toContain("get back to token accounting later");
    expect(prepared.promptSource).toContain("Retrieved Conversation Windows");
    expect(prepared.promptSource).not.toContain("Source 1");
    expect(prepared.promptSource).not.toContain("Thread ID:");
    expect(prepared.promptSource).not.toContain("M2");
  });

  it("uses the caller-provided budget for the complete-source decision", () => {
    const filler = "implementation notes ".repeat(4_000);
    const prepared = prepareNotebookSources(
      [
        thread([
          message(1, "user", filler),
          message(2, "assistant", "This should still fit when the caller has enough room."),
        ]),
      ],
      "What happened?",
      { sourceCharBudget: 120_000 },
    );

    expect(prepared.mode).toBe("complete");
    expect(prepared.sourceCharBudget).toBe(120_000);
    expect(prepared.promptSource).toContain("This should still fit");
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
    expect(result.threads[0]?.chunks[0]?.matchedTerms).toContain("sourcecharbudget");
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

  it("matches query terms as token prefixes", () => {
    const result = prepareNotebookSearchResult(
      [thread([message(1, "user", "The tests and testing setup both passed.")])],
      "test",
    );

    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.chunks[0]?.matchedTerms).toEqual(["test"]);
    expect(result.threads[0]?.chunks[0]?.messages[0]?.matchedTerms).toEqual(["test"]);
  });
});
