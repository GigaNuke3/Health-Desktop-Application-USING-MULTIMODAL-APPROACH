import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parseNote } from '../../src/service/markdown/parse';

const read = (rel: string) =>
  fs.readFileSync(path.join(import.meta.dirname, '../fixtures/vault', rel), 'utf8');

test('frontmatter, title, tags', () => {
  const p = parseNote(read('Topics/Photosynthesis.md'), 'Photosynthesis.md');
  expect(p.frontmatter).toMatchObject({ type: 'concept', status: 'draft' });
  expect(p.title).toBe('Photosynthesis');
  expect(p.tags).toEqual(['science/biology', 'plants']); // one frontmatter tag, one inline
});

test('broken YAML keeps the body', () => {
  const p = parseNote(read('Broken Frontmatter.md'), 'Broken Frontmatter.md');
  expect(p.frontmatter).toBeNull();
  expect(p.frontmatterError).toMatch(/./);
  expect(p.headings.length).toBeGreaterThan(0);
});

test('all link forms', () => {
  const raw = '[[A]] [[B|bee]] [[C#Sec]] ![[d.png]] [e](sub/E.md) [web](https://x.org/a.md)';
  expect(parseNote(raw, 'x.md').links).toEqual([
    { target: 'A', heading: null, alias: null, kind: 'wikilink' },
    { target: 'B', heading: null, alias: 'bee', kind: 'wikilink' },
    { target: 'C', heading: 'Sec', alias: null, kind: 'wikilink' },
    { target: 'd.png', heading: null, alias: null, kind: 'embed' },
    { target: 'sub/E.md', heading: null, alias: null, kind: 'markdown' },
  ]);
});

test('code fences hide headings and links', () => {
  const p = parseNote(read('Code Sample.md'), 'Code Sample.md');
  expect(p.headings.map((h) => h.text)).toEqual(['Code Sample', 'After']);
  expect(p.links.map((l) => l.target)).toEqual(['Photosynthesis']);
});

test('CRLF offsets slice the raw text exactly', () => {
  const raw = ['---', 'title: Windows', '---', '# Heading One', '', 'Text', '## Second', ''].join(
    '\r\n',
  );
  const p = parseNote(raw, 'CRLF Note.md');
  expect(p.headings).toHaveLength(2);
  for (const h of p.headings) {
    expect(raw.slice(h.charStart, h.charEnd)).toBe('#'.repeat(h.level) + ' ' + h.text);
  }
});

test('non-ASCII headings and title', () => {
  const p = parseNote(read('Unicode Café ☕.md'), 'Unicode Café ☕.md');
  expect(p.title).toBe('Unicode Café ☕');
  expect(p.headings[1].text).toBe('Résumé › détails');
});

test('empty file', () =>
  expect(parseNote('', 'Empty.md')).toMatchObject({
    title: 'Empty',
    headings: [],
    links: [],
    frontmatter: null,
  }));

test('frontmatter-only and heading-less notes parse', () => {
  const meta = parseNote(read('Only Frontmatter.md'), 'Only Frontmatter.md');
  expect(meta).toMatchObject({ title: 'Just Meta', headings: [], links: [] });
  expect(meta.bodyStart).toBe(meta.raw.length);
  const plain = parseNote(read('No Headings.md'), 'No Headings.md');
  expect(plain).toMatchObject({ title: 'No Headings', headings: [], frontmatter: null });
});
