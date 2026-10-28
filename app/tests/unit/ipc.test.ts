import { expect, test } from 'vitest';
import { inputSchemas, parseInput } from '../../src/shared/ipc';
import { PUBLIC_METHODS } from '../../src/shared/ipc-names';
import { toAppError } from '../../src/shared/result';

test('rejects unknown methods', () => {
  expect(() => parseInput('fs.readFile', {})).toThrow(
    expect.objectContaining({ code: 'UNKNOWN_METHOD' }),
  );
});

test('rejects extra fields, so no path can be smuggled in', () => {
  expect(() => parseInput('note.read', { noteId: 'a', path: '/etc/passwd' })).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' }),
  );
});

test('rejects empty and oversize chat text', () => {
  expect(() => parseInput('chat.send', { conversationId: null, text: '', mode: 'rag' })).toThrow();
  expect(() =>
    parseInput('chat.send', { conversationId: null, text: 'x'.repeat(8001), mode: 'rag' }),
  ).toThrow();
});

test('every public method has a schema', () => {
  for (const m of PUBLIC_METHODS) expect(inputSchemas[m]).toBeDefined();
});

test('toAppError hides non-app errors', () => {
  expect(toAppError(new Error('secret note text'))).toEqual({
    code: 'INTERNAL',
    message: 'Unexpected error',
  });
});
