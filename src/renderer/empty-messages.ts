import type { SearchInput } from '../shared/material-search-api';

type Conditions = Pick<SearchInput, 'query' | 'categoryId' | 'includeInactive'>;

/** キーワード（空白だけは除く）かカテゴリで絞り込んでいるか。 */
export const filtered = (input: Conditions): boolean => input.query.trim() !== '' || input.categoryId !== null;

/**
 * 材料の検索結果が0件のときの案内。絞り込んでいるときは条件の変更を、絞り込んでいないときは材料の登録の仕方を示す
 * （材料が1件もないのに「キーワードを変更」と案内しない）。材料台帳は「無効も表示」を外していると無効の材料が残っていることがあるため、
 * その場合は表示の切り替えも示す（材料パレットは無効の材料を出さない）。
 */
export function noMaterialsMessage(input: Conditions, where: 'ledger' | 'palette'): string {
  if (filtered(input)) return '該当する材料はありません。キーワードやカテゴリを変更してください。';
  if (where === 'palette') return '検索できる材料がありません。「材料」タブの「Excelから取込」または「手動で追加」から登録してください。';
  return input.includeInactive ? '材料はまだ登録されていません。「Excelから取込」または「手動で追加」から登録してください。'
    : '表示できる材料はありません。「Excelから取込」または「手動で追加」から登録してください（無効にした材料は「無効も表示」で表示できます）。';
}
