# Pi IDE Bridge implementation notes

## Current architecture

- VS Code extension starts an authenticated localhost HTTP bridge on a random port.
- Connection info is written to `/tmp/pi-ide-bridge/ide/pi-ide-bridge-server-<ppid>-<port>.json`.
- Pi extension discovers the newest connection file and posts approval requests to the bridge.
- VS Code renders diffs with a virtual `pi-ide-bridge-after:` document provider.
- Pi prompt and VS Code decision race; first decision wins.

## Current edit approval behavior

- Auto mode: Pi applies edits immediately.
- Ask mode: Pi opens VS Code diff and prompts in TUI.
- Pi `Yes`: approve current edit.
- Pi `Yes, auto-accept edits`: approve current edit and enable auto mode.
- Pi `No`: reject, store hidden rejected-diff context, abort current turn.
- VS Code Approve button: approve current edit.
- Closing VS Code diff: reject current edit.

## Developer loop

1. Start VS Code extension host with `Run Pi IDE Bridge Extension`.
2. Run `/reload` in Pi after Pi extension edits.
3. Test in `/tmp/test-extension`.
