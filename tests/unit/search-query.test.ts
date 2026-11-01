import { expect, it } from 'vitest';
import { clipQuery, QUERY_MAX_LENGTH } from '../../src/renderer/search-query';

it('keeps a query within the limit and clips a longer one to its first 256 code points', () => {
  expect(QUERY_MAX_LENGTH).toBe(256);
  expect(clipQuery('')).toBe('');
  const full = 'あ'.repeat(256);
  expect(clipQuery(full)).toBe(full);
  expect(clipQuery(`${'あ'.repeat(255)}かきく`)).toBe(`${'あ'.repeat(255)}か`);
});

it('counts a character outside the BMP as one and never splits it', () => {
  // 𩸽（U+29E3D）は UTF-16 では2単位。本体と同じくコードポイントで数え、サロゲートの片方だけを残さない。
  const astral = '𩸽'.repeat(257);
  expect(astral.length).toBe(514);
  expect(clipQuery(astral)).toBe('𩸽'.repeat(256));
  expect(clipQuery(`${'あ'.repeat(255)}𩸽𩸽`)).toBe(`${'あ'.repeat(255)}𩸽`);
});
