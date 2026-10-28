import path from 'node:path';
import type { RawLink } from './parse';

// Returns the relative path of the target note, or null when it is missing or ambiguous.
export function resolveLink(
  link: RawLink,
  sourceRelPath: string,
  allRelPaths: string[],
): string | null {
  const target = /\.md$/i.test(link.target) ? link.target : `${link.target}.md`;
  const known = new Set(allRelPaths);

  if (known.has(target)) return target;
  if (link.kind === 'markdown') {
    const relative = path.posix.join(path.posix.dirname(sourceRelPath), target);
    if (known.has(relative)) return relative;
  }

  const base = path.posix.basename(target).toLowerCase();
  const matches = allRelPaths.filter((p) => path.posix.basename(p).toLowerCase() === base);
  return matches.length === 1 ? matches[0] : null;
}
