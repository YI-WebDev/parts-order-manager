import { QUERY_MAX_LENGTH } from '../shared/limits';
export { QUERY_MAX_LENGTH };

/**
 * 本体へ送る検索語。日本語の変換中は、欄の文字が maxLength を超えることがある（確定のときにブラウザが切り詰める）。
 * そのまま送ると本体に拒まれてエラーになるため、先頭の QUERY_MAX_LENGTH 文字（コードポイント）に切る。欄に表示する文字は切らない。
 */
export function clipQuery(query: string): string {
  const characters = Array.from(query);
  return characters.length > QUERY_MAX_LENGTH ? characters.slice(0, QUERY_MAX_LENGTH).join('') : query;
}
