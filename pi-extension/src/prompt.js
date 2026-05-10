// Replace this with real Pi interactive prompt API integration.
export async function askEditApproval({ filePath }) {
  // MVP stdin fallback.
  process.stdout.write(`\nDo you want to make this edit to ${filePath}?\n`);
  process.stdout.write('1) Yes\n');
  process.stdout.write('2) Yes, auto-accept edits\n');
  process.stdout.write('3) No\n');
  process.stdout.write('Select [1-3]: ');

  const answer = await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', (buf) => resolve(String(buf).trim()));
  });

  if (answer === '2') return 'accept_and_enable_auto';
  if (answer === '1') return 'accept_once';
  return 'deny';
}
