import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { STARTUP_STATUS_DURATION_MS, TOGGLE_STATUS_DURATION_MS } from './constants.js';
import { applyEditPreview } from './editPreview.js';
import { connectContextStream, getIdeConnectionDebugInfo, getIdeConnectionStatus, isIdeConnected, sendCloseDiff, sendOpenDiff } from './ideBridgeClient.js';
import { installVsCodeCompanion } from './installer.js';
import { applyApprovalStatus, applyConnectionStatus, applyIdeContextStatus, clearApprovalStatusTimer, clearConnectionStatusTimer } from './status.js';
import type { ApprovalDecision, ApprovalMode, EditorContext, RejectedChange } from './types.js';

const IDE_USAGE = 'Usage: /ide | /ide status | /ide context | /ide install | /ide debug';
const IDE_CONNECTION_POLL_MS = 7_000;
const IDE_CONNECTION_STATUS_DURATION_MS = 3_000;
const IDE_CONTEXT_SELECTED_PREVIEW_MAX_CHARS = 200;

export default function createPiIdeBridgeExtension(pi: ExtensionAPI) {
  let mode: ApprovalMode = 'ask';
  let pendingRejectedChange: RejectedChange | undefined;
  let ideConnectionPollTimer: ReturnType<typeof setInterval> | undefined;
  let lastIdeConnected: boolean | undefined;
  let liveContext: EditorContext | undefined;
  let contextStreamHandle: { disconnect: () => void } | undefined;
  let contextReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let contextReconnectAttempt = 0;

  pi.on('session_start', async (_event, ctx) => {
    applyApprovalStatus(ctx, mode, STARTUP_STATUS_DURATION_MS);

    const pollIdeConnection = async () => {
      const connected = await isIdeConnected().catch(() => false);
      if (lastIdeConnected === undefined || connected !== lastIdeConnected) {
        applyConnectionStatus(ctx, connected, IDE_CONNECTION_STATUS_DURATION_MS);
        lastIdeConnected = connected;
      }
    };

    await pollIdeConnection();
    if (ideConnectionPollTimer) clearInterval(ideConnectionPollTimer);
    ideConnectionPollTimer = setInterval(() => {
      pollIdeConnection().catch(() => {});
    }, IDE_CONNECTION_POLL_MS);

    const reconnectDelays = [150, 300, 600, 1_000, 5_000];
    const clearReconnectTimer = () => {
      if (contextReconnectTimer) {
        clearTimeout(contextReconnectTimer);
        contextReconnectTimer = undefined;
      }
    };

    const startContextStream = () => {
      contextStreamHandle = connectContextStream(
        (context) => {
          liveContext = context;
          contextReconnectAttempt = 0;
          clearReconnectTimer();
          applyIdeContextStatus(ctx, context);
        },
        () => {
          if (contextReconnectTimer) return;
          const delay = reconnectDelays[Math.min(contextReconnectAttempt, reconnectDelays.length - 1)];
          contextReconnectAttempt++;
          contextReconnectTimer = setTimeout(() => {
            contextReconnectTimer = undefined;
            startContextStream();
          }, delay);
        },
      );
    };

    startContextStream();

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

  pi.on('session_shutdown', async (_event, ctx) => {
    clearApprovalStatusTimer();
    clearConnectionStatusTimer();
    if (ideConnectionPollTimer) {
      clearInterval(ideConnectionPollTimer);
      ideConnectionPollTimer = undefined;
    }
    if (contextReconnectTimer) {
      clearTimeout(contextReconnectTimer);
      contextReconnectTimer = undefined;
    }
    contextStreamHandle?.disconnect();
    contextStreamHandle = undefined;
    contextReconnectAttempt = 0;
    liveContext = undefined;
    applyIdeContextStatus(ctx, undefined);
    lastIdeConnected = undefined;
  });

  pi.on('before_agent_start', async (_event, _ctx) => {
    if (pendingRejectedChange) {
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
    }

    if (!liveContext || !Array.isArray(liveContext.openFiles) || liveContext.openFiles.length === 0) return;

    const active = liveContext.openFiles.find((file) => file.isActive) || liveContext.openFiles[0];
    if (!active) return;

    const cursor = active.cursor ? `line ${active.cursor.line}, col ${active.cursor.character}` : 'cursor unknown';
    const selectedText = active.selectedText || '';
    const selectedLines = selectedText ? selectedText.split(/\r?\n/).length : 0;
    const selectedPreview = selectedText.length > IDE_CONTEXT_SELECTED_PREVIEW_MAX_CHARS
      ? `${selectedText.slice(0, IDE_CONTEXT_SELECTED_PREVIEW_MAX_CHARS)}…`
      : selectedText;
    const selectedInfo = selectedText
      ? `"${selectedPreview}" (${selectedLines} line${selectedLines === 1 ? '' : 's'})`
      : '(none)';
    const openFileNames = liveContext.openFiles.map((file) => file.path.split('/').pop() || file.path);
    const preview = openFileNames.slice(0, 2).join(', ');
    const remaining = openFileNames.length - 2;

    return {
      message: {
        customType: 'pi-ide-bridge-editor-context',
        display: false,
        content: [
          '[IDE Context]',
          `Active file: ${active.path} — ${cursor}`,
          `Selected: ${selectedInfo}`,
          `Open files: ${preview}${remaining > 0 ? `, +${remaining} more` : ''}`,
        ].join('\n'),
        details: liveContext,
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

      if (action === 'debug') {
        const debug = await getIdeConnectionDebugInfo();
        if (debug.connected) {
          ctx.ui.notify(`Pi IDE Bridge debug: connected=yes source=${debug.source} port=${String(debug.port ?? 'n/a')}`, 'info');
          return;
        }
        ctx.ui.notify(`Pi IDE Bridge debug: connected=no source=${debug.source} reason=${String(debug.reason || 'unknown')}`, 'info');
        return;
      }

      if (action === 'context') {
        if (!liveContext) {
          ctx.ui.notify('Pi IDE Bridge context: unavailable (no SSE context received yet).', 'info');
          return;
        }

        const payload = JSON.stringify(liveContext, null, 2);
        pi.sendMessage({
          customType: 'pi-ide-bridge-context-debug',
          display: true,
          content: ['[IDE Context Debug]', payload].join('\n'),
          details: liveContext,
        });
        ctx.ui.notify('Pi IDE Bridge context dumped to chat.', 'info');
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
        ctx.ui.notify(IDE_USAGE, 'info');
        return;
      }

      ctx.ui.notify(IDE_USAGE, 'info');
    },
  });

  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'edit' && event.toolName !== 'write') return;

    const pathArg = String((event.input as any).path || '');
    if (!pathArg) return;
    if (mode === 'auto') return;

    const filePath = resolve(ctx.cwd, pathArg);
    const beforeText = await readFile(filePath, 'utf8').catch(() => '');
    const preview = event.toolName === 'write'
      ? { output: String((event.input as any).content ?? ''), appliedCount: 1, skippedCount: 0 }
      : applyEditPreview(beforeText, (event.input as any).edits ?? []);
    const afterText = preview.output;
    if (event.toolName === 'edit' && preview.skippedCount > 0) {
      ctx.ui.notify(`Pi IDE Bridge: ${preview.skippedCount} edit preview segment(s) could not be mapped exactly.`, 'info');
    }

    const piPromptAbort = new AbortController();

    const vscodeDecisionPromise = sendOpenDiff({ filePath, beforeText, afterText, requestId: event.toolCallId })
      .then((decision) => normalizeVscodeDecision(decision))
      .catch((error) => {
        ctx.ui.notify(`Pi IDE Bridge: IDE review unavailable (${String(error instanceof Error ? error.message : error)}). Falling back to Pi prompt.`, 'info');
        return new Promise<ApprovalDecision>(() => undefined);
      });

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
      await sendCloseDiff(event.toolCallId, 'approved');
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
