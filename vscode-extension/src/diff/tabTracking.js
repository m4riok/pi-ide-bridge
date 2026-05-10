function registerDiffTracking(vscode, diffManager) {
  const tabsDisposable = vscode.window.tabGroups.onDidChangeTabs(() => {
    diffManager.handleClosedDiffTabs().catch(() => {});
  });

  const editorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
    diffManager.updateDiffVisibleContext().catch(() => {});
  });

  return [tabsDisposable, editorDisposable];
}

module.exports = {
  registerDiffTracking,
};
