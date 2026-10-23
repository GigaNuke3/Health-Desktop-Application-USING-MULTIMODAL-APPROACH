import { expect, test } from 'vitest';
import { buildCsp } from '../../src/main/security';

test('production CSP is strict', () => {
  const csp = buildCsp(false);
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).not.toContain('unsafe-eval');
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
});

test('dev CSP allows only the Vite HMR socket and inline preamble', () => {
  const csp = buildCsp(true);
  expect(csp).toMatch(/connect-src 'self' ws:\/\/localhost:\*/);
  expect(csp).toMatch(/script-src 'self' 'unsafe-inline'/);
});