import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VSCODE_EXTENSION_ID } from './constants.js';

const LOCAL_DEBUG_VSIX = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../vscode-extension/pi-ide-bridge-vscode-0.2.1.vsix',
);

export async function installVsCodeCompanion(): Promise<boolean> {
  return installVsCodeExtension(VSCODE_EXTENSION_ID);
}

export async function installVsCodeCompanionFromLocalDebugVsix(): Promise<boolean> {
  const exists = await access(LOCAL_DEBUG_VSIX).then(() => true).catch(() => false);
  if (!exists) return false;
  return installVsCodeExtension(LOCAL_DEBUG_VSIX);
}

function installVsCodeExtension(extensionSpec: string): Promise<boolean> {
  const commands = [
    ['code', ['--install-extension', extensionSpec, '--force']] as const,
    ['code.cmd', ['--install-extension', extensionSpec, '--force']] as const,
  ];

  return runInstallerCommands(commands);
}

async function runInstallerCommands(commands: ReadonlyArray<readonly [string, readonly string[]]>): Promise<boolean> {
  for (const [command, args] of commands) {
    const success = await runInstallerCommand(command, [...args]);
    if (success) return true;
  }

  return false;
}

async function runInstallerCommand(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: process.platform === 'win32' });
    child.on('error', () => {
      resolvePromise(false);
    });
    child.on('close', (code) => {
      resolvePromise(code === 0);
    });
  });
}
