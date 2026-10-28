import { expect, test } from 'vitest';
import { resolveLink } from '../../src/service/markdown/links';
import type { RawLink } from '../../src/service/markdown/parse';

const all = ['Topics/Photosynthesis.md', 'Topics/Chlorophyll.md', 'Home.md', 'a/Same.md', 'b/Same.md'];
const wl = (target: string): RawLink => ({ target, heading: null, alias: null, kind: 'wikilink' });
const md = (target: string): RawLink => ({ target, heading: null, alias: null, kind: 'markdown' });

test('exact path', () =>
  expect(resolveLink(wl('Topics/Chlorophyll'), 'Home.md', all)).toBe('Topics/Chlorophyll.md'));
test('basename, case-insensitive', () =>
  expect(resolveLink(wl('photosynthesis'), 'Home.md', all)).toBe('Topics/Photosynthesis.md'));
test('ambiguous basename stays unresolved', () =>
  expect(resolveLink(wl('Same'), 'Home.md', all)).toBeNull());
test('missing target stays unresolved', () =>
  expect(resolveLink(wl('Medical Research'), 'Home.md', all)).toBeNull());
test('relative markdown link', () =>
  expect(resolveLink(md('Chlorophyll.md'), 'Topics/Photosynthesis.md', all)).toBe(
    'Topics/Chlorophyll.md',
  ));
