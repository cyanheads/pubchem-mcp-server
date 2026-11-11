/**
 * @fileoverview Fixtures and assertions shared by the tests that read a tool's `content[]` back
 * through CommonMark and compare it with the value `structuredContent` carries (#88).
 * @module tests/helpers/read-back
 */
import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect } from 'vitest';
import { readCommonMark } from './commonmark.js';

/**
 * Values a CommonMark parse is liable to read as something else: edge spaces, each line-break
 * form, entity text, raw HTML, backticks, a trailing backslash, a SMILES bracket atom, and
 * inline and block constructs (#88).
 */
export const READ_BACK_FUZZ: [string, string][] = [
  ['edge spaces', '  padded  '],
  ['LF', 'acetyl\nsalicylic acid'],
  ['CRLF', 'a\r\nb'],
  ['entity text', '&amp; &#42; &lt;'],
  ['raw HTML', '<b>x</b>'],
  ['backticks', 'drop `code` here'],
  ['trailing backslash', 'abc\\'],
  ['SMILES bracket atom', 'C[C@@H](C(=O)O)N'],
  ['underscore emphasis', '_x_'],
  ['link', '[l](https://x.test)'],
  ['setext heading', 'x\n==='],
  ['ATX heading', 'x\n# INJECTED'],
];

/** {@link READ_BACK_FUZZ} without the values that hold a line break. */
export const ONE_LINE_FUZZ = READ_BACK_FUZZ.filter(([, value]) => !/[\r\n]/.test(value));

/** A value as a CommonMark parse reads it back: CR and CRLF arrive as LF. */
export const asReadBack = (value: string) => value.replace(/\r\n?/g, '\n');

/** A code literal as a CommonMark parse reads it: a code span, or a fenced block once the value
 * holds a line break. */
export const literalRead = (value: string) =>
  /[\r\n]/.test(value) ? `⟨fence:${asReadBack(value)}⟩` : `⟨code_inline:${value}⟩`;

/** The format block of a tool result: `content[0]`, which the enrichment trailer follows. */
export const formatBlock = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  (result.content[0] as { type: 'text'; text: string }).text;

/**
 * Asserts that `render` puts `value` into the format block as a code literal a CommonMark parse
 * reads back as `expected` — the value structuredContent carries — adding no construct: the parse
 * equals the parse of the same call made with a placeholder of the same shape (one line, or two),
 * each placeholder literal swapped for `expected`'s. With `allowEscapedText`, a placeholder may
 * instead read as escaped text, swapped for `expected` as plain text.
 */
export async function expectReadBack(
  render: (value: string) => Promise<string>,
  value: string,
  { allowEscapedText = false, expected = value } = {},
) {
  const placeholder = /[\r\n]/.test(value) ? 'PLACE\nHOLDER' : 'PLACEHOLDER';
  const baseline = readCommonMark(await render(placeholder));
  expect(baseline).toContain(allowEscapedText ? placeholder : literalRead(placeholder));
  let swapped = baseline.split(literalRead(placeholder)).join(literalRead(expected));
  if (allowEscapedText) swapped = swapped.split(placeholder).join(asReadBack(expected));
  expect(readCommonMark(await render(value))).toBe(swapped);
}
