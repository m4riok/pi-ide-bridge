const vscode = require('vscode');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

const { AFTER_SCHEME, DIFF_VISIBLE_CONTEXT, BRIDGE_HOST, BOOTSTRAP_PORT } = require('./common/constants');
const {
  BRIDGE_BOOTSTRAP_REGISTER_PATH,
  BRIDGE_BOOTSTRAP_HEARTBEAT_PATH,
  BRIDGE_BOOTSTRAP_UNREGISTER_PATH,
} = require('./common/bridge-contract.cjs');
const { createAfterContentProvider } = require('./diff/afterContentProvider');
const { createDiffManager } = require('./diff/diffManager');
const { registerDiffCommands } = require('./diff/commands');
const { registerDiffTracking } = require('./diff/tabTracking');
const { createBridgeServer } = require('./bridge/server');
const { createBootstrapServer } = require('./bridge/bootstrapServer');
const { writeConnectionFile, publishEnv, clearEnv, removeConnectionFile } = require('./bridge/connection');
const { createEditorContextService } = require('./context/editorContextService');

const HEARTBEAT_INTERVAL_MS = 10_000;

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
  const bootstrap = createBootstrapServer();
  const windowId = randomUUID();

  // Bootstrap: first window to get the port owns the registry; others register via HTTP.
  bootstrap.start().catch((error) => {
    if (String(error?.code || '') === 'EADDRINUSE') return; // Another window owns bootstrap, that's fine
    vscode.window.showErrorMessage(`Pi IDE Bridge bootstrap failed: ${String(error?.message || error)}`);
  });

  // ── Terminal shell-PID tracking ──────────────────────────────────────────────
  let terminalCounter = 0;
  const terminalPids = new Map();     // key → { terminalId, shellPid, name }
  const terminalObjectKeys = new WeakMap(); // Terminal → key

  function addTerminal(t) {
    const key = String(terminalCounter++);
    terminalObjectKeys.set(t, key);
    t.processId.then((pid) => {
      if (pid != null) terminalPids.set(key, { terminalId: key, shellPid: pid, name: t.name });
    }).catch(() => {});
  }

  function removeTerminal(t) {
    const key = terminalObjectKeys.get(t);
    if (key !== undefined) terminalPids.delete(key);
  }

  for (const t of vscode.window.terminals) addTerminal(t);
  const termOpenDisposable = vscode.window.onDidOpenTerminal(addTerminal);
  const termCloseDisposable = vscode.window.onDidCloseTerminal(removeTerminal);

  // ── Bootstrap HTTP helpers ───────────────────────────────────────────────────
  function postToBootstrap(urlPath, body) {
    return new Promise((resolve) => {
      const bodyStr = JSON.stringify(body);
      const req = http.request(
        {
          host: BRIDGE_HOST,
          port: BOOTSTRAP_PORT,
          path: urlPath,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(bodyStr),
          },
        },
        (res) => { res.resume(); resolve((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300); },
      );
      req.setTimeout(2000, () => req.destroy());
      req.on('error', () => resolve(false));
      req.write(bodyStr);
      req.end();
    });
  }

  let activeBridgePort;
  let activeBridgeToken;
  let heartbeatTimer;

  async function registerWindow() {
    if (!activeBridgePort || !activeBridgeToken) return;
    await postToBootstrap(BRIDGE_BOOTSTRAP_REGISTER_PATH, {
      windowId,
      bridgePort: activeBridgePort,
      bridgeToken: activeBridgeToken,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      terminals: [...terminalPids.values()],
      windowPid: process.pid,
    });
  }

  async function sendHeartbeat() {
    const ok = await postToBootstrap(BRIDGE_BOOTSTRAP_HEARTBEAT_PATH, {
      windowId,
      terminals: [...terminalPids.values()],
    });
    if (!ok) {
      // Bootstrap owner may have closed — try to take over, then re-register.
      await bootstrap.start().catch(() => {}); // EADDRINUSE = another window won the race, that's fine
      await registerWindow();
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  let connectionFile;

  bridge.start()
    .then(async ({ host, port, authToken }) => {
      activeBridgePort = port;
      activeBridgeToken = authToken;
      connectionFile = await writeConnectionFile(fs, process.ppid, port, authToken);
      publishEnv(context, port, authToken, randomUUID()); // bootstrapAuthToken kept for env compat
      await registerWindow();
      heartbeatTimer = setInterval(() => { void sendHeartbeat(); }, HEARTBEAT_INTERVAL_MS);
      vscode.window.showInformationMessage(`Pi IDE Bridge listening: ${host}:${port}`);
    })
    .catch((error) => {
      vscode.window.showErrorMessage(`Pi IDE Bridge failed: ${String(error?.message || error)}`);
    });

  const debugDisposable = vscode.commands.registerCommand('piIdeBridge.showBridgeDebug', async () => {
    const b = bootstrap.getState();
    vscode.window.showInformationMessage(
      `Pi IDE Bridge debug: bootstrap=${b.host}:${b.bootstrapPort} liveWindows=${b.liveWindowCount}`,
    );
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
    termOpenDisposable,
    termCloseDisposable,
    activeEditorDisposable,
    selectionDisposable,
    openDocumentDisposable,
    closeDocumentDisposable,
    {
      dispose: () => {
        clearInterval(heartbeatTimer);
        void postToBootstrap(BRIDGE_BOOTSTRAP_UNREGISTER_PATH, { windowId }).catch(() => {});
        bridge.stop();
        bootstrap.stop();
        void removeConnectionFile(fs, connectionFile);
        clearEnv(context);
      },
    },
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
