function registerDiffCommands(vscode, diffManager) {
  const approveDisposable = vscode.commands.registerCommand('piIdeBridge.approveActiveDiff', async () => {
    const requestId = diffManager.findRequestIdFromActiveDiffTab();
    if (!requestId) return;
    diffManager.settlePending(requestId, 'approved');
    await diffManager.closeDiffByRequestId(requestId);
  });

  const diffDisposable = vscode.commands.registerCommand('piIdeBridge.openDiffForApproval', async (payload) => {
    try {
      await diffManager.openPayloadDiff(payload, payload?.requestId);
      vscode.window.showInformationMessage(`Pi IDE Bridge: opened ${payload.filePath} for review.`);
    } catch (error) {
      vscode.window.showErrorMessage(`Pi IDE Bridge: ${String(error instanceof Error ? error.message : error)}`);
    }
  });

  return [approveDisposable, diffDisposable];
}

module.exports = {
  registerDiffCommands,
};
