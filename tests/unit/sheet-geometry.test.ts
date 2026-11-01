import { expect, it } from 'vitest';
import { COLUMNS, overflowColumns, overflowColumnsLeft, overflowSides, sideRoom, w } from '../../src/shared/sheet-geometry';

// 文字のはみ出し（Excelと同じく、空欄の隣へ広がる）。中央揃えの文字は、左右に続く空欄へ同じ幅だけ（短い側の幅まで）はみ出す。
// 本体（Rust: sheet.rs の overflow_sides・side_room）と同じ規則で、印刷HTMLは差分の代わりに print_html.rs のテストで確かめる。

const emptyExcept = (filled: readonly number[]) => (_row: number, column: number): boolean => !filled.includes(column);

it('counts the empty neighbours on each side of a centred cell', () => {
  // C（2）の左右がすべて空欄: 左に A・B、右に D〜H。
  expect(overflowSides(2, 2, emptyExcept([2]))).toEqual({ left: 2, right: 5 });
  // 印刷範囲（A〜G）では右は D〜G。
  expect(overflowSides(2, 2, emptyExcept([2]), 7)).toEqual({ left: 2, right: 4 });
  // 隣が埋まっている側は 0。
  expect(overflowSides(6, 1, emptyExcept([0, 1]))).toEqual({ left: 0, right: COLUMNS - 2 });
  expect(overflowSides(6, 1, emptyExcept([0, 1, 2]))).toEqual({ left: 0, right: 0 });
  // 端の列は、その側へはみ出せない。
  expect(overflowSides(6, 0, emptyExcept([0]))).toEqual({ left: 0, right: COLUMNS - 1 });
  expect(overflowSides(6, COLUMNS - 1, emptyExcept([COLUMNS - 1]))).toEqual({ left: COLUMNS - 1, right: 0 });
  // 左寄せ・右揃えの規則（自分の列を含む列数）は変えていない。
  expect(overflowColumns(2, 2, emptyExcept([2]))).toBe(COLUMNS - 2);
  expect(overflowColumnsLeft(2, 2, emptyExcept([2]))).toBe(3);
});

it('limits the symmetric spill to the narrower side', () => {
  // C（2）: 左は B（27.33文字）＋A（7文字）、右は D（9.89）＋E（11.11）＋F（23.78）＋G（9）。
  const left = w(1) + w(0), right = w(3) + w(4) + w(5) + w(6);
  expect(sideRoom(2, { left: 2, right: 4 })).toBe(Math.min(left, right));
  expect(sideRoom(2, { left: 1, right: 1 })).toBe(Math.min(w(1), w(3)));
  // 片側が 0 ならはみ出さない。
  expect(sideRoom(2, { left: 0, right: 4 })).toBe(0);
  expect(sideRoom(2, { left: 2, right: 0 })).toBe(0);
});
