export class ApiError extends Error {
  fieldErrors: Record<string, string>;
  /** The HTTP status the runtime answered, so a caller can tell 409 from 500. */
  status: number;
  /** The parsed JSON the runtime answered with, for a refusal that returns data. */
  body: unknown;

  constructor(message: string, fieldErrors: Record<string, string> = {}, status = 0, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.fieldErrors = fieldErrors;
    this.status = status;
    this.body = body;
  }
}
