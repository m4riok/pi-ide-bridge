# Pi IDE Bridge

Pi IDE Bridge helps you review and approve changes in VS Code before Pi applies them.

## What this project gives you

- Review proposed edits in a familiar VS Code diff view
- Approve or reject changes before files are updated
- Give Pi useful editor context from:
  - open files
  - active file
  - selected lines
  - cursor position
- Use `get_ide_diagnostics` to fetch diagnostics for:
  - all open files
  - a specific file

## Project parts

- `pi-extension/` — the Pi side
- `vscode-extension/` — the VS Code side
