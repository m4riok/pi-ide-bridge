const http = require('node:http');
const { BRIDGE_HOST } = require('../common/constants');
const { createAuthToken, isAuthorized } = require('./auth');
const { HttpRequestError, readRequestJson, sendJson } = require('./request');
const { BRIDGE_OPEN_DIFF_PATH, BRIDGE_CLOSE_DIFF_PATH, BRIDGE_HEALTH_PATH } = require('../../../shared/bridge-contract.cjs');

function createBridgeServer({ vscode, diffManager }) {
  let bridgeServer;
  let bridgePort;
  let authToken;

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

module.exports = {
  createBridgeServer,
};
