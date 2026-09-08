import './lib/environment';
import pino from 'pino';
import { serializeError } from './lib/log-redaction';

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info');

const transport =
  process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined;

// The `err` serializer is not optional and has no off switch: pino's default copies
// every own property of an error, and the AI SDK hangs the request body and the
// response body off its errors. See lib/log-redaction.ts.
export const logger = pino({
  level,
  serializers: { err: serializeError },
  ...(transport ? { transport } : {}),
});
