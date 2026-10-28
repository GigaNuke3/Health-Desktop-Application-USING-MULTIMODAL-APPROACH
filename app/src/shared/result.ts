export type ErrorCode =
  | 'INVALID_INPUT'
  | 'UNKNOWN_METHOD'
  | 'VAULT_NOT_FOUND'
  | 'NO_VAULT'
  | 'PATH_OUTSIDE_VAULT'
  | 'PATH_IGNORED'
  | 'NOT_FOUND'
  | 'OLLAMA_UNREACHABLE'
  | 'MODEL_NOT_FOUND'
  | 'TIMEOUT'
  | 'DIMENSION_MISMATCH'
  | 'EMBEDDING_MODEL_MISMATCH'
  | 'DB_NEWER_THAN_APP'
  | 'CANCELLED'
  | 'INTERNAL';

export interface AppError {
  code: ErrorCode;
  message: string;
  hint?: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };

export class AppException extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'AppException';
  }
}

export function toAppError(e: unknown): AppError {
  if (e instanceof AppException) {
    return e.hint === undefined
      ? { code: e.code, message: e.message }
      : { code: e.code, message: e.message, hint: e.hint };
  }
  return { code: 'INTERNAL', message: 'Unexpected error' };
}
