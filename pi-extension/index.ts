import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as http from 'node:http';

const BRIDGE_HOST = '127.0.0.1';
const CONNECTION_DIR = join(tmpdir(), 'pi-ide-bridge', 'ide');
const STARTUP_STATUS_DURATION_MS = 20_000;
const TOGGLE_STATUS_DURATION_MS = 5_000;
type ApprovalMode = 'ask' | 'auto';
type ApprovalDecision = 'approved' | 'approved_auto' | 'rejected';

type RejectedChange = {
  filePath: string;
  beforeText: string;
  afterText: string;
  rejectedAt: number;
};

let statusHideTimer: ReturnType<typeof setTimeout> | undefined;

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

  pi.registerShortcut('shift+~', {
    description: 'Toggle edit approval mode',
    handler: async (ctx) => {
      mode = mode === 'auto' ? 'ask' : 'auto';
      applyApprovalStatus(ctx, mode, TOGGLE_STATUS_DURATION_MS);
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
  const base = `⏵⏵ auto-accept edits: ${mode === 'auto' ? 'on' : 'off'} (shift+~ to cycle)`;
  const text = mode === 'auto'
    ? (theme ? theme.fg('accent', base) : base)
    : (theme ? theme.fg('error', base) : base);

  ctx.ui.setStatus('pi-ide-bridge-approval', text);
  ctx.ui.setWidget('pi-ide-bridge-approval', [text], { placement: 'belowEditor' });

  if (statusHideTimer) clearTimeout(statusHideTimer);
  statusHideTimer = setTimeout(() => {
    ctx.ui.setStatus('pi-ide-bridge-approval', undefined);
    ctx.ui.setWidget('pi-ide-bridge-approval', undefined);
  }, durationMs);
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
  const connection = await readLatestConnectionInfo();
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
  const connection = await readLatestConnectionInfo();
  if (!connection) return;
  return postBridgeMessage(connection, '/closeDiff', { requestId, decision }).then(() => undefined).catch(() => undefined);
}

async function readLatestConnectionInfo(): Promise<{ port: number; authToken: string } | undefined> {
  try {
    const names = await readdir(CONNECTION_DIR);
    const candidates = await Promise.all(
      names
        .filter((name) => /^pi-ide-bridge-server-\d+-\d+\.json$/.test(name))
        .map(async (name) => {
          const fullPath = join(CONNECTION_DIR, name);
          return { fullPath, mtimeMs: (await stat(fullPath)).mtimeMs };
        }),
    );

    const files = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const file of files) {
      const parsed = JSON.parse(await readFile(file.fullPath, 'utf8')) as { port?: unknown; authToken?: unknown };
      if (typeof parsed.port === 'number' && typeof parsed.authToken === 'string') {
        return { port: parsed.port, authToken: parsed.authToken };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
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
