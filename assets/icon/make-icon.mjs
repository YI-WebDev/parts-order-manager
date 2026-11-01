// SVGのアイコンを各サイズのPNGに描き、Windows用の .ico（PNG格納）と確認用の一覧画像を作る。
// SVG を直したら作り直す: node assets/icon/make-icon.mjs assets/icon <確認画像の出力先.png>
// 出力: icon.ico（16〜256px の10サイズ）、icon-512.png、Tauri 用の 32x32.png・128x128.png・icon.ico（src-tauri/icons）、確認用の一覧画像。
// 描画には Playwright の Chromium を使う（POM_ICON_CHROMIUM で実行ファイルを指定できる）。
import { chromium } from '@playwright/test';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [dir, previewFile] = process.argv.slice(-2);
// サイズごとに使う絵柄（小さいほど細部を省いた版）。20・40 は表示倍率125%・250%用。
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const sourceFor = size => size <= 20 ? 'icon-16.svg' : size <= 40 ? 'icon-32.svg' : 'icon.svg';
const tauriIcons = path.join(path.dirname(new URL(import.meta.url).pathname), '../../src-tauri/icons');

function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at); header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2); header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(image => image.png)]);
}

const browser = await chromium.launch(process.env.POM_ICON_CHROMIUM ? { executablePath: process.env.POM_ICON_CHROMIUM } : {});
try {
  const page = await browser.newPage();
  await page.goto('about:blank');
  const render = (svg, size) => page.evaluate(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${size}; c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size}); resolve(c.toDataURL('image/png')); };
    img.onerror = () => reject(new Error('SVG load failed'));
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
  })`);
  const png = dataUrl => Buffer.from(dataUrl.split(',')[1], 'base64');
  // 描画する寸法そのものでSVGを読み込み、縮小によるにじみを避ける。
  const sized = (file, size) => readFileSync(path.join(dir, file), 'utf8').replace(/ width="\d+" height="\d+"/, ` width="${size}" height="${size}"`);
  const images = [];
  for (const size of SIZES) images.push({ size, png: png(await render(sized(sourceFor(size), size), size)) });
  writeFileSync(path.join(dir, 'icon.ico'), ico(images));
  writeFileSync(path.join(dir, 'icon-512.png'), png(await render(sized('icon.svg', 512), 512)));

  // 確認用: 明るい背景と暗い背景に各サイズを実寸で並べ、右に256pxを置く。
  const urls = images.map(({ size, png: data }) => ({ size, url: 'data:image/png;base64,' + data.toString('base64') }));
  const preview = await page.evaluate(`(async () => {
    const items = ${JSON.stringify(urls)};
    const load = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = src; });
    const c = document.createElement('canvas'); c.width = 1040; c.height = 330; const g = c.getContext('2d');
    g.fillStyle = '#f3f3f3'; g.fillRect(0, 0, 1040, 165); g.fillStyle = '#202020'; g.fillRect(0, 165, 1040, 165);
    g.font = '12px "Yu Gothic UI", sans-serif';
    let x = 16;
    for (const { size, url } of items.filter(i => i.size <= 128)) {
      const img = await load(url);
      for (const [top, color] of [[0, '#555'], [165, '#bbb']]) { g.drawImage(img, x, top + 128 - size); g.fillStyle = color; g.fillText(size + 'px', x, top + 150); }
      x += Math.max(size, 34) + 18;
    }
    const big = await load(items.at(-1).url);
    g.drawImage(big, 760, 37, 256, 256);
    return c.toDataURL('image/png');
  })()`);
  writeFileSync(previewFile, png(preview));
  // Tauri の実行ファイル・ウィンドウのアイコン。
  copyFileSync(path.join(dir, 'icon.ico'), path.join(tauriIcons, 'icon.ico'));
  writeFileSync(path.join(tauriIcons, '32x32.png'), png(await render(sized(sourceFor(32), 32), 32)));
  writeFileSync(path.join(tauriIcons, '128x128.png'), png(await render(sized('icon.svg', 128), 128)));
} finally {
  await browser.close();
}
