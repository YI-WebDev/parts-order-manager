import { expect, it } from 'vitest';
import { filtered, noMaterialsMessage } from '../../src/renderer/empty-messages';

const FILTERED = '該当する材料はありません。キーワードやカテゴリを変更してください。';
const base = { query: '', categoryId: null, includeInactive: false } as const;

it('asks to change the conditions only when a keyword or a category narrows the search', () => {
  for (const where of ['ledger', 'palette'] as const) {
    expect(noMaterialsMessage({ ...base, query: '架空' }, where)).toBe(FILTERED);
    expect(noMaterialsMessage({ ...base, categoryId: '00000000-0000-4000-8000-000000000000' }, where)).toBe(FILTERED);
    expect(noMaterialsMessage({ ...base, query: ' 架 ', includeInactive: true }, where)).toBe(FILTERED);
  }
});

it('treats a keyword of spaces alone (half- or full-width) as no keyword, as the app does when it searches', () => {
  for (const query of [' ', '　', ' 　\t']) {
    expect(filtered({ ...base, query })).toBe(false);
    expect(noMaterialsMessage({ ...base, query }, 'palette')).not.toBe(FILTERED);
  }
});

it('explains how to register materials when nothing narrows the search', () => {
  expect(noMaterialsMessage(base, 'palette')).toBe('検索できる材料がありません。「材料」タブの「Excelから取込」または「手動で追加」から登録してください。');
  // 材料台帳は、無効の材料を隠しているときだけ「無効も表示」に触れる（無効の材料も表示していて0件なら、材料は登録されていない）。
  expect(noMaterialsMessage({ ...base, includeInactive: true }, 'ledger')).toBe('材料はまだ登録されていません。「Excelから取込」または「手動で追加」から登録してください。');
  expect(noMaterialsMessage(base, 'ledger')).toBe('表示できる材料はありません。「Excelから取込」または「手動で追加」から登録してください（無効にした材料は「無効も表示」で表示できます）。');
});
