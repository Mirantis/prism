import pino from 'pino';

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info');

const transport =
  process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined;

export const logger = pino({ level, ...(transport ? { transport } : {}) });
