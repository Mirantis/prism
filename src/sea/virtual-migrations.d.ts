// Provided at build time by the esbuild `virtual:migrations` plugin
// (scripts/build-sea.mjs), which inlines prisma/sqlite/migrations/*/migration.sql.
declare module 'virtual:migrations' {
  const migrations: { name: string; sql: string }[];
  export default migrations;
}
