/**
 * The deferred tools one request sends, searchable by exact name or by
 * keywords. Built per request from the tools block, so it follows every
 * change to the connected servers.
 */

import type {
  DeferredToolDefinition,
  ToolLoad,
  ToolLoadRequest,
} from '../llm-providers/llm-provider';

/** Tools a `query` loads. */
export const QUERY_LOAD_COUNT = 5;
/** Tools one call may load by name. */
export const MAX_NAMED_LOADS = 20;
const SUGGESTION_COUNT = 3;

/** BM25 constants, at their usual values. */
const K1 = 1.2;
const B = 0.75;

export function searchTokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

/** The name segment after the last `__`: the tool's own name on its server. */
export function bareToolName(name: string): string {
  const at = name.lastIndexOf('__');
  return at < 0 ? name : name.slice(at + 2);
}

interface Document {
  definition: DeferredToolDefinition;
  terms: Map<string, number>;
  length: number;
}

export class ToolIndex {
  private readonly byName = new Map<string, Document>();
  private readonly documents: Document[] = [];
  private readonly documentFrequency = new Map<string, number>();
  private readonly averageLength: number;

  constructor(definitions: readonly DeferredToolDefinition[]) {
    for (const definition of definitions) {
      // The name counts twice: it is the most specific text a tool has.
      const nameTokens = searchTokens(definition.name);
      const tokens = [...nameTokens, ...nameTokens, ...searchTokens(definition.description)];
      const terms = new Map<string, number>();
      for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1);
      for (const term of terms.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
      const document = { definition, terms, length: tokens.length };
      this.documents.push(document);
      this.byName.set(definition.name, document);
    }
    const total = this.documents.reduce((sum, document) => sum + document.length, 0);
    this.averageLength = this.documents.length > 0 ? total / this.documents.length : 1;
  }

  get size(): number {
    return this.documents.length;
  }

  definition(name: string): DeferredToolDefinition | undefined {
    return this.byName.get(name)?.definition;
  }

  /** The best matches for `query`, best first. */
  search(query: string, limit: number): string[] {
    const terms = [...new Set(searchTokens(query))];
    if (terms.length === 0) return [];
    const count = this.documents.length;
    const scored: Array<{ name: string; score: number }> = [];
    for (const document of this.documents) {
      let score = 0;
      for (const term of terms) {
        const frequency = document.terms.get(term);
        if (!frequency) continue;
        const documents = this.documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (count - documents + 0.5) / (documents + 0.5));
        const norm = K1 * (1 - B + (B * document.length) / this.averageLength);
        score += (idf * frequency * (K1 + 1)) / (frequency + norm);
      }
      if (score > 0) scored.push({ name: document.definition.name, score });
    }
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return scored.slice(0, limit).map((entry) => entry.name);
  }

  /**
   * The deferred tool a requested name means: the exact name, else a
   * case-insensitive match, else the one tool whose own name it is.
   */
  private resolve(requested: string): string | undefined {
    if (this.byName.has(requested)) return requested;
    const lower = requested.toLowerCase();
    const caseless = this.documents.filter((d) => d.definition.name.toLowerCase() === lower);
    if (caseless.length === 1) return caseless[0].definition.name;
    const bare = this.documents.filter((d) => bareToolName(d.definition.name).toLowerCase() === lower);
    return bare.length === 1 ? bare[0].definition.name : undefined;
  }

  load(request: ToolLoadRequest): ToolLoad {
    const loaded: string[] = [];
    const unmatched: string[] = [];
    const add = (name: string): void => {
      if (!loaded.includes(name)) loaded.push(name);
    };
    for (const requested of (request.names ?? []).slice(0, MAX_NAMED_LOADS)) {
      const name = this.resolve(requested.trim());
      if (name) add(name);
      else unmatched.push(requested);
    }
    const query = request.query?.trim();
    if (query) {
      const matches = this.search(query, QUERY_LOAD_COUNT);
      if (matches.length === 0) unmatched.push(query);
      for (const name of matches) add(name);
    }
    const suggestions =
      loaded.length > 0
        ? []
        : [...new Set(unmatched.flatMap((text) => this.search(text, SUGGESTION_COUNT)))].slice(
            0,
            SUGGESTION_COUNT,
          );
    return { loaded, unmatched, suggestions };
  }
}
