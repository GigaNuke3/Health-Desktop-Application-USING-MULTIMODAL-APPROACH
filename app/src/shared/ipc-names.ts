// No imports: the sandboxed preload bundles this file.
export const PUBLIC_METHODS = [
  'vault.choose',
  'vault.confirm',
  'vault.current',
  'vault.refresh',
  'library.list',
  'note.read',
  'note.reindex',
  'note.openInObsidian',
  'index.status',
  'index.retry',
  'index.cancel',
  'index.reembedAll',
  'chat.list',
  'chat.get',
  'chat.send',
  'chat.cancel',
  'chat.rename',
  'chat.delete',
  'chat.deleteAll',
  'settings.get',
  'settings.update',
  'ollama.test',
  'home.summary',
  'data.revealDb',
  'data.rebuildIndex',
] as const;

export type PublicMethod = (typeof PUBLIC_METHODS)[number];

export const EVENTS = ['index:progress', 'chat:delta', 'chat:done', 'service:status'] as const;

export type EventName = (typeof EVENTS)[number];
