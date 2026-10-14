/**
 * A web page's HTML as markdown: the page's main text when Readability finds it, else
 * the whole body. Links and images point at absolute addresses, so the agent can read
 * a linked page next.
 *
 * domino, the HTML5 parser turndown uses, builds the page's tree, so the text of a page
 * that leaves out the optional `<html>`, `<head>` or `<body>` tag is in the body.
 * Readability runs on a linkedom copy of that tree, because it iterates node lists that
 * domino cannot iterate. turndown converts on domino, which has the table API the table
 * rules need.
 */

import { createDocument } from '@mixmark-io/domino';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

/** A title longer than this is cut. */
export const MAX_TITLE_CHARS = 200;

export interface MarkdownPage {
  /** One line of at most `MAX_TITLE_CHARS` characters. */
  title: string;
  markdown: string;
  /** `readability` for the main text, `whole_page` for the body when Readability finds none. */
  extractor: 'readability' | 'whole_page';
}

export function htmlToMarkdown(html: string, pageUrl: string): MarkdownPage {
  const tree = createDocument(html);
  const base = baseUrl(tree.querySelector('base[href]')?.getAttribute('href'), pageUrl);
  const documentTitle = oneLine(tree.title);
  // A copy, since Readability changes the document it parses. Readability resolves every
  // link against the document's base, which the converter does within its budget, so the
  // copy has no `<base>`.
  const copy = parseHTML(tree.documentElement.outerHTML).document;
  for (const element of copy.querySelectorAll('base')) element.remove();
  const article = new Readability(copy).parse();

  if (article?.content && article.textContent?.trim()) {
    return {
      title: oneLine(article.title ?? '') || documentTitle,
      markdown: converter(base, pageUrl, html.length).turndown(article.content).trim(),
      extractor: 'readability',
    };
  }
  return {
    title: documentTitle,
    markdown: converter(base, pageUrl, html.length).turndown(tree.body.innerHTML).trim(),
    extractor: 'whole_page',
  };
}

/** A title from the page's metadata keeps its line breaks, so they are collapsed here. */
function oneLine(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
}

/** The page's own `<base href>`, resolved against its address, else the address. */
function baseUrl(href: string | null | undefined, pageUrl: string): string {
  if (!href) return pageUrl;
  return URL.canParse(href, pageUrl) ? new URL(href, pageUrl).href : pageUrl;
}

/** An href that starts with a scheme is absolute, so parsing it needs no base. */
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/** Elements whose content is code, styling or a picture, never text for a reader. */
const DROPPED_ELEMENTS = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas', 'object', 'embed']);

interface RuleNode {
  nodeName: string;
  getAttribute(name: string): string | null;
}

/** The part of turndown's node the rules read; the runtime builds without the DOM types. */
function element(node: unknown): RuleNode {
  return node as RuleNode;
}

function converter(base: string, pageUrl: string, addressBudget: number): TurndownService {
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  service.use(gfm);
  service.remove((node) => DROPPED_ELEMENTS.has(element(node).nodeName.toLowerCase()));
  const page = pageUrl.split('#')[0];

  // The addresses of links and images share one budget: the page's length in characters.
  // Each resolution pays for what it parses (the href, plus the base for a relative
  // href), or for its result when that is longer. So a long `<base href>` repeated in
  // every link cannot make the work or the result larger than the page. A link or image
  // that the budget cannot pay for keeps its text and loses its address.
  let budget = addressBudget;
  const resolve = (href: string | null): string | null => {
    const value = href?.trim();
    if (!value) return null;
    const relative = !SCHEME.test(value);
    const cost = relative ? base.length + value.length : value.length;
    if (cost > budget) return null;
    const url = relative ? URL.parse(value, base) : URL.parse(value);
    budget -= Math.max(cost, url?.href.length ?? 0);
    if (!url || budget < 0 || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
    return url.href;
  };

  // A link keeps its text and its address, resolved against the page's base. A link
  // with no text is dropped, and a link to a place on this page keeps only its text.
  service.addRule('link', {
    filter: 'a',
    replacement: (content, node) => {
      const text = content.trim();
      if (!text) return '';
      const href = resolve(element(node).getAttribute('href'));
      if (!href || href.split('#')[0] === page) return text;
      return `[${text}](${href})`;
    },
  });

  // An image keeps its alt text, and its address when that is http or https. An
  // image without alt text is dropped.
  service.addRule('image', {
    filter: 'img',
    replacement: (_content, node) => {
      const alt = (element(node).getAttribute('alt') ?? '').trim();
      if (!alt) return '';
      const src = resolve(element(node).getAttribute('src'));
      return src ? `![${alt}](${src})` : alt;
    },
  });
  return service;
}
