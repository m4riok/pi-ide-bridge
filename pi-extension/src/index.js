import { shouldApplyEdit } from './approvalGate.js';
import { handleSlashCommand, handleHotkeyToggle } from './commands.js';

// Integration stubs:
// 1) Wire handleSlashCommand into Pi slash command handler.
// 2) Wire handleHotkeyToggle into Pi keybinding Ctrl+Alt+Shift+A.
// 3) Wrap Pi edit/write tool calls with shouldApplyEdit().

async function demo() {
  const slashResult = handleSlashCommand(process.argv[2] || '');
  if (slashResult) {
    console.log(slashResult);
    return;
  }

  if (process.argv[2] === '--toggle') {
    console.log(handleHotkeyToggle());
    return;
  }

  const res = await shouldApplyEdit({ filePath: 'hello.c' });
  console.log(res.allow ? 'Edit approved' : 'Edit denied', `(mode=${res.mode})`);
}

demo();
