import { nextFence, splitLines, type ParsedNote } from './parse';

export interface ChunkOptions {
  minChars: number;
  maxChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { minChars: 300, maxChars: 2000 };

export interface Chunk {
  ordinal: number;
  headingPath: string[];
  text: string;
  charStart: number;
  charEnd: number;
  tokenEstimate: number;
}

type Span = { start: number; end: number };
type Section = Span & { path: string[]; headingOnly: boolean };

// Narrow [start, end) to its trimmed text so raw.slice(start, end) === text.
function trimmed(raw: string, start: number, end: number): Span | null {
  const s = raw.slice(start, end);
  const t = s.trim();
  if (!t) return null;
  const lead = s.length - s.trimStart().length;
  return { start: start + lead, end: start + lead + t.length };
}

function sectionsOf(note: ParsedNote): Section[] {
  const { raw, headings } = note;
  const bounds = [
    { path: [] as string[], start: note.bodyStart, end: headings[0]?.charStart ?? raw.length, heading: null },
    ...headings.map((h, i) => ({
      path: [] as string[],
      start: h.charStart,
      end: headings[i + 1]?.charStart ?? raw.length,
      heading: h,
    })),
  ];

  const stack: { level: number; text: string }[] = [];
  const sections: Section[] = [];
  for (const b of bounds) {
    if (b.heading) {
      while (stack.length && stack[stack.length - 1].level >= b.heading.level) stack.pop();
      stack.push(b.heading);
      b.path = stack.map((s) => s.text);
    }
    const span = trimmed(raw, b.start, b.end);
    if (!span) continue;
    const headingOnly = !!b.heading && !trimmed(raw, b.heading.charEnd, span.end);
    sections.push({ ...span, path: b.path, headingOnly });
  }
  return sections;
}

// Paragraphs are runs of non-blank lines; blank lines inside a code fence do not end one.
function paragraphsOf(raw: string, span: Span): Span[] {
  const paras: Span[] = [];
  let open: Span | null = null;
  let fence: string | null = null;
  for (const line of splitLines(raw.slice(span.start, span.end))) {
    const blank = !line.text.trim();
    const wasInFence = fence !== null;
    fence = nextFence(fence, line.text);
    if (blank && !wasInFence) {
      open = null;
      continue;
    }
    const start = span.start + line.start;
    const end = span.start + line.end;
    if (open) open.end = end;
    else paras.push((open = { start, end }));
  }
  return paras;
}

function splitLong(raw: string, span: Span, maxChars: number): Span[] {
  const paras = paragraphsOf(raw, span);
  const pieces: Span[][] = [];
  let cur: Span[] = [];
  for (const p of paras) {
    if (cur.length && p.end - cur[0].start > maxChars) {
      pieces.push(cur);
      const overlap = cur[cur.length - 1];
      // ponytail: overlap is dropped when it would push the next piece over the limit
      cur = p.end - overlap.start > maxChars ? [p] : [overlap, p];
    } else {
      cur.push(p);
    }
  }
  if (cur.length) pieces.push(cur);
  return pieces.map((ps) => ({ start: ps[0].start, end: ps[ps.length - 1].end }));
}

export function chunkNote(note: ParsedNote, opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
  const { raw } = note;
  const all = sectionsOf(note);
  let secs = all.filter((s) => !s.headingOnly);
  if (!secs.length) secs = all.slice(0, 1); // a note with nothing else keeps its lone heading

  const parent = (s: Section) => s.path.slice(0, -1).join('\u0000');
  const merged: Section[] = [];
  for (let i = 0; i < secs.length; ) {
    let cur = secs[i++];
    while (
      raw.slice(cur.start, cur.end).length < opts.minChars &&
      i < secs.length &&
      parent(cur) === parent(secs[i])
    ) {
      // A short preamble has no path of its own, so the section it joins names the chunk.
      const next = secs[i++];
      cur = { ...cur, path: cur.path.length ? cur.path : next.path, end: next.end };
    }
    merged.push(cur);
  }

  const chunks: Chunk[] = [];
  for (const s of merged) {
    const pieces = s.end - s.start > opts.maxChars ? splitLong(raw, s, opts.maxChars) : [s];
    for (const piece of pieces) {
      const span = trimmed(raw, piece.start, piece.end);
      if (!span) continue;
      const text = raw.slice(span.start, span.end);
      chunks.push({
        ordinal: chunks.length,
        headingPath: s.path,
        text,
        charStart: span.start,
        charEnd: span.end,
        tokenEstimate: Math.ceil(text.length / 4),
      });
    }
  }
  return chunks;
}

export function embeddingText(title: string, chunk: Chunk): string {
  const path = chunk.headingPath[0] === title ? chunk.headingPath : [title, ...chunk.headingPath];
  return `search_document: ${path.join(' › ')}\n\n${chunk.text}`;
}
