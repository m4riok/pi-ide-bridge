import type { ApprovalMode } from './types.js';

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
  } catch (error) {
    console.warn(`Pi IDE Bridge: failed to set connection status UI: ${String((error as Error)?.message || error)}`);
  }
}

function safeSetApprovalStatus(ctx: any, text: string | undefined) {
  try {
    ctx.ui.setStatus('pi-ide-bridge-approval', text);
    ctx.ui.setWidget('pi-ide-bridge-approval', text ? [text] : undefined, { placement: 'belowEditor' });
  } catch (error) {
    console.warn(`Pi IDE Bridge: failed to set approval status UI: ${String((error as Error)?.message || error)}`);
  }
}
