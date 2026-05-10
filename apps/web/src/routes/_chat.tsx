import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
} from "../lib/chatThreadActions";
import { deriveLogicalProjectKeyFromSettings } from "../logicalProject";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";
import { selectProjectByRef, useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useNotebookModeStore } from "../notebookModeStore";
import { resolveSidebarNewThreadEnvMode } from "~/components/Sidebar.logic";
import { useSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "~/rpc/serverState";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const keybindings = useServerKeybindings();
  const activeThreadProject = useStore(
    useMemo(
      () => (state) =>
        activeThread
          ? selectProjectByRef(state, {
              environmentId: activeThread.environmentId,
              projectId: activeThread.projectId,
            })
          : undefined,
      [activeThread],
    ),
  );
  const defaultProject = useStore(
    useMemo(() => (state) => selectProjectByRef(state, defaultProjectRef), [defaultProjectRef]),
  );
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const appSettings = useSettings();
  const notebookProjectKey = useMemo(() => {
    if (activeThreadProject) {
      return deriveLogicalProjectKeyFromSettings(activeThreadProject, appSettings);
    }
    if (activeDraftThread?.logicalProjectKey) {
      return activeDraftThread.logicalProjectKey;
    }
    return defaultProject ? deriveLogicalProjectKeyFromSettings(defaultProject, appSettings) : null;
  }, [activeDraftThread, activeThreadProject, appSettings, defaultProject]);

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });

      if (useCommandPaletteStore.getState().open) {
        return;
      }

      const notebookModeActive = useNotebookModeStore.getState().activeProjectKey !== null;

      if (event.key === "Escape" && selectedThreadKeysSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      if (command === "notebook.enter") {
        event.preventDefault();
        event.stopPropagation();
        if (!notebookProjectKey) return;
        const notebookStore = useNotebookModeStore.getState();
        if (notebookStore.activeProjectKey !== notebookProjectKey) {
          notebookStore.enter(notebookProjectKey);
        }
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        if (notebookModeActive) {
          return;
        }
        void startNewLocalThreadFromContext({
          activeDraftThread,
          activeThread,
          defaultProjectRef,
          defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          handleNewThread,
        });
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        if (notebookModeActive) {
          return;
        }
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread,
          defaultProjectRef,
          defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          handleNewThread,
        });
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    handleNewThread,
    keybindings,
    defaultProjectRef,
    notebookProjectKey,
    selectedThreadKeysSize,
    terminalOpen,
    appSettings.defaultThreadEnvMode,
  ]);

  return null;
}

function ChatRouteLayout() {
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <Outlet />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
});
