import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import * as http from 'node:http';

const BRIDGE_HOST = '127.0.0.1';
const STARTUP_STATUS_DURATION_MS = 20_000;
const TOGGLE_STATUS_DURATION_MS = 5_000;
const VSCODE_EXTENSION_ID = 'm4riok.pi-ide-bridge-vscode';
type ApprovalMode = 'ask' | 'auto';
type ApprovalDecision = 'approved' | 'approved_auto' | 'rejected';

type RejectedChange = {
  filePath: string;
  beforeText: string;
  afterText: string;
  rejectedAt: number;
};

let statusHideTimer: ReturnType<typeof setTimeout> | undefined;
let statusHideGeneration = 0;

export default function (pi: ExtensionAPI) {
  let mode: ApprovalMode = 'ask';
  let pendingRejectedChange: RejectedChange | undefined;

  pi.on('session_start', async (_event, ctx) => {
    applyApprovalStatus(ctx, mode, STARTUP_STATUS_DURATION_MS);

    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== 'custom' || entry.customType !== 'pi-ide-bridge-rejected-change') continue;
      const data = (entry.data || {}) as Partial<RejectedChange>;
      if (typeof data.filePath !== 'string') continue;
      pendingRejectedChange = {
        filePath: data.filePath,
        beforeText: String(data.beforeText ?? ''),
        afterText: String(data.afterText ?? ''),
        rejectedAt: Number(data.rejectedAt ?? Date.now()),
      };
      break;
    }
  });

  pi.on('session_shutdown', async () => {
    if (statusHideTimer) {
      clearTimeout(statusHideTimer);
      statusHideTimer = undefined;
    }
    statusHideGeneration++;
  });

  pi.on('before_agent_start', async (_event, ctx) => {
    if (!pendingRejectedChange) return;
    const rejected = pendingRejectedChange;
    pendingRejectedChange = undefined;

    return {
      message: {
        customType: 'pi-ide-bridge-rejected-change',
        display: false,
        content: [
          'User rejected a proposed edit in the previous step.',
          'If relevant to the new user prompt, revise that same proposal instead of starting over.',
          `File: ${rejected.filePath}`,
          '--- BEFORE ---',
          rejected.beforeText,
          '--- AFTER (REJECTED) ---',
          rejected.afterText,
        ].join('\n'),
        details: rejected,
      },
    };
  });

  pi.registerShortcut('f8', {
    description: 'Toggle edit approval mode',
    handler: async (ctx) => {
      mode = mode === 'auto' ? 'ask' : 'auto';
      applyApprovalStatus(ctx, mode, TOGGLE_STATUS_DURATION_MS);
    },
  });

  pi.registerCommand('ide', {
    description: 'Show IDE bridge status or install the VS Code extension',
    handler: async (args, ctx) => {
      const action = String(args || '').trim().toLowerCase();

      if (!action || action === 'status') {
        const status = await getIdeConnectionStatus();
        ctx.ui.notify(status.text, status.type);
        return;
      }

      if (action === 'install') {
        const installed = await installVsCodeCompanion();
        if (installed) {
          ctx.ui.notify('✓ VS Code companion extension installed. Run /ide status to verify connection.', 'info');
          return;
        }

        ctx.ui.notify("✕ No installer is available for IDE. Please install the 'Pi IDE Bridge' extension manually from the marketplace.", 'error');
        return;
      }

      if (action === 'help') {
        ctx.ui.notify('Usage: /ide | /ide status | /ide install', 'info');
        return;
      }

      ctx.ui.notify('Usage: /ide | /ide status | /ide install', 'info');
    },
  });

  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'edit' && event.toolName !== 'write') return;

    const pathArg = String((event.input as any).path || '');
    if (!pathArg) return;
    if (mode === 'auto') return;

    const filePath = resolve(ctx.cwd, pathArg);
    const beforeText = await readFile(filePath, 'utf8').catch(() => '');
    const afterText = event.toolName === 'write'
      ? String((event.input as any).content ?? '')
      : applyEditPreview(beforeText, (event.input as any).edits ?? []);

    const piPromptAbort = new AbortController();

    const vscodeDecisionPromise = sendOpenDiff({ filePath, beforeText, afterText, requestId: event.toolCallId })
      .then((decision) => normalizeVscodeDecision(decision));

    const piDecisionPromise = askPiDecision(ctx, pathArg, piPromptAbort.signal);

    const decision = await Promise.race([
      vscodeDecisionPromise.then((d) => {
        piPromptAbort.abort();
        return d;
      }),
      piDecisionPromise,
    ]);

    if (decision === 'approved_auto') {
      mode = 'auto';
      applyApprovalStatus(ctx, mode, TOGGLE_STATUS_DURATION_MS);
      await sendCloseDiff(event.toolCallId, 'approved_auto');
      return;
    }

    if (decision === 'approved') {
      await sendCloseDiff(event.toolCallId, 'approved');
      return;
    }

    const rejected: RejectedChange = {
      filePath,
      beforeText,
      afterText,
      rejectedAt: Date.now(),
    };
    pendingRejectedChange = rejected;
    pi.appendEntry('pi-ide-bridge-rejected-change', rejected);

    await sendCloseDiff(event.toolCallId, 'rejected');
    ctx.abort();
    return { block: true, reason: `User rejected update to ${pathArg}` };
  });
}

