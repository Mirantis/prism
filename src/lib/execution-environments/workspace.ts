/**
 * The single owner of the per-thread-vs-default workspace fallback: returns the
 * given thread workspace root when it's a non-empty path, otherwise the
 * environment's own root. Every shell-tool invocation resolves its cwd through
 * here, as do the attachment and share-file tools, so the fallback lives in
 * exactly one place and a relative path means the same file to all of them.
 */
import * as path from 'path';
import { getExecutionEnvironment } from './get-execution-environment';

export function resolveWorkspace(workspaceRoot?: string | null): string {
  const trimmed = workspaceRoot?.trim();
  return trimmed ? path.resolve(trimmed) : getExecutionEnvironment().workspaceRoot();
}
