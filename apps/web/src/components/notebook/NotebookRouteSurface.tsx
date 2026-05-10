import type { ReactNode } from "react";
import type { ProjectId } from "@t3tools/contracts";

import { useNotebookModeStore } from "../../notebookModeStore";
import { NotebookModeView } from "../NotebookModeView";

interface NotebookRouteSurfaceProps {
  readonly projectId: ProjectId | null;
  readonly fallback: ReactNode;
}

export function NotebookRouteSurface({ projectId, fallback }: NotebookRouteSurfaceProps) {
  const notebookActiveProjectKey = useNotebookModeStore((state) => state.activeProjectKey);

  if (notebookActiveProjectKey !== null && projectId !== null) {
    return <NotebookModeView projectId={projectId} />;
  }

  return fallback;
}
