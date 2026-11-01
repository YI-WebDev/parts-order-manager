import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as limits from '../../src/shared/limits';

// 本体の上限値（limits.rs が正）と画面の写し（src/shared/limits.ts）が食い違わないことを確かめる。
const rust = new Map<string, number>();
for (const [, name = '', value = ''] of readFileSync('src-tauri/core/src/limits.rs', 'utf8').matchAll(/^pub const (\w+): \w+ = ([\d_]+);/gm)) rust.set(name, Number(value.replaceAll('_', '')));

const pairs: ReadonlyArray<readonly [keyof typeof limits, string]> = [
  ['TEXT_MAX_LENGTH', 'TEXT_MAX'], ['QUERY_MAX_LENGTH', 'QUERY_MAX'], ['LINE_ROWS', 'LINE_ROWS'], ['MAX_LINES', 'MAX_LINES'],
  ['SEARCH_PAGE_SIZE', 'SEARCH_PAGE_SIZE'], ['CATEGORY_PAGE_SIZE', 'CATEGORY_PAGE_SIZE'], ['INVOICE_LIST_PAGE_SIZE', 'LIST_PAGE_SIZE'],
];

it.each(pairs)('%s matches the core constant %s', (name, rustName) => {
  expect(rust.has(rustName)).toBe(true);
  expect(limits[name]).toBe(rust.get(rustName));
});

it('keeps the values the interface text depends on', () => {
  expect([limits.MAX_LINES, limits.LINE_ROWS, limits.SEARCH_PAGE_SIZE, limits.CATEGORY_PAGE_SIZE, limits.INVOICE_LIST_PAGE_SIZE, limits.SEARCH_DEBOUNCE_MS]).toEqual([500, 47, 25, 100, 20, 180]);
});
