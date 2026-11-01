// 納期（E4）の判定。Excel出力の事前判定（Main）と画面の「出力前の確認」で同じ規則を使う。
export function validDateText(value: string): boolean {
  const match = /^([0-9]{4})([-/])([0-9]{1,2})([-/])([0-9]{1,2})$/.exec(value);
  if (!match || match[2] !== match[4]) return false;
  const year = Number(match[1]), month = Number(match[3]), day = Number(match[5]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return year >= 1 && days !== undefined && day >= 1 && day <= days;
}
