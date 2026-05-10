import { askEditApproval } from './prompt.js';
import { loadState, setApprovalMode } from './state.js';

export async function shouldApplyEdit({ filePath }) {
  const state = loadState();

  if (state.approvalMode === 'auto') {
    return { allow: true, mode: 'auto' };
  }

  const choice = await askEditApproval({ filePath });

  if (choice === 'accept_and_enable_auto') {
    setApprovalMode('auto');
    return { allow: true, mode: 'auto' };
  }

  if (choice === 'accept_once') {
    return { allow: true, mode: 'ask' };
  }

  return { allow: false, mode: 'ask' };
}
