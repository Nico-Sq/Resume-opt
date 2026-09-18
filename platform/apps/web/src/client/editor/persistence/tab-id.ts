const TAB_ID_KEY = 'resume-opt.editor.tab-id';

export function getOrCreateEditorTabId(storage: Storage): string {
  const existing = storage.getItem(TAB_ID_KEY);
  if (
    existing &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(existing)
  ) {
    return existing;
  }
  const tabId = crypto.randomUUID();
  storage.setItem(TAB_ID_KEY, tabId);
  return tabId;
}
