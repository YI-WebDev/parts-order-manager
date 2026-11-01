import { expect, it } from 'vitest';
import { clampOffset, findCategory, visibleCategories } from '../../src/renderer/useCategoryPage';

const page = [{ id: 'a', name: '架空配管' }, { id: 'b', name: '架空電材' }];
const outside = { id: 'z', name: '架空分類0300' };

// カテゴリ候補は100件ずつ表示する。選択中のカテゴリが今のページ・検索結果になくても、表示から消さず別のカテゴリへ変えない。
it('keeps the selected category visible when it is outside the current candidate page', () => {
  expect(visibleCategories(page, outside)).toEqual({ pinned: outside, rows: page });
  expect(visibleCategories(page, page[1] ?? null)).toEqual({ pinned: null, rows: page });
  expect(visibleCategories(page, null)).toEqual({ pinned: null, rows: page });
  expect(visibleCategories([], outside)).toEqual({ pinned: outside, rows: [] });
});

it('resolves a chosen id from the current page first and otherwise only from the kept selection', () => {
  expect(findCategory('b', page, outside)).toBe(page[1]);
  expect(findCategory('z', page, outside)).toBe(outside);
  expect(findCategory('unknown', page, outside)).toBeNull();
  expect(findCategory(null, page, outside)).toBeNull();
});

// 範囲外のページ（例: 1件の検索結果に開始位置100）を表示せず、最後の有効なページへ戻す。
it('moves an out-of-range page offset back to the last page that has candidates', () => {
  expect(clampOffset(100, 1)).toBe(0);
  expect(clampOffset(100, 0)).toBe(0);
  expect(clampOffset(300, 257)).toBe(200);
  expect(clampOffset(200, 200)).toBe(100);
  expect(clampOffset(100, 257)).toBe(100);
  expect(clampOffset(0, 0)).toBe(0);
});
