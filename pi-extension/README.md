# Pi IDE Bridge — Pi Extension

Pi-side extension for IDE-integrated edit approval.

## Behavior

- Intercepts `edit` and `write` tool calls.
- Opens proposed changes in the IDE companion diff view.
- Races Pi TUI prompt against IDE approval/rejection; first decision wins.
- `shift+~` toggles global auto-accept mode.
- Rejected changes are stored as hidden context for the next user turn.
