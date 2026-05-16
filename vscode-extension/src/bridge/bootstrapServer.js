const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { BRIDGE_HOST, BOOTSTRAP_PORT } = require('../common/constants');
const { sendJson, readRequestJson } = require('./request');
const {
  BRIDGE_BOOTSTRAP_INFO_PATH,
  BRIDGE_BOOTSTRAP_REGISTER_PATH,
  BRIDGE_BOOTSTRAP_HEARTBEAT_PATH,
  BRIDGE_BOOTSTRAP_UNREGISTER_PATH,
  BRIDGE_BOOTSTRAP_RESOLVE_PATH,
} = require('../common/bridge-contract.cjs');

const HEARTBEAT_TTL_MS = 30_000;

// Shared registry — lives in whichever extension host owns the bootstrap port.
// Other windows register via HTTP and never touch this map directly.
const registry = new Map();

function createBootstrapServer() {
  let server;

  function getState() {
    const live = getLiveRecords();
    return {
      host: BRIDGE_HOST,
      bootstrapPort: BOOTSTRAP_PORT,
      ready: live.length > 0,
      liveWindowCount: live.length,
    };
  }

  // Kept for call-site compatibility; no longer has a meaningful effect.
  function setBridgeInfo(_info) {}
  function setBootstrapAuthToken(_token) {}

  async function start() {
    const srv = http.createServer(async (req, res) => {
      const hostHeader = String(req.headers.host || '').toLowerCase();
      if (hostHeader !== `${BRIDGE_HOST}:${BOOTSTRAP_PORT}` && hostHeader !== `localhost:${BOOTSTRAP_PORT}`) {
        sendJson(res, 403, { ok: false, error: 'invalid host' });
        return;
      }
      try {
        await handleRequest(req, res);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    await new Promise((resolve, reject) => {
      srv.listen(BOOTSTRAP_PORT, BRIDGE_HOST, () => resolve(undefined));
      srv.on('error', reject);
    });
    server = srv;
  }

  function stop() {
    if (server) server.close();
  }

  return { start, stop, setBridgeInfo, setBootstrapAuthToken, getState };
}

async function handleRequest(req, res) {
  // Legacy single-window endpoint — returns the most-recently-heartbeated window for backward compat.
  if (req.method === 'GET' && req.url === BRIDGE_BOOTSTRAP_INFO_PATH) {
    const live = getLiveRecords();
    if (live.length === 0) {
      sendJson(res, 200, { ok: true, ready: false });
      return;
    }
    live.sort((a, b) => b.lastHeartbeatAt - a.lastHeartbeatAt);
    const r = live[0];
    sendJson(res, 200, {
      ok: true,
      ready: true,
      port: r.bridgePort,
      authToken: r.bridgeToken,
      workspacePaths: r.workspaceFolders,
    });
    return;
  }

  if (req.method === 'POST' && req.url === BRIDGE_BOOTSTRAP_REGISTER_PATH) {
    const body = await readRequestJson(req);
    const { windowId, bridgePort, bridgeToken, workspaceFolders, terminals, windowPid } = body;
    if (!windowId || !bridgePort || !bridgeToken) {
      sendJson(res, 400, { ok: false, error: 'missing required fields' });
      return;
    }
    const now = Date.now();
    registry.set(String(windowId), {
      windowId: String(windowId),
      bridgePort: Number(bridgePort),
      bridgeToken: String(bridgeToken),
      workspaceFolders: Array.isArray(workspaceFolders) ? workspaceFolders.map(String) : [],
      terminals: Array.isArray(terminals) ? terminals : [],
      windowPid: windowPid != null ? Number(windowPid) : undefined,
      registeredAt: now,
      lastHeartbeatAt: now,
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && req.url === BRIDGE_BOOTSTRAP_HEARTBEAT_PATH) {
    const body = await readRequestJson(req);
    const record = registry.get(String(body?.windowId));
    if (!record) {
      sendJson(res, 404, { ok: false, error: 'window not registered' });
      return;
    }
    record.lastHeartbeatAt = Date.now();
    if (Array.isArray(body.terminals)) record.terminals = body.terminals;
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && req.url === BRIDGE_BOOTSTRAP_UNREGISTER_PATH) {
    const body = await readRequestJson(req);
    registry.delete(String(body?.windowId));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && req.url === BRIDGE_BOOTSTRAP_RESOLVE_PATH) {
    const body = await readRequestJson(req);
    const result = resolveOwner(
      Number(body?.piPid) || 0,
      Number(body?.piParentPid) || 0,
      String(body?.cwd || ''),
    );
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
}

function getLiveRecords() {
  const now = Date.now();
  const live = [];
  for (const [windowId, record] of registry) {
    if (now - record.lastHeartbeatAt < HEARTBEAT_TTL_MS) {
      live.push(record);
    } else {
      registry.delete(windowId);
    }
  }
  return live;
}

function resolveOwner(piPid, piParentPid, cwd) {
  const live = getLiveRecords();

  if (live.length === 0) {
    return { status: 'not_found', reason: 'No active VS Code windows registered' };
  }

  // Stage 1 — process ancestry (Linux only; silently skipped on other platforms).
  // A unique ancestry match is a strong signal — return immediately.
  if (piPid > 0) {
    const ancestryMatches = [];
    for (const record of live) {
      const shellPids = record.terminals
        .map((t) => t.shellPid)
        .filter((p) => typeof p === 'number' && p > 0);
      for (const shellPid of shellPids) {
        if (piParentPid === shellPid || isAncestorOf(piPid, shellPid)) {
          ancestryMatches.push(record);
          break;
        }
      }
    }
    if (ancestryMatches.length === 1) {
      return { status: 'ready', matchReason: 'ancestry', bridge: bridgePayload(ancestryMatches[0]) };
    }
    // Multiple ancestry matches: fall through to cwd to narrow down.
  }

  // Stage 2 — CWD workspace containment.
  // A unique cwd match is a weak but acceptable signal.
  // No match or multiple matches → hard refuse; do not guess.
  let bestScore = -1;
  let bestCandidates = [];
  for (const record of live) {
    const score = workspaceScore(record.workspaceFolders, cwd);
    if (score > bestScore) {
      bestScore = score;
      bestCandidates = [record];
    } else if (score === bestScore && score >= 0) {
      bestCandidates.push(record);
    }
  }

  if (bestScore >= 0 && bestCandidates.length === 1) {
    return { status: 'ready', matchReason: 'workspace', bridge: bridgePayload(bestCandidates[0]) };
  }

  // CWD did not uniquely identify a window — refuse to connect.
  return {
    status: 'ambiguous',
    candidates: bestCandidates.map((r) => ({ windowId: r.windowId, workspaceFolders: r.workspaceFolders })),
  };
}

function bridgePayload(record) {
  return { port: record.bridgePort, authToken: record.bridgeToken, windowId: record.windowId };
}

function workspaceScore(workspaceFolders, cwd) {
  if (!cwd) return -1;
  let best = -1;
  for (const folder of workspaceFolders) {
    if (cwd === folder || cwd.startsWith(folder + '/') || cwd.startsWith(folder + path.sep)) {
      if (folder.length > best) best = folder.length;
    }
  }
  return best;
}

// Walk the process tree upward to check ancestry. Only works on Linux (/proc).
function getParentPid(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/^PPid:\s+(\d+)/m);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function isAncestorOf(targetPid, ancestorPid) {
  let current = targetPid;
  for (let depth = 0; depth < 12; depth++) {
    const parent = getParentPid(current);
    if (parent === null || parent <= 1) return false;
    if (parent === ancestorPid) return true;
    current = parent;
  }
  return false;
}

module.exports = { createBootstrapServer };
