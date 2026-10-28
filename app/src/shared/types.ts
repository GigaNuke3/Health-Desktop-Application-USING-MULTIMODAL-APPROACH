export type IndexStatus = 'pending' | 'indexed' | 'failed' | 'deleted' | 'excluded';

export interface Workspace {
  id: number;
  name: string;
  vaultRoot: string;
  ignorePatterns: string[];
  answerGuidelines: string;
}

export interface VaultPreview {
  path: string;
  mdCount: number;
}

export interface NoteSummary {
  id: string;
  relPath: string;
  title: string;
  mtime: number;
  tags: string[];
  type: string | null;
  status: IndexStatus;
}

export interface LibraryFilter {
  query?: string;
  folder?: string;
  tag?: string;
  type?: string;
  status?: IndexStatus;
  sort: 'modified-desc' | 'title-asc';
}

export interface NoteLink {
  targetText: string;
  targetNoteId: string | null;
  kind: 'wikilink' | 'embed' | 'markdown';
}

export interface NoteChunk {
  headingPath: string[];
  charStart: number;
  charEnd: number;
}

export interface NoteDetail extends NoteSummary {
  content: string;
  frontmatter: Record<string, unknown>;
  error: string | null;
  links: NoteLink[];
  chunks: NoteChunk[];
}

export interface IndexProgress {
  queued: number;
  running: number;
  done: number;
  failed: number;
  current: string | null;
  paused: null | 'ollama-unreachable' | 'model-mismatch' | 'cancelled' | 'no-vault';
}

export interface Settings {
  ollamaEndpoint: string;
  chatModel: string;
  embeddingModel: string;
  temperature: number;
  maxDistance: number;
}

export interface ModelInfo {
  name: string;
  digest: string;
  capabilities: string[];
}

export interface CitationView {
  marker: string;
  rank: number;
  score: number;
  cited: boolean;
  chunkId: number | null;
  noteId: string;
  noteRelPath: string;
  noteTitle: string;
  headingPath: string[];
  snapshotText: string;
  charStart: number | null;
  charEnd: number | null;
  noteStatus: string;
}

export interface MessageView {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  mode: 'rag' | 'general';
  status: 'complete' | 'cancelled' | 'error' | 'no_match';
  model: string | null;
  createdAt: string;
  citations: CitationView[];
  unknownMarkers: string[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export type ConversationDetail = ConversationSummary & { messages: MessageView[] };

export interface HomeSummary {
  workspace: Workspace;
  counts: { indexed: number; pending: number; failed: number; total: number };
  recentNotes: NoteSummary[];
  recentConversations: ConversationSummary[];
}
