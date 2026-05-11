const http = require('node:http');
const { BRIDGE_HOST } = require('../common/constants');
const { createAuthToken, isAuthorized } = require('./auth');
const { HttpRequestError, readRequestJson, sendJson } = require('./request');
const { BRIDGE_OPEN_DIFF_PATH, BRIDGE_CLOSE_DIFF_PATH, BRIDGE_HEALTH_PATH, BRIDGE_CONTEXT_STREAM_PATH, BRIDGE_DIAGNOSTICS_PATH } = require('../common/bridge-contract.cjs');

function createBridgeServer({ vscode, diffManager, editorContextService }) {
  const MAX_SSE_CONNECTIONS = 5;
  let bridgeServer;
  let bridgePort;
  let authToken;
  let activeSseConnections = 0;

  async function start() {
    authToken = createAuthToken();

    bridgeServer = http.createServer(async (req, res) => {
      try {
        const hostHeader = String(req.headers.host || '').toLowerCase();
        if (hostHeader !== `${BRIDGE_HOST}:${bridgePort}` && hostHeader !== `localhost:${bridgePort}`) {
          sendJson(res, 403, { ok: false, error: 'invalid host' });
          return;
        }

        if (!isAuthorized(req, authToken)) {
          sendJson(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }

        if (req.method === 'POST' && req.url === BRIDGE_OPEN_DIFF_PATH) {
          const msg = await readRequestJson(req);
          const requestId = String(msg.requestId || Date.now());
          await diffManager.openPayloadDiff(msg, requestId);

          const resolveDecision = (decision) => {
            if (!res.destroyed) {
              sendJson(res, 200, { ok: true, requestId, decision });
            }
          };

          const attached = diffManager.setPendingResolver(requestId, resolveDecision);
          if (!attached) {
            sendJson(res, 500, { ok: false, requestId, error: 'failed to open diff' });
            return;
          }

          req.on('close', () => {
            diffManager.clearPendingResolver(requestId, resolveDecision);
          });
          return;
        }

        if (req.method === 'POST' && req.url === BRIDGE_CLOSE_DIFF_PATH) {
          const msg = await readRequestJson(req);
          await diffManager.closeDiffByRequestId(String(msg.requestId || ''), {
            decision: String(msg.decision || 'closed_by_pi'),
          });
          sendJson(res, 200, { ok: true, requestId: msg.requestId });
          return;
        }

        if (req.method === 'GET' && req.url === BRIDGE_HEALTH_PATH) {
          sendJson(res, 200, { ok: true, port: bridgePort });
          return;
        }

        if (req.method === 'GET' && req.url === BRIDGE_CONTEXT_STREAM_PATH) {
          if (activeSseConnections >= MAX_SSE_CONNECTIONS) {
            sendJson(res, 429, { ok: false, error: 'too many context streams' });
            return;
          }

          activeSseConnections += 1;
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });

          const sendSnapshot = (snapshot) => {
            if (res.writableEnded || res.destroyed) return;
            res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
          };

          try {
            sendSnapshot(editorContextService.snapshot());
          } catch {
            // best-effort initial snapshot; stream remains active for future updates
          }
          const unsubscribe = editorContextService.subscribe(sendSnapshot);
          const keepalive = setInterval(() => {
            if (!res.writableEnded && !res.destroyed) {
              res.write(': keepalive\n\n');
            }
          }, 15_000);

          let cleaned = false;
          const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            unsubscribe();
            clearInterval(keepalive);
            activeSseConnections = Math.max(0, activeSseConnections - 1);
          };

          req.on('close', cleanup);
          res.on('close', cleanup);
          res.on('error', cleanup);
          return;
        }

        if (req.method === 'POST' && req.url === BRIDGE_DIAGNOSTICS_PATH) {
          const msg = await readRequestJson(req);
          const scope = typeof msg.scope === 'string' ? msg.scope : 'active';
          const filePath = typeof msg.filePath === 'string' ? msg.filePath : '';

          if (scope === 'file' && !filePath) {
            sendJson(res, 400, { ok: false, error: "filePath is required when scope is 'file'" });
            return;
          }

          const result = collectDiagnostics(vscode, editorContextService, { scope, filePath });
          sendJson(res, 200, result);
          return;
        }

        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (error) {
        if (res.headersSent || res.writableEnded || res.destroyed) {
          try {
            res.end();
          } catch (endError) {
            console.debug(`Pi IDE Bridge: response end failed: ${String(endError instanceof Error ? endError.message : endError)}`);
          }
          return;
        }
        const status = error instanceof HttpRequestError ? error.statusCode : 500;
        sendJson(res, status, { ok: false, error: String(error instanceof Error ? error.message : error) });
      }
    });

    await new Promise((resolve, reject) => {
      bridgeServer.listen(0, BRIDGE_HOST, resolve);
      bridgeServer.on('error', reject);
    });

    bridgePort = /** @type {import('net').AddressInfo} */ (bridgeServer.address()).port;
    return { host: BRIDGE_HOST, port: bridgePort, authToken };
  }

  function stop() {
    if (bridgeServer) bridgeServer.close();
  }

  return {
    start,
    stop,
    getPort: () => bridgePort,
    getAuthToken: () => authToken,
  };
}

