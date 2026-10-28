import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createVaultGuard, DEFAULT_IGNORES, type VaultGuard } from '../../src/service/vault/guard';

let tmp: string;
let root: string;
let realRoot: string;
let guard: VaultGuard;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-'));
  root = path.join(tmp, 'vault');
  await fs.cp(path.join(import.meta.dirname, '../fixtures/vault'), root, { recursive: true });
  await fs.writeFile(path.join(tmp, 'outside.md'), '# outside');
  await fs.symlink(path.join(tmp, 'outside.md'), path.join(root, 'escape.md'));
  await fs.mkdir(path.join(tmp, 'vault-evil'));
  await fs.writeFile(path.join(tmp, 'vault-evil', 'a.md'), '# evil');
  realRoot = await fs.realpath(root);
  guard = createVaultGuard(root, DEFAULT_IGNORES);
});

afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

test('resolves a normal note', async () =>
  expect(await guard.resolve('Home.md')).toBe(path.join(realRoot, 'Home.md')));

test('refuses ..', () =>
  expect(guard.resolve('../outside.md')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_VAULT' }));

test('refuses absolute paths', () =>
  expect(guard.resolve('/etc/passwd')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_VAULT' }));

test('refuses a symlink that escapes', () =>
  expect(guard.resolve('escape.md')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_VAULT' }));

test('refuses ignored folders', () =>
  expect(guard.resolve('.obsidian/app.json')).rejects.toMatchObject({ code: 'PATH_IGNORED' }));

test('custom patterns', () =>
  expect(createVaultGuard(root, ['reports/**']).isIgnored('reports/a.md')).toBe(true));

test('dir/** also matches the directory itself, but not normal notes', () => {
  expect(guard.isIgnored('.obsidian')).toBe(true);
  expect(guard.isIgnored('Home.md')).toBe(false);
});

test('a sibling folder sharing the prefix is outside', () =>
  expect(guard.resolve('../vault-evil/a.md')).rejects.toMatchObject({
    code: 'PATH_OUTSIDE_VAULT',
  }));

test('a missing file inside the vault is NOT_FOUND', () =>
  expect(guard.resolve('nope.md')).rejects.toMatchObject({ code: 'NOT_FOUND' }));
