import { parse as parseYaml } from 'yaml';

export type LinkKind = 'wikilink' | 'embed' | 'markdown';

export interface RawLink {
  target: string;
  heading: string | null;
  alias: string | null;
  kind: LinkKind;
}

export interface Heading {
  level: number;
  text: string;
  charStart: number;
  charEnd: number;
}

export interface ParsedNote {
  title: string;
  frontmatter: Record<string, unknown> | null;
  frontmatterError: string | null;
  bodyStart: number;
  tags: string[];
  headings: Heading[];
  links: RawLink[];
  raw: string;
}

type Line = { text: string; start: number; end: number };

// Offsets index `raw`, so \r\n counts as two characters.
function splitLines(raw: string): Line[] {
  const lines: Line[] = [];
  const eol = /\r\n|\n|\r/g;
  let start = 0;
  for (let m = eol.exec(raw); m; m = eol.exec(raw)) {
    lines.push({ text: raw.slice(start, m.index), start, end: m.index });
    start = m.index + m[0].length;
  }
  if (start < raw.length) lines.push({ text: raw.slice(start), start, end: raw.length });
  return lines;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;
const INLINE_TAG = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu;
// One pass so links come out in document order: [[x]] / ![[x]] / [t](x.md).
const LINK =
  /(!?)\[\[([^\]\n]+?)\]\]|(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function splitFrontmatter(raw: string, lines: Line[]) {
  const none = { frontmatter: null, error: null, bodyLine: 0, bodyStart: 0 };
  if (lines[0]?.text !== '---' || lines[0].end === raw.length) return none;
  const close = lines.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(l.text));
  if (close < 0) return none;

  const bodyLine = close + 1;
  const bodyStart = lines[bodyLine]?.start ?? raw.length;
  try {
    const value = parseYaml(raw.slice(lines[1].start, lines[close].start));
    if (value == null) return { ...none, frontmatter: {}, bodyLine, bodyStart };
    if (typeof value !== 'object' || Array.isArray(value)) {
      return { ...none, error: 'frontmatter must be a mapping', bodyLine, bodyStart };
    }
    return { ...none, frontmatter: value as Record<string, unknown>, bodyLine, bodyStart };
  } catch (e) {
    // First line only: yaml's full message quotes the note text.
    return { ...none, error: (e as Error).message.split('\n')[0], bodyLine, bodyStart };
  }
}

function frontmatterTags(fm: Record<string, unknown> | null): string[] {
  const t = fm?.tags;
  const list = Array.isArray(t) ? t : typeof t === 'string' ? t.split(/[\s,]+/) : [];
  return list
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.replace(/^#/, '').trim())
    .filter(Boolean);
}

function linksIn(text: string): RawLink[] {
  const links: RawLink[] = [];
  for (const m of text.matchAll(LINK)) {
    if (m[2] !== undefined) {
      const [left, alias] = m[2].split(/\|(.*)/s);
      const [target, heading] = left.split(/#(.*)/s);
      if (!target.trim()) continue;
      links.push({
        target: target.trim(),
        heading: heading?.trim() || null,
        alias: alias?.trim() || null,
        kind: m[1] ? 'embed' : 'wikilink',
      });
    } else if (!m[3]) {
      let [target, heading] = m[4].split(/#(.*)/s);
      try {
        target = decodeURIComponent(target);
      } catch {
        // keep the target as written
      }
      if (HAS_SCHEME.test(target) || !target.toLowerCase().endsWith('.md')) continue;
      links.push({ target, heading: heading || null, alias: null, kind: 'markdown' });
    }
  }
  return links;
}

export function parseNote(raw: string, fileName: string): ParsedNote {
  const lines = splitLines(raw);
  const fm = splitFrontmatter(raw, lines);

  const headings: Heading[] = [];
  const links: RawLink[] = [];
  const inlineTags: string[] = [];
  let fence: string | null = null;

  for (const line of lines.slice(fm.bodyLine)) {
    const f = FENCE.exec(line.text);
    if (fence) {
      // Closes on the same character, at least as long, nothing else on the line.
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.text.replace(FENCE, '').trim()) {
        fence = null;
      }
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }

    const h = HEADING.exec(line.text);
    if (h) {
      headings.push({ level: h[1].length, text: h[2], charStart: line.start, charEnd: line.end });
    }
    // Blank out inline code, keeping positions, so its contents are never read as syntax.
    const text = line.text.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length));
    links.push(...linksIn(text));
    for (const m of text.matchAll(INLINE_TAG)) {
      if (!/^\p{N}+$/u.test(m[1])) inlineTags.push(m[1]);
    }
  }

  const fmTitle = fm.frontmatter?.title;
  const title =
    (typeof fmTitle === 'string' && fmTitle.trim()) ||
    headings.find((h) => h.level === 1)?.text ||
    fileName.replace(/\.md$/i, '');

  return {
    title,
    frontmatter: fm.frontmatter,
    frontmatterError: fm.error,
    bodyStart: fm.bodyStart,
    tags: [...new Set([...frontmatterTags(fm.frontmatter), ...inlineTags])],
    headings,
    links,
    raw,
  };
}
