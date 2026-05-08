## CURRENT

Build a rapid prototype of a NotebookLM-like mode for T3 Code. The mode lets a user switch the current project into a temporary research view over selected historical threads with two one-shot modes: whole-corpus local Search and model-backed Ask.

Prototype scope:

- Add a project-scoped Notebook mode toggle near the existing new-thread affordance.
- While active, keep the current project visible but make other projects and normal thread navigation inactive/dimmed.
- Start with zero selected threads.
- Let the user select multiple threads from the current project as sources.
- Lazy-load selected thread details and include only non-streaming user/assistant messages.
- Search submits run asynchronously and locally over the complete selected user/assistant message corpus, grouped by thread, with highlighted query terms, no model call, and a stoppable in-flight state.
- Ask submits use complete selected user/assistant messages only; remove the retrieved-source fallback/branch entirely.
- Submitting in either mode clears previous Search and Ask results.
- Keep the existing model picker/provider selection.
- Keep the current query when switching Search/Ask modes.
- Disable source selection changes after results exist until the query is manually cleared.
- During in-flight Ask or Search, disable mode changes, re-submit, source selection changes, and other mutable controls.
- Hide coding-agent controls that do not make sense in Notebook mode, including build/plan, access, worktree, and branch controls where practical.
- Add a simple Ask prompt size guard if it is cheap.

Out of scope for the prototype:

- Mind maps.
- Notes/studio panel.
- Persistent notebook chats or follow-up conversation history.
- Cross-project source selection.
- Dedicated SQL/retrieval tools.
- A separate model picker.

Important future direction:

- A real implementation should not rely on injecting large raw dumps. It should use scoped, read-only thread-query tools over the projection database so the model can inspect threads by search, date, branch, worktree, and message ranges without receiving all source content upfront.

Minimal data model:

- Notebook mode state: active/inactive, scoped to one current project.
- Selected sources: thread IDs selected by the user.
- Source corpus: complete non-streaming user/assistant messages from selected threads.
- Search result: ephemeral grouped matches for the last submitted query.
- Ask result: ephemeral completed model answer for the last submitted query.

First implementation target:

- Refactor the existing notebook prototype so Search scans complete selected sources asynchronously/stoppably, Ask uses complete selected sources only, and the retrieved-source branch is removed.

## RECENT

- Brainstorming settled on raw exported thread dump for the prototype, while documenting SQL-backed read-only query tools as the real direction.
- New direction: remove notebook retrieved-source behavior; Search should scan the whole selected corpus asynchronously and be stoppable.

## ARCHIVE
