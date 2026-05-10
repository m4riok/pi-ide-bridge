function createEditorContextService(vscode) {
  function getSelection(selection) {
    if (!selection) return undefined;
    return {
      start: { line: selection.start.line, character: selection.start.character },
      end: { line: selection.end.line, character: selection.end.character },
      isEmpty: selection.isEmpty,
    };
  }

  function snapshot() {
    const active = vscode.window.activeTextEditor;
    return {
      activeFile: active?.document?.uri?.fsPath,
      selection: getSelection(active?.selection),
      visibleFiles: vscode.window.visibleTextEditors.map((editor) => editor.document.uri.fsPath),
    };
  }

  return {
    snapshot,
  };
}

module.exports = {
  createEditorContextService,
};
