function createDiffManager({ vscode, path, afterScheme, diffVisibleContext, afterContentProvider }) {
  const diffByRequestId = new Map();
  const MAX_OPEN_DIFFS = 256;

  function formatShortId(raw) {
    const key = String(raw || '');
    const cleaned = key.replace(/^call[_-]?/i, '').replace(/[^a-zA-Z0-9]/g, '');
    return (cleaned || '000000').slice(0, 6).padEnd(6, '0');
  }

  function isDiffTabInput(input, info) {
    const original = input?.original?.toString?.();
    const modified = input?.modified?.toString?.();
    return original === info.left && modified === info.right;
  }

  async function updateDiffVisibleContext() {
    let visible = false;
    const editor = vscode.window.activeTextEditor;
    if (editor?.document?.uri?.scheme === afterScheme) {
      visible = true;
    } else {
      const activeInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      for (const info of diffByRequestId.values()) {
        if (isDiffTabInput(activeInput, info)) {
          visible = true;
          break;
        }
      }
    }
    await vscode.commands.executeCommand('setContext', diffVisibleContext, visible);
  }

  async function getExistingOrEmptyOriginalUri(fileUri) {
    try {
      await vscode.workspace.fs.stat(fileUri);
      return fileUri;
    } catch {
      return vscode.Uri.from({ scheme: 'untitled', path: fileUri.path });
    }
  }

  function settlePending(requestId, decision) {
    const key = String(requestId || '');
    const pending = diffByRequestId.get(key);
    if (!pending || pending.settled) return;
    pending.settled = true;

    if (typeof pending.resolveDecision === 'function') {
      pending.resolveDecision(decision);
    }
    pending.resolveDecision = null;
  }

  function setPendingResolver(requestId, resolveDecision) {
    const key = String(requestId || '');
    const pending = diffByRequestId.get(key);
    if (!pending || pending.settled) return false;
    pending.resolveDecision = resolveDecision;
    return true;
  }

  function clearPendingResolver(requestId, resolveDecision) {
    const key = String(requestId || '');
    const pending = diffByRequestId.get(key);
    if (!pending || pending.settled) return;
    if (pending.resolveDecision === resolveDecision) {
      pending.resolveDecision = null;
    }
  }

  async function closeDiffByRequestId(requestId, options = {}) {
    const key = String(requestId || '');
    const target = diffByRequestId.get(key);
    if (!target) return;

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (isDiffTabInput(tab.input, target)) {
          await vscode.window.tabGroups.close(tab, true);
        }
      }
    }

    if (options.decision) settlePending(key, options.decision);
    afterContentProvider.deleteByUri(target.right);
    diffByRequestId.delete(key);
    await updateDiffVisibleContext();
  }

  async function openPayloadDiff(payload, requestId) {
    if (!payload?.filePath) throw new Error('missing filePath in payload');

    const key = String(requestId || Date.now());
    await closeDiffByRequestId(key);

    const fileUri = vscode.Uri.file(payload.filePath);
    const left = await getExistingOrEmptyOriginalUri(fileUri);
    const right = vscode.Uri.from({
      scheme: afterScheme,
      path: fileUri.path,
      query: `rid=${encodeURIComponent(key)}`,
    });

    afterContentProvider.setContent(right, String(payload.afterText ?? ''));

    const shortId = formatShortId(key);
    await vscode.commands.executeCommand('vscode.diff', left, right, `*[Pi] ${path.basename(payload.filePath)} (${shortId})`, {
      preview: false,
      preserveFocus: true,
    });

    if (diffByRequestId.size >= MAX_OPEN_DIFFS) {
      const oldestRequestId = diffByRequestId.keys().next().value;
      if (oldestRequestId) {
        await closeDiffByRequestId(oldestRequestId, { decision: 'rejected' });
      }
    }

    diffByRequestId.set(key, {
      requestId: key,
      filePath: payload.filePath,
      left: left.toString(),
      right: right.toString(),
      resolveDecision: null,
      settled: false,
    });

    await updateDiffVisibleContext();
    return key;
  }

  function findRequestIdFromActiveDiffTab() {
    const activeInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    for (const [rid, info] of diffByRequestId.entries()) {
      if (isDiffTabInput(activeInput, info)) return rid;
    }

    const editorUri = vscode.window.activeTextEditor?.document?.uri?.toString();
    if (!editorUri) return undefined;
    for (const [rid, info] of diffByRequestId.entries()) {
      if (info.right === editorUri) return rid;
    }
    return undefined;
  }

  async function handleClosedDiffTabs() {
    for (const [requestId, info] of [...diffByRequestId.entries()]) {
      let stillOpen = false;
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (isDiffTabInput(tab.input, info)) {
            stillOpen = true;
            break;
          }
        }
        if (stillOpen) break;
      }
      if (!stillOpen && !info.settled) {
        settlePending(requestId, 'rejected');
        afterContentProvider.deleteByUri(info.right);
        diffByRequestId.delete(requestId);
      }
    }
    await updateDiffVisibleContext();
  }

  return {
    openPayloadDiff,
    closeDiffByRequestId,
    settlePending,
    setPendingResolver,
    clearPendingResolver,
    findRequestIdFromActiveDiffTab,
    handleClosedDiffTabs,
    updateDiffVisibleContext,
  };
}

module.exports = {
  createDiffManager,
};
