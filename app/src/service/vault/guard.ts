import fs from 'node:fs/promises';
import path from 'node:path';
import { AppException } from '../../shared/result';

export const DEFAULT_IGNORES = ['.obsidian/**', '.trash/**', '.boost/**'];

export type VaultGuard = {
  root: string;
  isIgnored(relPath: string): boolean;
  resolve(relPath: string): Promise<string>;
};

export function createVaultGuard(root: string, ignorePatterns: string[]): VaultGuard {
  // relPath is POSIX-style. 'dir/**' also matches 'dir' itself.
  const isIgnored = (relPath: string) =>
    ignorePatterns.some(
      (p) => path.matchesGlob(relPath, p) || (p.endsWith('/**') && relPath === p.slice(0, -3)),
    );

  const outside = () => new AppException('PATH_OUTSIDE_VAULT', 'Path is outside the vault');

  // Judge the lexical path first so a probe like '../../etc/shadow' never reaches the filesystem.
  const isInside = (base: string, target: string) => {
    const rel = path.relative(base, target);
    return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  };

  async function resolve(relPath: string): Promise<string> {
    const realRoot = await fs.realpath(root);
    const lexical = path.resolve(realRoot, relPath);
    if (!isInside(realRoot, lexical)) throw outside();

    let real: string;
    try {
      real = await fs.realpath(lexical);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new AppException('NOT_FOUND', 'Note file not found');
      }
      throw e;
    }
    // Following symlinks may have left the vault.
    if (!isInside(realRoot, real)) throw outside();

    if (isIgnored(path.relative(realRoot, real).split(path.sep).join('/'))) {
      throw new AppException('PATH_IGNORED', 'Path is excluded from the vault');
    }
    return real;
  }

  return { root, isIgnored, resolve };
}
