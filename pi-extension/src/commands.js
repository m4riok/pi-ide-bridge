import { loadState, setApprovalMode, toggleApprovalMode } from './state.js';

export function handleSlashCommand(input) {
  const cmd = input.trim();

  if (cmd === '/edits auto') {
    const next = setApprovalMode('auto');
    return `Approval mode set to: ${next.approvalMode}`;
  }

  if (cmd === '/edits ask') {
    const next = setApprovalMode('ask');
    return `Approval mode set to: ${next.approvalMode}`;
  }

  if (cmd === '/edits status') {
    const current = loadState();
    return `Approval mode: ${current.approvalMode}`;
  }

  return null;
}

export function handleHotkeyToggle() {
  const next = toggleApprovalMode();
  return `Approval mode toggled to: ${next.approvalMode}`;
}
