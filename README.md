# Pi IDE Bridge

General bridge between Pi and IDE integrations.

## Packages

- `pi-extension/` — Pi-side extension. Intercepts edit/write approval flow and talks to the IDE bridge.
- `vscode-extension/` — VS Code companion extension. Provides native diff review and approval UI.

## Current features

- Native VS Code diff for Pi edit/write proposals
- Approval from either Pi TUI prompt or VS Code Approve button
- Closing the VS Code diff rejects the change
- Global auto-accept toggle via `shift+~`
- Rejected diffs are preserved as hidden next-turn context

## Development

From this repo root, press F5 in VS Code using the `Run Pi IDE Bridge Extension` launch config.
The extension host opens `/tmp/test-extension` in WSL for testing.

Pi loads the extension via symlink:

```text
~/.pi/agent/extensions/pi-ide-bridge.ts -> ~/pidev/pi-ide-bridge/pi-extension/index.ts
```

After editing the Pi extension, run `/reload` in Pi.