async function askPiDecision(ctx: any, pathArg: string, signal?: AbortSignal): Promise<ApprovalDecision> {
  const choice = await ctx.ui.select(
    `Do you want to make this edit to ${pathArg}?`,
    ['Yes', 'Yes, auto-accept edits', 'No'],
    { signal }
  );

  if (choice === 'Yes, auto-accept edits') return 'approved_auto';
  if (choice === 'Yes') return 'approved';
  return 'rejected';
}

function normalizeVscodeDecision(decision: string): ApprovalDecision {
  if (decision === 'approved') return 'approved';
  return 'rejected';
}

function applyApprovalStatus(ctx: any, mode: ApprovalMode, durationMs: number) {
  const theme = ctx.ui?.theme;
  const base = `⏵⏵ auto-accept edits: ${mode === 'auto' ? 'on' : 'off'} (F8 to cycle)`;
  const text = mode === 'auto'
    ? (theme ? theme.fg('accent', base) : base)
    : (theme ? theme.fg('error', base) : base);

  safeSetApprovalStatus(ctx, text);

  if (statusHideTimer) clearTimeout(statusHideTimer);
  const generation = ++statusHideGeneration;
  statusHideTimer = setTimeout(() => {
    if (generation !== statusHideGeneration) return;
    safeSetApprovalStatus(ctx, undefined);
  }, durationMs);
}

function safeSetApprovalStatus(ctx: any, text: string | undefined) {
  try {
    ctx.ui.setStatus('pi-ide-bridge-approval', text);
    ctx.ui.setWidget('pi-ide-bridge-approval', text ? [text] : undefined, { placement: 'belowEditor' });
  } catch {
    // Ignore stale-context access after session replacement/reload.
  }
}

