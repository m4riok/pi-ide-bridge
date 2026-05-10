const vscode = require('vscode');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { randomUUID, timingSafeEqual } = require('node:crypto');

const BRIDGE_HOST = '127.0.0.1';
const AFTER_SCHEME = 'pi-ide-bridge-after';
const CONNECTION_ROOT_DIR = path.join(tmpdir(), 'pi-ide-bridge');
const CONNECTION_DIR = path.join(CONNECTION_ROOT_DIR, 'ide');
const DIFF_VISIBLE_CONTEXT = 'pi.diff.isVisible';
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

const diffByRequestId = new Map();
const afterContentByUri = new Map();

let bridgeServer;
let bridgePort;
let authToken;
let connectionFile;

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
  if (editor?.document?.uri?.scheme === AFTER_SCHEME) {
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
  await vscode.commands.executeCommand('setContext', DIFF_VISIBLE_CONTEXT, visible);
}

async function getExistingOrEmptyOriginalUri(fileUri) {
  try {
    await vscode.workspace.fs.stat(fileUri);
    return fileUri;
  } catch {
    return vscode.Uri.from({
      scheme: 'untitled',
      path: fileUri.path,
    });
  }
}

async function openPayloadDiff(payload, requestId) {
  if (!payload?.filePath) throw new Error('missing filePath in payload');

  const key = String(requestId || Date.now());
  await closeDiffByRequestId(key, { notify: false });

  const fileUri = vscode.Uri.file(payload.filePath);
  const left = await getExistingOrEmptyOriginalUri(fileUri);
  const right = vscode.Uri.from({
    scheme: AFTER_SCHEME,
    path: fileUri.path,
    query: `rid=${encodeURIComponent(key)}`,
  });

  afterContentByUri.set(right.toString(), String(payload.afterText ?? ''));

  const shortId = formatShortId(key);
  await vscode.commands.executeCommand('vscode.diff', left, right, `*[Pi] ${path.basename(payload.filePath)} (${shortId})`, {
    preview: false,
    preserveFocus: true,
  });

  diffByRequestId.set(key, {
    requestId: key,
    filePath: payload.filePath,
    left: left.toString(),
    right: right.toString(),
    response: null,
    settled: false,
  });

  await updateDiffVisibleContext();
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function settlePending(requestId, decision) {
  const key = String(requestId || '');
  const pending = diffByRequestId.get(key);
  if (!pending || pending.settled) return;
  pending.settled = true;

  if (pending.response && !pending.response.destroyed) {
    sendJson(pending.response, 200, { ok: true, requestId: key, decision });
  }
  pending.response = null;
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
  afterContentByUri.delete(target.right);
  diffByRequestId.delete(key);
  await updateDiffVisibleContext();
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
      afterContentByUri.delete(info.right);
      diffByRequestId.delete(requestId);
    }
  }
  await updateDiffVisibleContext();
}

class HttpRequestError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'HttpRequestError';
    this.statusCode = statusCode;
  }
}

function requestError(message, statusCode) {
  return new HttpRequestError(message, statusCode);
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let receivedBytes = 0;
    let rejected = false;

    req.on('data', (chunk) => {
      if (rejected) return;
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
        rejected = true;
        req.destroy();
        reject(requestError('request body too large', 413));
        return;
      }
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(requestError('invalid JSON request body', 400));
      }
    });
    req.on('error', (error) => {
      if (!rejected) reject(error);
    });
  });
}

