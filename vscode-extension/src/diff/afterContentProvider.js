function createAfterContentProvider(vscode, scheme) {
  const afterContentByUri = new Map();
  const MAX_ENTRIES = 256;

  const provider = {
    provideTextDocumentContent(uri) {
      return afterContentByUri.get(uri.toString()) ?? '';
    },
  };

  return {
    register() {
      return vscode.workspace.registerTextDocumentContentProvider(scheme, provider);
    },
    setContent(uri, content) {
      const key = uri.toString();
      afterContentByUri.set(key, String(content ?? ''));
      if (afterContentByUri.size > MAX_ENTRIES) {
        const oldest = afterContentByUri.keys().next().value;
        if (oldest) afterContentByUri.delete(oldest);
      }
    },
    deleteByUri(uriOrString) {
      const key = typeof uriOrString === 'string' ? uriOrString : uriOrString?.toString?.();
      if (!key) return;
      afterContentByUri.delete(key);
    },
  };
}

module.exports = {
  createAfterContentProvider,
};
