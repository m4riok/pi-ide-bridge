const http = require('node:http');
const { BRIDGE_HOST, BOOTSTRAP_PORT } = require('../common/constants');
const { sendJson } = require('./request');
const { BRIDGE_BOOTSTRAP_INFO_PATH } = require('../../../shared/bridge-contract.cjs');

function createBootstrapServer(vscode) {
  let server;
  let bootstrapAuthToken;
  let state = { ready: false, port: undefined, authToken: undefined };

  function setBridgeInfo(info) {
    state = {
      ready: Boolean(info?.ready),
      port: info?.port,
      authToken: info?.authToken,
    };
  }

  function setBootstrapAuthToken(token) {
    bootstrapAuthToken = token;
  }

  function getState() {
    return {
      ready: state.ready,
      bridgePort: state.port,
      host: BRIDGE_HOST,
      bootstrapPort: BOOTSTRAP_PORT,
    };
  }

  async function start() {
    server = http.createServer((req, res) => {
      const hostHeader = String(req.headers.host || '').toLowerCase();
      if (hostHeader !== `${BRIDGE_HOST}:${BOOTSTRAP_PORT}` && hostHeader !== `localhost:${BOOTSTRAP_PORT}`) {
        sendJson(res, 403, { ok: false, error: 'invalid host' });
        return;
      }

      if (req.method === 'GET' && req.url === BRIDGE_BOOTSTRAP_INFO_PATH) {
        const authHeader = String(req.headers.authorization || '');
        if (!bootstrapAuthToken || authHeader !== `Bearer ${bootstrapAuthToken}`) {
          sendJson(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        sendJson(res, 200, {
          ok: true,
          ready: state.ready,
          port: state.port,
          authToken: state.authToken,
          workspacePaths: workspaceFolders.map((f) => f.uri.fsPath),
        });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
    });

    await new Promise((resolve, reject) => {
      server.listen(BOOTSTRAP_PORT, BRIDGE_HOST, resolve);
      server.on('error', reject);
    });
  }

  function stop() {
    if (server) server.close();
  }

  return { start, stop, setBridgeInfo, setBootstrapAuthToken, getState };
}

module.exports = { createBootstrapServer };
