import {
  type OrchestrationNotebookTurnInput,
  type OrchestrationNotebookTurnStreamItem,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return "Unknown notebook turn failure.";
}

export function runNotebookTurnStream(
  providerService: ProviderServiceShape,
  input: OrchestrationNotebookTurnInput,
): Effect.Effect<
  Stream.Stream<OrchestrationNotebookTurnStreamItem, OrchestrationDispatchCommandError>,
  OrchestrationDispatchCommandError
> {
  const toNotebookTurnError = (cause: unknown) =>
    new OrchestrationDispatchCommandError({
      message: `Failed to run notebook turn: ${errorMessage(cause)}`,
      cause,
    });

  return Effect.gen(function* () {
    // Notebook turns use a transient provider session outside the orchestration
    // thread projection. Runtime events are scoped by this synthetic thread id.
    yield* providerService
      .startSession(input.threadId, {
        threadId: input.threadId,
        providerInstanceId: input.modelSelection.instanceId,
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        runtimeMode: "approval-required",
      })
      .pipe(Effect.mapError(toNotebookTurnError));

    const sendTurn = providerService
      .sendTurn(
        {
          threadId: input.threadId,
          input: input.prompt,
          modelSelection: input.modelSelection,
          interactionMode: "default",
        },
        { promptBudget: "notebook" },
      )
      .pipe(Effect.mapError(toNotebookTurnError));

    const runtimeItems = providerService.streamEvents.pipe(
      Stream.filter((event) => event.threadId === input.threadId),
      Stream.filter(
        (event) =>
          event.type === "content.delta" ||
          event.type === "thread.token-usage.updated" ||
          event.type === "turn.completed" ||
          event.type === "request.opened" ||
          event.type === "runtime.error",
      ),
      Stream.map((event): OrchestrationNotebookTurnStreamItem => {
        if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
          return { type: "delta", delta: event.payload.delta };
        }
        if (event.type === "thread.token-usage.updated") {
          return { type: "usage", usage: event.payload.usage };
        }
        if (event.type === "turn.completed") {
          const message =
            event.payload.state === "failed"
              ? (event.payload.errorMessage ?? "Notebook turn failed.")
              : null;
          return message ? { type: "error", message } : { type: "done" };
        }
        if (event.type === "request.opened") {
          return {
            type: "error",
            message:
              "Notebook prototype cannot handle tool or approval requests yet. Try asking a narrower question about the selected thread sources.",
          };
        }
        if (event.type === "runtime.error") {
          return {
            type: "error",
            message: event.payload.message ?? "Notebook provider runtime failed.",
          };
        }
        return { type: "done" };
      }),
      Stream.filter((item) => item.type !== "delta" || item.delta.length > 0),
      Stream.takeUntil((item) => item.type === "done" || item.type === "error"),
    );

    return Stream.merge(Stream.fromEffect(sendTurn).pipe(Stream.drain), runtimeItems).pipe(
      Stream.ensuring(
        providerService
          .stopSession({ threadId: input.threadId })
          .pipe(Effect.catch(() => Effect.void)),
      ),
    );
  });
}
