import { expect, test } from 'vitest';
import { chunkNote, embeddingText, type Chunk } from '../../src/service/markdown/chunk';
import { parseNote } from '../../src/service/markdown/parse';

const P = (md: string) => parseNote(md, 'T.md');

test('one chunk per section, with heading path', () => {
  const md = `# T\n\n## A\n${'a'.repeat(400)}\n\n## B\n${'b'.repeat(400)}\n`;
  expect(chunkNote(P(md)).map((c) => c.headingPath)).toEqual([
    ['T', 'A'],
    ['T', 'B'],
  ]);
});

test('offsets slice the source', () => {
  const raw = ['---', 'title: W', '---', '# Heading One', '', 'Intro text.', '', '## Second', 'Body', ''].join(
    '\r\n',
  );
  const n = P(raw);
  const cs = chunkNote(n);
  expect(cs.length).toBeGreaterThan(0);
  for (const c of cs) expect(n.raw.slice(c.charStart, c.charEnd)).toBe(c.text);
});

test('short sibling sections merge forward', () => {
  const md = `# T\n## A\nshort a\n## B\nshort b\n## C\n${'c'.repeat(400)}\n`;
  const cs = chunkNote(P(md));
  expect(cs).toHaveLength(1);
  expect(cs[0].headingPath).toEqual(['T', 'A']);
  expect(cs[0].text).toContain('## C');
});

test('short section does not merge across parents', () => {
  const md = `# T\n## A\n### A1\nshort\n## B\n${'b'.repeat(400)}\n`;
  expect(chunkNote(P(md)).map((c) => c.headingPath)).toEqual([
    ['T', 'A', 'A1'],
    ['T', 'B'],
  ]);
});

test('long section splits on paragraphs with one-paragraph overlap', () => {
  const paras = Array.from({ length: 6 }, (_, i) => String(i).repeat(600));
  const n = P(`# T\n${paras.join('\n\n')}\n`);
  const cs = chunkNote(n);
  expect(cs.length).toBeGreaterThan(1);
  for (const c of cs) {
    expect(c.text.length).toBeLessThanOrEqual(2000 + 50);
    expect(n.raw.slice(c.charStart, c.charEnd)).toBe(c.text);
  }
  expect(cs[1].text.startsWith(cs[0].text.split('\n\n').at(-1)!)).toBe(true);
});

test('CRLF paragraphs split and offsets still hold', () => {
  const paras = Array.from({ length: 6 }, (_, i) => String(i).repeat(600));
  const n = P(`# T\r\n${paras.join('\r\n\r\n')}\r\n`);
  const cs = chunkNote(n);
  expect(cs.length).toBeGreaterThan(1);
  for (const c of cs) expect(n.raw.slice(c.charStart, c.charEnd)).toBe(c.text);
});

test('never splits inside a code fence', () => {
  const fence = '```\n' + Array.from({ length: 40 }, () => 'x'.repeat(60)).join('\n\n') + '\n```';
  expect(chunkNote(P(`# T\n${fence}\n`)).some((c) => c.text.includes(fence))).toBe(true);
});

test('empty, frontmatter-only, no-heading notes', () => {
  expect(chunkNote(P(''))).toEqual([]);
  expect(chunkNote(P('---\ntitle: x\n---\n'))).toEqual([]);
  const cs = chunkNote(P('just a line'));
  expect(cs).toHaveLength(1);
  expect(cs[0].headingPath).toEqual([]);
  for (const c of cs) expect(c.text.trim()).not.toBe('');
});

test('embeddingText header', () => {
  expect(
    embeddingText('HbA1c (A1C)', {
      headingPath: ['HbA1c (A1C)', 'Limitations'],
      text: 'x',
    } as Chunk),
  ).toBe('search_document: HbA1c (A1C) › Limitations\n\nx');
});
