import { expect, it } from 'vitest';
import { validDateText } from '../../src/shared/date-text';

// 納期の判定は画面（出力前の確認）と本体（Rust: pom-core の sheet::valid_date_text）で同じ規則。本体側との一致は sheet-parity.test.ts が確かめる。
it('validates delivery dates with the same rule on screen and in the app core', () => {
  for (const value of ['2026-09-13', '2026/9/13', '2028-02-29']) expect(validDateText(value)).toBe(true);
  for (const value of ['2026-02-30', '2026/09-13', '2026-13-01', '令和8年9月13日', '2027-02-29']) expect(validDateText(value)).toBe(false);
});
