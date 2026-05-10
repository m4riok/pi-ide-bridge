# Pi IDE Bridge — VS Code Extension

VS Code companion extension for Pi IDE Bridge.

## Behavior

- Starts a localhost HTTP bridge on a random port.
- Writes bridge connection info to `/tmp/pi-ide-bridge/ide/`.
- Opens Pi edit/write proposals in a native VS Code diff editor.
- Provides an Approve button in the diff editor title.
- Closing the diff rejects the proposal.
