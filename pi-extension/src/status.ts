import { basename } from 'node:path';
import type { ApprovalMode, EditorContext } from './types.js';

let statusHideTimer: ReturnType<typeof setTimeout> | undefined;
let statusHideGeneration = 0;
let connectionHideTimer: ReturnType<typeof setTimeout> | undefined;
let connectionHideGeneration = 0;

export function clearApprovalStatusTimer() {
  if (statusHideTimer) {
    clearTimeout(statusHideTimer);
    statusHideTimer = undefined;
  }
  statusHideGeneration++;
}

export function clearConnectionStatusTimer() {
  if (connectionHideTimer) {
    clearTimeout(connectionHideTimer);
    connectionHideTimer = undefined;
  }
  connectionHideGeneration++;
}

export function applyConnectionStatus(ctx: any, connected: boolean, durationMs: number) {
  const theme = ctx.ui?.theme;
  const base = connected ? '🟢 IDE connected' : '🔴 IDE disconnected';
  const text = connected
    ? (theme ? theme.fg('accent', base) : base)
    : (theme ? theme.fg('error', base) : base);

  safeSetConnectionStatus(ctx, text);

  if (connectionHideTimer) clearTimeout(connectionHideTimer);
  const generation = ++connectionHideGeneration;
  connectionHideTimer = setTimeout(() => {
    if (generation !== connectionHideGeneration) return;
    safeSetConnectionStatus(ctx, undefined);
  }, durationMs);
}

export function applyApprovalStatus(ctx: any, mode: ApprovalMode, durationMs: number) {
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

function safeSetConnectionStatus(ctx: any, text: string | undefined) {
  try {
    ctx.ui.setStatus('pi-ide-bridge-connection', text);
    ctx.ui.setWidget('pi-ide-bridge-connection', text ? [text] : undefined, { placement: 'belowEditor' });
  } catch {
    // Status UI failures must not write to stdout/stderr and disrupt the TUI.
  }
}

export function applyIdeContextStatus(ctx: any, context: EditorContext | undefined) {
  try {
    if (!context || !Array.isArray(context.openFiles) || context.openFiles.length === 0) {
      safeSetContextStatus(ctx, undefined);
      return;
    }

    const active = context.openFiles.find((file) => file.isActive) || context.openFiles[0];
    if (!active) {
      safeSetContextStatus(ctx, undefined);
      return;
    }

    const selectedText = active.selectedText || '';
    const selectedLines = selectedText ? selectedText.split(/\r?\n/).length : 0;
    const base = selectedLines > 0
      ? `✂  ${selectedLines} line${selectedLines === 1 ? '' : 's'} selected`
      : `◉  In ${basename(active.path)}`;
    const text = formatDeepBluePurple(ctx, base);
    safeSetContextStatus(ctx, text);
  } catch {
    // Status UI failures must not write to stdout/stderr and disrupt the TUI.
  }
}

function formatDeepBluePurple(ctx: any, text: string): string {
  const theme = ctx.ui?.theme;
  if (theme?.fg) return theme.fg('accent', text);
  return `\u001b[38;2;74;61;196m${text}\u001b[0m`;
}

function safeSetContextStatus(ctx: any, text: string | undefined) {
  try {
    ctx.ui.setStatus('pi-ide-bridge-context', text);
    ctx.ui.setWidget('pi-ide-bridge-context', text ? [text] : undefined, { placement: 'belowEditor' });
  } catch {
    // Status UI failures must not write to stdout/stderr and disrupt the TUI.
  }
}

function safeSetApprovalStatus(ctx: any, text: string | undefined) {
  try {
    ctx.ui.setStatus('pi-ide-bridge-approval', text);
    ctx.ui.setWidget('pi-ide-bridge-approval', text ? [text] : undefined, { placement: 'belowEditor' });
  } catch {
    // Status UI failures must not write to stdout/stderr and disrupt the TUI.
  }
}
