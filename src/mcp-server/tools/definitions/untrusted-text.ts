/**
 * @fileoverview Renders text this server did not author — PubChem's upstream values and
 * caller-supplied echoes — into MCP `content[]` Markdown, so a CommonMark parse reads each value
 * back exactly as `structuredContent` carries it and no value opens a construct the server did
 * not write. The rendering follows what the reader does with the value:
 * - {@link literalData}: a value an agent may send back to a `pubchem_*` tool (an identifier
 *   echo, SMILES, InChI, InChIKey, formula, name, accession, xref ID) renders as a code literal,
 *   so the text a reader copies carries no escape. {@link copyBack} applies it to a value that
 *   may be a number.
 * - Other upstream text in running prose goes through the framework's `escapeMarkdownInline` at
 *   the call site.
 * - {@link quoteData} (alias {@link renderNotice}): multi-line prose, and a notice that echoes
 *   caller text, renders as one escaped blockquote marked as quoted data.
 *
 * {@link fencedData} holds a raw record verbatim and {@link clipEcho} bounds a caller echo.
 * `structuredContent` always carries the raw value; these shape only the text surface.
 * @module mcp-server/tools/definitions/untrusted-text
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/**
 * Render a value an agent may send back to a `pubchem_*` tool as a code literal that a
 * CommonMark parse reads back exactly, with no escape in the text a reader copies — the
 * rendering mcp-ts-core gives copy-back values in its enrichment trailer.
 *
 * A one-line value is a code span, delimited one backtick longer than its longest backtick run
 * and padded with a space when a backtick touches either end, or when the value starts and ends
 * with a space around other text; the empty string renders as nothing. A value holding a line
 * break is a fenced block on lines of its own — the result starts and ends with a line feed —
 * with CR and CRLF read as LF, so it belongs where a block may stand: not in a heading, a table
 * cell, or a list item unless the caller indents it. Linear in the value's length.
 */
export function literalData(value: string): string {
  if (/[\r\n]/.test(value)) return `\n${fencedData(value.replace(/\r\n?/g, '\n'))}\n`;
  if (value === '') return '';
  const fence = '`'.repeat(longestBacktickRun(value) + 1);
  const pad =
    value.startsWith('`') ||
    value.endsWith('`') ||
    (value.startsWith(' ') && value.endsWith(' ') && /[^ ]/.test(value))
      ? ' '
      : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

/**
 * A value an agent may send back to a `pubchem_*` tool, as it renders next to others of mixed
 * type: a string as {@link literalData}, anything else as itself (PubChem sends some numeric
 * properties as numbers and some as strings).
 */
export function copyBack(value: unknown): string {
  return typeof value === 'string' ? literalData(value) : String(value);
}

/** Longest caller-supplied value, in code points, echoed into a notice or error message. */
const MAX_ECHO_CHARS = 100;

/**
 * Cut a caller-supplied value for a notice or error message to
 * {@link MAX_ECHO_CHARS} code points (a cut value ends in `…`). The cut is
 * surface-neutral — `structuredContent` and `content[]` carry the same clipped
 * string, and the full value stays in its structured field. Nothing is escaped
 * here: the framework escapes error text when it renders `content[]`, and a
 * notice that echoes caller text escapes at render time through
 * {@link renderNotice}, so `structuredContent` keeps the value as written.
 */
export function clipEcho(value: string): string {
  const chars = Array.from(value);
  return chars.length > MAX_ECHO_CHARS ? `${chars.slice(0, MAX_ECHO_CHARS).join('')}…` : value;
}

/**
 * Frame upstream prose as a markdown blockquote — an explicit "quoted data" boundary distinct
 * from server-authored instructions — that a CommonMark parse reads back as one paragraph holding
 * exactly `text`, CR and CRLF read as LF. The text goes through `escapeMarkdownInline` whole, so
 * no line can open a heading (setext included), list, quote, code block, link, or emphasis, and
 * each line break is a hard break; every output line is then prefixed `> `. The escaper writes
 * edge whitespace as references and puts a hard-break backslash on every line it continues, so
 * no output line is blank or whitespace-only and the quote cannot end early; only the empty
 * string yields an empty line, rendered as a bare `>`.
 */
export function quoteData(text: string): string {
  return escapeMarkdownInline(text)
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * `enrichmentTrailer` renderer for a notice that echoes caller text: {@link quoteData}. The
 * default notice line is authored Markdown and stays live, so caller text in it could inject
 * structure; quoted, the notice reads back as `structuredContent` carries it.
 */
export const renderNotice = quoteData;

/**
 * Wrap raw upstream text in a fenced code block whose fence is guaranteed
 * longer than any backtick run inside the payload, so a stray ``` cannot close
 * the fence early and let following lines render as markdown. Preserves the
 * content verbatim (no character substitution) — used for raw V2000 SDF and
 * for a multi-line {@link literalData}.
 */
export function fencedData(content: string): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `${fence}\n${content}\n${fence}`;
}

/** The length of the longest backtick run in `text`; 0 when it holds none. Iterated, not
 * collected into one call's arguments: a text of mostly backticks holds as many runs as
 * characters, past what a call can take. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const [run] of text.matchAll(/`+/g)) longest = Math.max(longest, run.length);
  return longest;
}
