/**
 * @fileoverview Framing helpers that render upstream-controlled free text as
 * clearly-delimited DATA in MCP `content[]` output. PubChem descriptions,
 * summaries, interaction statements, synonyms, and assay/GHS text are relayed
 * verbatim into the model's context; rendered as bare prose they blur the
 * boundary between server-authored instructions and retrieved data and can
 * inject markdown structure. These helpers keep that boundary explicit and
 * neutralize markdown-structure injection. `structuredContent` always carries
 * the raw value — this only shapes the human/LLM text-rendering surface.
 * @module mcp-server/tools/definitions/untrusted-text
 */

/**
 * Inline markdown delimiters an upstream value could use to break out of a
 * surrounding emphasis/code span (`**bold**`, `` `code` ``) or inject its own.
 * Deliberately narrow — ordinary chemistry punctuation (hyphens, parentheses,
 * brackets, commas, +/=/#) is left intact so legitimate names are not mangled.
 * Underscore is intentionally excluded: CommonMark treats intraword `_` as
 * literal, so it is a far weaker vector than `*`, and escaping it collides with
 * the format-parity linter's underscored sentinels.
 *
 * The backslash is in the class because escaping is not idempotent against one
 * the payload already carries: `\*` escaped to `\\*` reads as a literal
 * backslash followed by a LIVE `*`, re-arming the delimiter the escape was meant
 * to defuse. Escaping it to `\\` first keeps the following `\*` inert. It also
 * matters on its own — a SMILES stereo bond (`C/C=C\C`) ends a line with a
 * backslash, which CommonMark reads as a hard line break.
 */
const INLINE_MARKDOWN = /[\\`*~]/g;

/**
 * Frame a single upstream value for safe inline interpolation into `content[]`
 * markdown. Collapses embedded newlines (so the value cannot start a new
 * markdown block) and escapes emphasis / inline-code delimiters. Proportionate
 * by design: the goal is a data boundary, not heavy escaping.
 */
export function inlineData(value: string): string {
  return value
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(INLINE_MARKDOWN, '\\$&')
    .trim();
}

/**
 * Frame multi-line upstream prose as a markdown blockquote — an explicit
 * "quoted data" boundary distinct from server-authored instructions. Every
 * line (blank ones included) is prefixed with `>` so the payload cannot break
 * out of the quote; inline emphasis/code is escaped and a leading block marker
 * (heading, quote, bullet, ordered list) is defused so it cannot restructure
 * the surrounding document.
 */
export function quoteData(text: string): string {
  return text
    .split(/\r\n?|\n/)
    .map((rawLine) => {
      const line = rawLine
        .replace(INLINE_MARKDOWN, '\\$&')
        .replace(/^(\s*)([#>+-])/, '$1\\$2')
        .replace(/^(\s*\d{1,9})([.)])/, '$1\\$2');
      return line.trim().length > 0 ? `> ${line}` : '>';
    })
    .join('\n');
}

/**
 * Wrap raw upstream text in a fenced code block whose fence is guaranteed
 * longer than any backtick run inside the payload, so a stray ``` cannot close
 * the fence early and let following lines render as markdown. Preserves the
 * content verbatim (no character substitution) — used for raw V2000 SDF.
 */
export function fencedData(content: string, language = ''): string {
  const longestRun = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}
