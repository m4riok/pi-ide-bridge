import { spawn } from 'node:child_process';
import { VSCODE_EXTENSION_ID } from './constants.js';

export async function installVsCodeCompanion(): Promise<boolean> {
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
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      console.warn(`Pi IDE Bridge installer failed to start (${command}): ${String(error.message || error)}`);
      resolvePromise(false);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        console.warn(`Pi IDE Bridge installer failed (${command}, code=${String(code)}): ${stderr.trim()}`);
      }
      resolvePromise(code === 0);
    });
  });
}
