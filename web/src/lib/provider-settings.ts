/**
 * The runtime reports each missing provider setting as display text: a bare
 * variable name (`OPENAI_API_KEY`), alternatives in one entry
 * (`AZURE_RESOURCE_NAME (or AZURE_FOUNDRY_BASE_URL)`), or a step that is not a
 * variable at all (`ChatGPT sign-in`). The Overview splits an entry into text
 * and variable-name parts so it can offer a copy button for every name.
 */
export type SettingPart = { kind: 'text'; text: string } | { kind: 'variable'; name: string };

/** Upper-case words joined by underscores — `AZURE_API_KEY`, not `ChatGPT` or `URL`. */
const VARIABLE_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

export function settingParts(setting: string): SettingPart[] {
  const parts: SettingPart[] = [];
  let last = 0;
  for (const match of setting.matchAll(VARIABLE_NAME)) {
    if (match.index > last) parts.push({ kind: 'text', text: setting.slice(last, match.index) });
    parts.push({ kind: 'variable', name: match[0] });
    last = match.index + match[0].length;
  }
  if (last < setting.length) parts.push({ kind: 'text', text: setting.slice(last) });
  return parts;
}

/** True when the entry names at least one environment variable. */
export function namesVariable(setting: string): boolean {
  return settingParts(setting).some((part) => part.kind === 'variable');
}
