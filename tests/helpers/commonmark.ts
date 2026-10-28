/**
 * @fileoverview Reads `content[]` Markdown back through a real CommonMark parser
 * (`markdown-it`, GFM preset), so a test asserts what a client renders rather
 * than which escapes or code spans the framework wrote.
 * @module tests/helpers/commonmark
 */
import MarkdownIt, { type Token } from 'markdown-it';

const parser = new MarkdownIt('default');

/**
 * The text an inline run reads as, line breaks as `\n`, with every node that is
 * not plain text named in place (`⟨strong⟩…⟨/strong⟩`, `⟨code_inline:x⟩`), so an
 * expectation written as plain text fails on any live syntax.
 */
function readInline(children: Token[]): string {
  let out = '';
  for (const token of children) {
    if (token.type === 'text' || token.type === 'text_special') out += token.content;
    else if (token.type === 'softbreak' || token.type === 'hardbreak') out += '\n';
    else if (token.nesting === 1) out += `⟨${token.tag}⟩`;
    else if (token.nesting === -1) out += `⟨/${token.tag}⟩`;
    else out += `⟨${token.type}:${token.content}⟩`;
  }
  return out;
}

/**
 * The text a CommonMark parse of `markdown` reads as: each inline run's text
 * (line breaks as `\n`), joined by a blank line, with every other block named in
 * place (`⟨blockquote_open⟩`, `⟨heading_open⟩`) and a code block read as
 * `⟨fence:…⟩`. An error's `content[]` text contains its message as written.
 */
export function readCommonMark(markdown: string): string {
  const parts: string[] = [];
  for (const token of parser.parse(markdown, {})) {
    if (token.type === 'inline') parts.push(readInline(token.children ?? []));
    else if (token.type === 'fence' || token.type === 'code_block') {
      parts.push(`⟨${token.type}:${token.content.replace(/\n$/, '')}⟩`);
    } else if (token.type !== 'paragraph_open' && token.type !== 'paragraph_close') {
      parts.push(`⟨${token.type}⟩`);
    }
  }
  return parts.join('\n\n');
}

/**
 * The text of each top-level block quote in `markdown`, in document order — a
 * notice trailer line reads back as the notice string `structuredContent`
 * carries. Paragraphs inside one quote join with a blank line.
 */
export function readBlockquotes(markdown: string): string[] {
  const quotes: string[] = [];
  let depth = 0;
  let parts: string[] = [];
  for (const token of parser.parse(markdown, {})) {
    if (token.type === 'blockquote_open') {
      if (depth === 0) parts = [];
      depth++;
    } else if (token.type === 'blockquote_close') {
      depth--;
      if (depth === 0) quotes.push(parts.join('\n\n'));
    } else if (depth > 0 && token.type === 'inline') {
      parts.push(readInline(token.children ?? []));
    }
  }
  return quotes;
}

/**
 * The value an enrichment trailer line `**key:** value` reads back as: the
 * inline content after the label (a code span reads as its content), or the
 * fenced block that follows a bare label when the value holds a line break.
 * `undefined` when no such line exists.
 */
export function readTrailerValue(markdown: string, key: string): string | undefined {
  const tokens = parser.parse(markdown, {});
  for (const [i, token] of tokens.entries()) {
    if (token.type !== 'inline') continue;
    const children = token.children ?? [];
    for (const [j, child] of children.entries()) {
      const isLabel =
        child.type === 'strong_open' &&
        children[j + 1]?.content === `${key}:` &&
        children[j + 2]?.type === 'strong_close';
      if (!isLabel) continue;
      const rest = children.slice(j + 3);
      const end = rest.findIndex((c) => c.type === 'softbreak' || c.type === 'hardbreak');
      const value = readInline(end === -1 ? rest : rest.slice(0, end)).replace(/^ /, '');
      if (value !== '') return value.replace(/^⟨code_inline:([\s\S]*)⟩$/, '$1');
      const next = tokens[i + 2];
      return next?.type === 'fence' ? next.content.replace(/\n$/, '') : '';
    }
  }
  return;
}
