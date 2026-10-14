import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

const SCHEMA_DIR = path.join(__dirname, 'prisma', 'sqlite');

// A relative `file:` URL names a file in the schema's directory, the rule
// `src/lib/sqlite-path.ts` applies to the runtime's connections.
function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url?.startsWith('file:')) return url;
  const file = url.slice('file:'.length);
  if (file.startsWith(':') || path.isAbsolute(file)) return url;
  return `file:${path.resolve(SCHEMA_DIR, file)}`;
}

export default defineConfig({
  schema: path.join(SCHEMA_DIR, 'schema.prisma'),
  datasource: { url: databaseUrl() },
});
