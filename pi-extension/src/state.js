import fs from 'node:fs';
import path from 'node:path';

const STATE_PATH = path.resolve(process.cwd(), '.vsdiff-state.json');
const DEFAULT_STATE = { approvalMode: 'ask' }; // ask | auto

export function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return { ...DEFAULT_STATE };
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      approvalMode: parsed.approvalMode === 'auto' ? 'auto' : 'ask',
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function toggleApprovalMode() {
  const current = loadState();
  const next = { approvalMode: current.approvalMode === 'auto' ? 'ask' : 'auto' };
  saveState(next);
  return next;
}

export function setApprovalMode(mode) {
  const next = { approvalMode: mode === 'auto' ? 'auto' : 'ask' };
  saveState(next);
  return next;
}
