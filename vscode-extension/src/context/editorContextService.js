const IDE_MAX_OPEN_FILES = 10;
const IDE_MAX_SELECTED_TEXT_LENGTH = 16_384;

function createEditorContextService(vscode) {
  const focusTimestamps = new Map();
  const selectionStateByPath = new Map();
  const subscribers = new Set();
  let lastActivePath;

  function truncateSelectedText(text) {
    if (!text) return undefined;
    if (text.length <= IDE_MAX_SELECTED_TEXT_LENGTH) return text;
    return `${text.slice(0, IDE_MAX_SELECTED_TEXT_LENGTH)}... [TRUNCATED]`;
  }

  function getSelectionState(editor) {
    const selection = editor?.selection;
    if (!selection) return undefined;

    const selectedText = selection.isEmpty
      ? undefined
      : truncateSelectedText(editor.document.getText(selection));

    return {
      selectedText,
      cursor: {
        line: selection.active.line + 1,
        character: selection.active.character + 1,
      },
    };
  }

  function recordSelection(editor) {
    const path = editor?.document?.uri?.fsPath;
    if (!path) return;
    const selectionState = getSelectionState(editor);
    if (!selectionState) return;
    selectionStateByPath.set(path, selectionState);
  }

  function markFocused(editor) {
    const path = editor?.document?.uri?.fsPath;
    if (!path) return;
    focusTimestamps.set(path, Date.now());
    lastActivePath = path;
    recordSelection(editor);
  }

  function removePath(path) {
    if (!path) return;
    focusTimestamps.delete(path);
    selectionStateByPath.delete(path);
    if (lastActivePath === path) lastActivePath = undefined;
  }

  function pathFromTab(tab) {
    const input = tab?.input;
    const uri = input?.uri || input?.modified;
    if (!uri || uri.scheme !== 'file') return undefined;
    return uri.fsPath;
  }

  function getOpenFilePaths() {
    const paths = new Set();

    for (const group of vscode.window.tabGroups.all || []) {
      for (const tab of group.tabs || []) {
        const path = pathFromTab(tab);
        if (path) paths.add(path);
      }
    }

    if (paths.size === 0) {
      for (const editor of vscode.window.visibleTextEditors || []) {
        const path = editor?.document?.uri?.fsPath;
        if (path) paths.add(path);
      }
    }

    return [...paths];
  }

  function normalizeOpenFiles(openFiles) {
    const sorted = [...openFiles].sort((a, b) => b.timestamp - a.timestamp);
    const activeIndex = sorted.findIndex((file) => file.isActive);

    if (activeIndex === -1) {
      for (const file of sorted) {
        delete file.isActive;
        delete file.cursor;
        delete file.selectedText;
      }
    } else {
      sorted.forEach((file, index) => {
        if (index === activeIndex) {
          file.isActive = true;
          return;
        }
        delete file.isActive;
        delete file.cursor;
        delete file.selectedText;
      });
    }

    if (sorted.length > IDE_MAX_OPEN_FILES) return sorted.slice(0, IDE_MAX_OPEN_FILES);
    return sorted;
  }

  function snapshot() {
    const active = vscode.window.activeTextEditor;
    markFocused(active);

    const openPaths = getOpenFilePaths();
    const fallbackActivePath = openPaths
      .slice()
      .sort((a, b) => (focusTimestamps.get(b) ?? 0) - (focusTimestamps.get(a) ?? 0))[0];
    const activePath = active?.document?.uri?.fsPath || lastActivePath || fallbackActivePath;

    const openFiles = openPaths.map((path) => {
      const isActive = Boolean(activePath && activePath === path);
      const state = isActive
        ? (active && active.document?.uri?.fsPath === path ? getSelectionState(active) : selectionStateByPath.get(path))
        : undefined;

      return {
        path,
        timestamp: focusTimestamps.get(path) ?? 0,
        isActive,
        selectedText: state?.selectedText,
        cursor: state?.cursor,
      };
    });

    return {
      openFiles: normalizeOpenFiles(openFiles),
      isTrusted: Boolean(vscode.workspace.isTrusted),
    };
  }

  function notify() {
    const next = snapshot();
    for (const subscriber of subscribers) {
      try {
        subscriber(next);
      } catch {
        // swallow subscriber errors to avoid breaking stream updates
      }
    }
  }

  function subscribe(subscriber) {
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  }

  return {
    snapshot,
    subscribe,
    notify,
    markFocused,
    recordSelection,
    removePath,
  };
}

module.exports = {
  createEditorContextService,
};