function isAuthorized(req) {
  if (!authToken || typeof req.headers.authorization !== 'string') return false;

  const expected = Buffer.from(`Bearer ${authToken}`);
  const actual = Buffer.from(req.headers.authorization);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function createBridgeServer(context) {
  authToken = randomUUID();
  bridgeServer = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== `${BRIDGE_HOST}:${bridgePort}` && req.headers.host !== `localhost:${bridgePort}`) {
        sendJson(res, 403, { ok: false, error: 'invalid host' });
        return;
      }
      if (!isAuthorized(req)) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      if (req.method === 'POST' && req.url === '/openDiff') {
        const msg = await readRequestJson(req);
        const requestId = String(msg.requestId || Date.now());
        await openPayloadDiff(msg, requestId);
        const pending = diffByRequestId.get(requestId);
        if (!pending) {
          sendJson(res, 500, { ok: false, requestId, error: 'failed to open diff' });
          return;
        }
        pending.response = res;
        req.on('close', () => {
          if (!pending.settled && pending.response === res) pending.response = null;
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/closeDiff') {
        const msg = await readRequestJson(req);
        await closeDiffByRequestId(String(msg.requestId || ''), { decision: String(msg.decision || 'closed_by_pi') });
        sendJson(res, 200, { ok: true, requestId: msg.requestId });
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        sendJson(res, 200, { ok: true, port: bridgePort });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      const status = error instanceof HttpRequestError ? error.statusCode : 500;
      sendJson(res, status, { ok: false, error: String(error instanceof Error ? error.message : error) });
    }
  });

  await new Promise((resolve, reject) => {
    bridgeServer.listen(0, BRIDGE_HOST, resolve);
    bridgeServer.on('error', reject);
  });

  bridgePort = /** @type {import('net').AddressInfo} */ (bridgeServer.address()).port;
  await fs.mkdir(CONNECTION_ROOT_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(CONNECTION_ROOT_DIR, 0o700);
  await fs.mkdir(CONNECTION_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(CONNECTION_DIR, 0o700);
  connectionFile = path.join(CONNECTION_DIR, `pi-ide-bridge-server-${process.ppid}-${bridgePort}.json`);
  await fs.writeFile(connectionFile, JSON.stringify({ port: bridgePort, authToken }, null, 2), { mode: 0o600 });

  context.environmentVariableCollection.replace('PI_IDE_BRIDGE_SERVER_PORT', String(bridgePort));
  // Required so Pi processes launched from the integrated terminal can discover the bridge.
  // Any subprocess launched from that terminal inherits this local auth token.
  context.environmentVariableCollection.replace('PI_IDE_BRIDGE_AUTH_TOKEN', authToken);
  vscode.window.showInformationMessage(`Pi IDE Bridge listening: ${BRIDGE_HOST}:${bridgePort}`);
}

async function openSampleDiff() {
  const left = await vscode.workspace.openTextDocument({
    content: ['int main() {', '  int x = 1;', '  return x;', '}', ''].join('\n'),
    language: 'c',
  });
  const right = await vscode.workspace.openTextDocument({
    content: ['int main() {', '  int x = 2;', '  int y = 3;', '  return x + y;', '}', ''].join('\n'),
    language: 'c',
  });
  await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, 'Pi IDE Bridge Sample: before ↔ after', {
    preview: false,
  });
}

function activate(context) {
  const contentProvider = {
    provideTextDocumentContent(uri) {
      return afterContentByUri.get(uri.toString()) ?? '';
    },
  };

  const providerDisposable = vscode.workspace.registerTextDocumentContentProvider(AFTER_SCHEME, contentProvider);

  createBridgeServer(context).catch((error) => {
    vscode.window.showErrorMessage(`Pi IDE Bridge failed: ${String(error?.message || error)}`);
  });

  const approveDisposable = vscode.commands.registerCommand('piIdeBridge.approveActiveDiff', async () => {
    const requestId = findRequestIdFromActiveDiffTab();
    if (!requestId) return;
    settlePending(requestId, 'approved');
    await closeDiffByRequestId(requestId);
  });

  const diffDisposable = vscode.commands.registerCommand('piIdeBridge.openDiffForApproval', async (payload) => {
    try {
      await openPayloadDiff(payload, payload?.requestId);
      vscode.window.showInformationMessage(`Pi IDE Bridge: opened ${payload.filePath} for review.`);
    } catch (error) {
      vscode.window.showErrorMessage(`Pi IDE Bridge: ${String(error instanceof Error ? error.message : error)}`);
    }
  });

  const sampleDiffDisposable = vscode.commands.registerCommand('piIdeBridge.openSampleDiff', async () => {
    await openSampleDiff();
    vscode.window.showInformationMessage('Pi IDE Bridge: opened sample diff.');
  });

  const tabsDisposable = vscode.window.tabGroups.onDidChangeTabs(handleClosedDiffTabs);
  const editorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
    updateDiffVisibleContext().catch(() => {});
  });

  context.subscriptions.push(providerDisposable, approveDisposable, diffDisposable, sampleDiffDisposable, tabsDisposable, editorDisposable, {
    dispose: () => {
      if (bridgeServer) bridgeServer.close();
      if (connectionFile) fs.unlink(connectionFile).catch(() => {});
      context.environmentVariableCollection.delete?.('PI_IDE_BRIDGE_SERVER_PORT');
      context.environmentVariableCollection.delete?.('PI_IDE_BRIDGE_AUTH_TOKEN');
    },
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
