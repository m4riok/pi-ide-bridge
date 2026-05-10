const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

const { AFTER_SCHEME, DIFF_VISIBLE_CONTEXT } = require('./common/constants');
const { createAfterContentProvider } = require('./diff/afterContentProvider');
const { createDiffManager } = require('./diff/diffManager');
const { registerDiffCommands } = require('./diff/commands');
const { registerDiffTracking } = require('./diff/tabTracking');
const { createBridgeServer } = require('./bridge/server');
const { createBootstrapServer } = require('./bridge/bootstrapServer');
const { writeConnectionFile, publishEnv, clearEnv, removeConnectionFile } = require('./bridge/connection');
const { createEditorContextService } = require('./context/editorContextService');

function activate(context) {
  const afterContentProvider = createAfterContentProvider(vscode, AFTER_SCHEME);
  const diffManager = createDiffManager({
    vscode,
    path,
    afterScheme: AFTER_SCHEME,
    diffVisibleContext: DIFF_VISIBLE_CONTEXT,
    afterContentProvider,
  });

  const providerDisposable = afterContentProvider.register();
  const commandDisposables = registerDiffCommands(vscode, diffManager);
  const trackingDisposables = registerDiffTracking(vscode, diffManager);
  const editorContextService = createEditorContextService(vscode);

  const bridge = createBridgeServer({ vscode, diffManager, editorContextService });
  const bootstrap = createBootstrapServer(vscode);
  const bootstrapTokenStateKey = 'piIdeBridge.bootstrapAuthToken';
  const bootstrapAuthToken = String(context.globalState.get(bootstrapTokenStateKey) || randomUUID());
  void context.globalState.update(bootstrapTokenStateKey, bootstrapAuthToken);
  bootstrap.setBootstrapAuthToken(bootstrapAuthToken);
  bootstrap.setBridgeInfo({ ready: false });
  bootstrap.start().catch((error) => {
    const message = String(error?.message || error);
    if (String(error?.code || '') === 'EADDRINUSE') {
      vscode.window.showErrorMessage('Pi IDE Bridge bootstrap port 45721 is already in use. Close stale extension hosts and retry.');
    } else {
      vscode.window.showErrorMessage(`Pi IDE Bridge bootstrap failed: ${message}`);
    }
  });
  let connectionFile;

  bridge.start()
    .then(async ({ host, port, authToken }) => {
      connectionFile = await writeConnectionFile(fs, process.ppid, port, authToken);
      publishEnv(context, port, authToken, bootstrapAuthToken);
      bootstrap.setBridgeInfo({ ready: true, port, authToken });
      vscode.window.showInformationMessage(`Pi IDE Bridge listening: ${host}:${port}`);
    })
    .catch((error) => {
      bootstrap.setBridgeInfo({ ready: false });
      vscode.window.showErrorMessage(`Pi IDE Bridge failed: ${String(error?.message || error)}`);
    });

  const debugDisposable = vscode.commands.registerCommand('piIdeBridge.showBridgeDebug', async () => {
    const b = bootstrap.getState();
    vscode.window.showInformationMessage(`Pi IDE Bridge debug: bootstrap=${b.host}:${b.bootstrapPort} ready=${b.ready ? 'yes' : 'no'} bridgePort=${b.bridgePort ?? 'n/a'}`);
  });

  const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
    editorContextService.markFocused(editor);
    editorContextService.notify();
  });
  const selectionDisposable = vscode.window.onDidChangeTextEditorSelection((event) => {
    editorContextService.recordSelection(event?.textEditor);
    editorContextService.notify();
  });
  const openDocumentDisposable = vscode.workspace.onDidOpenTextDocument(() => {
    editorContextService.notify();
  });
  const closeDocumentDisposable = vscode.workspace.onDidCloseTextDocument((document) => {
    editorContextService.removePath(document?.uri?.fsPath);
    editorContextService.notify();
  });

  editorContextService.markFocused(vscode.window.activeTextEditor);

  context.subscriptions.push(
    providerDisposable,
    ...commandDisposables,
    ...trackingDisposables,
    debugDisposable,
    activeEditorDisposable,
    selectionDisposable,
    openDocumentDisposable,
    closeDocumentDisposable,
    {
      dispose: () => {
        bridge.stop();
        bootstrap.stop();
        removeConnectionFile(fs, connectionFile);
        clearEnv(context);
      },
    },
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