function collectDiagnostics(vscode, editorContextService, { scope, filePath }) {
  const MAX_VISIBLE_FILES = 10;
  const MAX_DIAGNOSTICS_PER_VISIBLE_FILE = 50;
  const MAX_DIAGNOSTICS_FOR_SINGLE = 500;

  const uris = [];
  if (scope === 'all') {
    const seen = new Set();
    const snapshot = editorContextService?.snapshot?.();
    const openFiles = Array.isArray(snapshot?.openFiles) ? snapshot.openFiles : [];

    for (const file of openFiles) {
      const path = typeof file?.path === 'string' ? file.path : '';
      if (!path) continue;
      const key = path;
      if (seen.has(key)) continue;
      seen.add(key);
      uris.push(vscode.Uri.file(path));
      if (uris.length >= MAX_VISIBLE_FILES) break;
    }
  } else if (scope === 'file') {
    uris.push(vscode.Uri.file(filePath));
  } else {
    const snapshot = editorContextService?.snapshot?.();
    const activePath = snapshot?.openFiles?.find((file) => file?.isActive)?.path;

    if (activePath) {
      uris.push(vscode.Uri.file(activePath));
    } else {
      const uri = vscode.window.activeTextEditor?.document?.uri;
      if (uri && uri.scheme === 'file') uris.push(uri);
    }
  }

  const files = [];
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const uri of uris) {
    const maxPerFile = scope === 'all' ? MAX_DIAGNOSTICS_PER_VISIBLE_FILE : MAX_DIAGNOSTICS_FOR_SINGLE;
    const entries = serializeDiagnostics(vscode, vscode.languages.getDiagnostics(uri), maxPerFile);
    if (entries.length === 0) continue;

    files.push({
      path: uri.fsPath,
      diagnostics: entries,
    });

    for (const entry of entries) {
      if (entry.severity === 'error') totalErrors++;
      if (entry.severity === 'warning') totalWarnings++;
    }
  }

  return { files, totalErrors, totalWarnings };
}

function serializeDiagnostics(vscode, diagnostics, limit) {
  const filtered = (diagnostics || [])
    .filter((diag) => diag && (diag.severity === vscode.DiagnosticSeverity.Error || diag.severity === vscode.DiagnosticSeverity.Warning))
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity - b.severity;
      if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
      return a.range.start.character - b.range.start.character;
    })
    .slice(0, limit);

  return filtered.map((diag) => ({
    severity: diag.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
    message: String(diag.message || ''),
    line: diag.range.start.line + 1,
    character: diag.range.start.character + 1,
    source: diag.source ? String(diag.source) : undefined,
    code: diagnosticCodeToString(diag.code),
  }));
}

function diagnosticCodeToString(code) {
  if (typeof code === 'string' || typeof code === 'number') return String(code);
  if (code && typeof code === 'object' && 'value' in code) {
    const value = code.value;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return undefined;
}

module.exports = {
  createBridgeServer,
};