function applyEditPreview(original: string, edits: Array<{ oldText: string; newText: string }>): string {
  let output = original;
  for (const edit of edits) {
    if (!edit || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') continue;
    const idx = findUniqueOccurrence(output, edit.oldText);
    if (idx === undefined) continue;
    output = output.slice(0, idx) + edit.newText + output.slice(idx + edit.oldText.length);
  }
  return output;
}

function findUniqueOccurrence(text: string, search: string): number | undefined {
  if (!search) return undefined;

  const first = text.indexOf(search);
  if (first === -1) return undefined;

  const second = text.indexOf(search, first + 1);
  return second === -1 ? first : undefined;
}

async function sendOpenDiff(payload: {
  filePath: string;
  beforeText: string;
  afterText: string;
  requestId: string;
}): Promise<string> {
  const connection = await resolveBridgeConnectionInfo();
  if (!connection) return waitForPiPromptOnly('no active VS Code bridge connection');

  return postBridgeMessage(connection, '/openDiff', payload)
    .then((res) => String(res?.decision || 'rejected'))
    .catch((error) => waitForPiPromptOnly(`VS Code bridge request failed: ${String(error?.message || error)}`));
}

function waitForPiPromptOnly(reason: string): Promise<string> {
  console.warn(`Pi IDE Bridge: ${reason}; waiting for Pi prompt decision.`);
  return new Promise(() => undefined);
}

async function sendCloseDiff(requestId: string, decision: ApprovalDecision | 'closed_by_pi'): Promise<void> {
  const connection = await resolveBridgeConnectionInfo();
  if (!connection) return;
  return postBridgeMessage(connection, '/closeDiff', { requestId, decision }).then(() => undefined).catch(() => undefined);
}

function readConnectionFromEnv(): { port: number; authToken: string } | undefined {
  const rawPort = process.env['PI_IDE_BRIDGE_SERVER_PORT'];
  const authToken = process.env['PI_IDE_BRIDGE_AUTH_TOKEN'];
  const port = rawPort ? Number(rawPort) : NaN;

  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  if (!authToken) return undefined;

  return { port, authToken };
}

async function resolveBridgeConnectionInfo(): Promise<{ port: number; authToken: string } | undefined> {
  return readConnectionFromEnv();
}

function postBridgeMessage(
  connection: { port: number; authToken: string },
  pathName: string,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const body = JSON.stringify(message);
    const req = http.request(
      {
        host: BRIDGE_HOST,
        port: connection.port,
        path: pathName,
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.authToken}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let response = '';
        res.on('data', (chunk) => {
          response += chunk.toString('utf8');
        });
        res.on('end', () => {
          try {
            resolvePromise(response ? JSON.parse(response) : {});
          } catch {
            resolvePromise({});
          }
        });
      },
    );

    req.on('error', rejectPromise);
    req.write(body);
    req.end();
  });
}

async function getIdeConnectionStatus(): Promise<{ type: 'info'; text: string }> {
  const connection = await resolveBridgeConnectionInfo();
  if (!connection) {
    return {
      type: 'info',
      text: "🔴 Disconnected: Failed to connect to Pi IDE Bridge extension in VS Code. Please ensure the extension is running. To install the extension, run /ide install.",
    };
  }

  const healthy = await pingBridgeHealth(connection);
  if (!healthy) {
    return {
      type: 'info',
      text: "🔴 Disconnected: Failed to connect to Pi IDE Bridge extension in VS Code. Please ensure the extension is running. To install the extension, run /ide install.",
    };
  }

  return { type: 'info', text: '🟢 Connected to VS Code' };
}

async function pingBridgeHealth(connection: { port: number; authToken: string }): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const req = http.request(
      {
        host: BRIDGE_HOST,
        port: connection.port,
        path: '/health',
        method: 'GET',
        headers: {
          authorization: `Bearer ${connection.authToken}`,
        },
      },
      (res) => {
        resolvePromise((res.statusCode || 500) >= 200 && (res.statusCode || 500) < 300);
      },
    );

    req.on('error', () => resolvePromise(false));
    req.end();
  });
}

async function installVsCodeCompanion(): Promise<boolean> {
  const commands = [
    ['code', ['--install-extension', VSCODE_EXTENSION_ID, '--force']] as const,
    ['code.cmd', ['--install-extension', VSCODE_EXTENSION_ID, '--force']] as const,
  ];

  for (const [command, args] of commands) {
    const success = await runInstallerCommand(command, [...args]);
    if (success) return true;
  }

  return false;
}

async function runInstallerCommand(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: process.platform === 'win32' });
    child.on('error', () => resolvePromise(false));
    child.on('close', (code) => resolvePromise(code === 0));
  });
}
