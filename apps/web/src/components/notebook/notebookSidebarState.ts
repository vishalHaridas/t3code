import { useNotebookModeStore } from "../../notebookModeStore";

export function useNotebookSidebarState(projectKey: string) {
  const activeProjectKey = useNotebookModeStore((state) => state.activeProjectKey);
  const toggleProject = useNotebookModeStore((state) => state.toggleProject);
  return {
    notebookModeActive: activeProjectKey !== null,
    isNotebookProject: activeProjectKey === projectKey,
    toggleNotebookProject: toggleProject,
  };
}

export function useNotebookThreadSourceState(threadKey: string) {
  const isSelected = useNotebookModeStore((state) => state.selectedThreadKeys.has(threadKey));
  const sourcesLocked = useNotebookModeStore(
    (state) =>
      Boolean(state.searchResult || state.askResult || state.lastSubmittedQuery) ||
      state.askResult?.streaming === true,
  );
  const sourceAddBlocked = useNotebookModeStore((state) => state.sourceAddBlocked);
  const toggleSourceThread = useNotebookModeStore((state) => state.toggleSourceThread);

  return {
    isSelected,
    sourcesLocked,
    sourceAddBlocked,
    sourceAddDisabled: sourceAddBlocked && !isSelected,
    toggleSourceThread,
  };
}
