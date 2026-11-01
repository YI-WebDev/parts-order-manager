import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { syntheticWorkbook, workbookParts, zipParts, textCell, withZip64CompressedSize } from '../fixtures/xlsx';
import { capture, confirm, expectKeyboardFocus, fixture, openImport, pick, subject } from './app';
import { evidencePath } from './evidence';

const wizard=(page:Page)=>page.getByRole('region',{name:'Excelから取込'});
/** ウィザード上部の進行状況（トーストや確定後の notice とは別の p[role=status]）。 */
const wizardStatus=(page:Page)=>wizard(page).locator('p.status-line[role="status"]');
/** 採用できる（disabled でない）行のチェックボックス。品名のない行・補足セルは disabled で表示する。要確認・列見出しの行は押せるが既定では外れている。 */
const adoptable=(page:Page)=>page.getByRole('checkbox',{name:/を採用$/,disabled:false});
/** 既定で選ばれている（＝材料候補の）チェックボックス。 */
const selected=(page:Page)=>page.getByRole('checkbox',{name:/を採用$/,checked:true});
async function openHistory(page:Page):Promise<void>{await page.getByRole('button',{name:'材料',exact:true}).click();await page.getByRole('tab',{name:'取込履歴',exact:true}).click();}

test('initial import UI cancels, confirms partially and persists without duplicate replay',async()=>{
  test.setTimeout(60_000);
  const f=await fixture(syntheticWorkbook());
  let application=await f.launch();
  try {
    let page=await application.firstWindow();
    await openImport(page,'first');
    for(const width of [375,768,1280])await capture(page,'import-empty',width);
    await pick(application,page,null);await expect(wizardStatus(page)).toHaveText('ファイル選択を取り消しました。');await capture(page,'import-dialog-cancel');
    const bad=path.join(f.root,'破損.xlsx');await writeFile(bad,'synthetic broken zip');
    await pick(application,page,bad);await expect(wizard(page).getByRole('alert')).toBeVisible();await capture(page,'import-parse-error');
    await pick(application,page,f.source);await expect(page.getByRole('region',{name:'取込確認'})).toContainText('材料候補 4件');
    for(const width of [375,768,1280]){await page.locator('.app-main').evaluate(element=>{element.scrollTop=0;});await capture(page,'import-preview',width);}
    await page.locator('.import-list details').nth(2).locator('summary').click();await capture(page,'import-cell-detail');
    await page.getByRole('group',{name:'表示する項目'}).getByRole('button',{name:/^要確認・補足 /}).click();await capture(page,'import-held');
    // 取消すと材料タブの取込履歴へ戻る。取消した記録を開き直して状態を確認する。
    await page.getByRole('button',{name:'この取込を取り消す',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'取込を取り消しました。原記録は取込履歴に保持しています。'})).toBeVisible();
    await expect(page.getByRole('table',{name:'取込履歴'})).toContainText('取消');
    await page.getByRole('button',{name:'架空材料.xlsx（取消）を開く',exact:true}).click();await expect(page.getByRole('region',{name:'取込確認'})).toContainText('取消');
    await expect(page.getByRole('region',{name:'取込確認'})).toContainText('この取込は取り消し済みのため、ここからは反映できません。もう一度取り込む場合は「最初から確認し直す」を押してください。');await capture(page,'import-cancelled');
    // 同じファイルを選び直すと前回取り消した記録が開くため、そのことと、最初から確認し直せることを案内する。
    await openImport(page,'first');await pick(application,page,f.source);
    await expect(page.getByRole('region',{name:'取込確認'})).toContainText('このファイルは前回、確定する前に取り消しています。もう一度取り込む場合は「最初から確認し直す」を押してください。前回の選択は残っておらず、確定するまで材料は変わりません。');await capture(page,'import-cancelled-reopened');
    await page.getByRole('button',{name:'最初から確認し直す',exact:true}).click();
    await expect(adoptable(page)).toHaveCount(4);
    await adoptable(page).first().uncheck();
    await confirm(page);await expect(wizardStatus(page)).toHaveText('反映 3件・保留 2件・補足保留 1件');await capture(page,'import-applied');
    // 確定後のフッターは「材料台帳を開く」のみ。別の取込は改めてウィザードを開いて行う。
    await openImport(page,'first');await pick(application,page,f.source);await expect(page.getByRole('region',{name:'取込確認'})).toBeVisible();
    const db=f.database();try{expect(db.prepare('SELECT count(*) n FROM materials').get()).toEqual({n:3});expect(db.prepare('SELECT count(*) n FROM import_items').get()).toEqual({n:8});}finally{db.close();}
    const changed=path.join(f.root,'変更版.xlsx');await writeFile(changed,zipParts(workbookParts(`<row r="2">${textCell('A2','変更された架空')}${textCell('B2','型')}</row>`)));
    await openImport(page,'first');await pick(application,page,changed);await expect(wizard(page).getByRole('alert')).toContainText('「変更したExcelで更新」を選んで取り込んでください');await capture(page,'import-changed-blocked');
    await application.close();application=await f.launch();page=await application.firstWindow();await openHistory(page);
    await expect(page.getByRole('table',{name:'取込履歴'})).toContainText('反映 3件');await page.getByRole('table',{name:'取込履歴'}).getByRole('button').first().click();await expect(page.getByRole('region',{name:'取込確認'})).toBeVisible();await capture(page,'import-restarted');
    const saved=f.database();try{expect(saved.prepare('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});expect(saved.prepare('SELECT count(DISTINCT last_source_item_id) n FROM materials').get()).toEqual({n:3});}finally{saved.close();}
    // 旧版の「別ウィンドウ（preload 付き）からの要求」に当たる、信頼できない送信元からの要求は拒否する（アプリ版では権限設定でメインウィンドウ以外は ipc を呼べず、さらに本体が送信元を確かめる）。
    expect((await application.untrustedInvoke('imports:list')).value).toMatchObject({status:'error'});
    await writeFile(evidencePath('import-persistence.json'),JSON.stringify({...subject(),materials:3,sourceItems:8,uniqueSources:3,restart:true,sameFileNoDuplicate:true,changedFileBlocked:true,otherWindowRejected:true,osDialog:'stubbed at dialog boundary; real parser IPC repository UI used'}));
  } finally {await application.close();await f.cleanup();}
});

test('an abnormal ZIP64 workbook is reported as a format error and the same app keeps importing',async()=>{
  const f=await fixture(syntheticWorkbook()),application=await f.launch();
  try {
    const page=await application.firstWindow();
    await openImport(page,'first');
    // 必須部品の圧縮後サイズを ZIP64 の最大値にした架空のExcel（旧版は解析中に panic し、配布版ではアプリが終了した）。
    const abnormal=path.join(f.root,'異常ZIP64.xlsx'),bytes=withZip64CompressedSize(syntheticWorkbook(),'xl/workbook.xml',0xffff_ffff_ffff_ffffn);await writeFile(abnormal,bytes);
    await pick(application,page,abnormal);await expect(wizard(page).getByRole('alert')).toContainText('ExcelのZIPを正常に読み取れません。');await capture(page,'import-zip64-error');
    // 同じアプリのまま、続けて正常なExcelを取り込める。
    await pick(application,page,f.source);await expect(page.getByRole('region',{name:'取込確認'})).toContainText('材料候補 4件');
    expect(await readFile(abnormal)).toEqual(bytes);
    const db=f.database();try{expect(db.prepare('SELECT count(*) n FROM import_batches').get()).toEqual({n:1});expect(db.prepare('SELECT count(*) n FROM materials').get()).toEqual({n:0});}finally{db.close();}
    await writeFile(evidencePath('import-zip64.json'),JSON.stringify({...subject(),abnormalZip64:'compressed size u64::MAX',formatError:true,appContinued:true,inputUnchanged:true}));
  } finally {await application.close();await f.cleanup();}
});

test('failed confirmation retains input and permits a fresh resolution after rollback',async()=>{
  const f=await fixture(syntheticWorkbook()),application=await f.launch();
  try {
    const page=await application.firstWindow();await openImport(page,'first');await pick(application,page,f.source);
    // 材料候補4件が既定で選ばれ、列見出しの2行は押せるが外れている。
    await expect(selected(page)).toHaveCount(4);await expect(adoptable(page)).toHaveCount(6);
    const db=f.database();try{db.exec("CREATE TRIGGER ui_failure BEFORE INSERT ON materials WHEN NEW.model='R-01' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");}finally{db.close();}
    // 確定の段階では内容確認（region 取込確認）は表示されないため、確定の段階の状態表示で保存失敗を確認する。
    await confirm(page);await expect(wizard(page).getByRole('alert')).toContainText('保存に失敗');await expect(wizard(page)).toContainText('この取込は保存失敗です。');await capture(page,'import-save-error');
    const check=f.database();try{expect(check.prepare('SELECT count(*) n FROM materials').get()).toEqual({n:0});check.exec('DROP TRIGGER ui_failure');}finally{check.close();}
    // 失敗後のフッターは「材料台帳を開く」のみ。取込履歴から失敗した記録を開いて再確認する。
    await page.getByRole('button',{name:'材料台帳を開く',exact:true}).click();await page.getByRole('tab',{name:'取込履歴',exact:true}).click();
    await page.getByRole('button',{name:'架空材料.xlsx（保存失敗）を開く',exact:true}).click();await expect(page.getByRole('region',{name:'取込確認'})).toContainText('保存失敗');
    // confirm は「次へ」の有無をその場で判定するため、再確認の応答（内容確認の段階）を待ってから進める。
    await page.getByRole('button',{name:'未反映の候補を再確認',exact:true}).click();await expect(page.getByRole('button',{name:'次へ',exact:true})).toBeVisible();await confirm(page);await expect(wizardStatus(page)).toContainText('反映 4件');await capture(page,'import-recovered');
  }finally{await application.close();await f.cleanup();}
});

test('long values and paged candidates remain operable at all required widths',async()=>{
  const rows=Array.from({length:30},(_,index)=>`<row r="${index+2}">${textCell(`A${index+2}`,'架空材料の長い名称'.repeat(10))}${textCell(`B${index+2}`,'0001-LONG'.repeat(10))}${textCell(`D${index+2}`,'02 本')}</row>`).join('');
  const f=await fixture(zipParts(workbookParts(rows))),application=await f.launch();
  try {
    const page=await application.firstWindow();await openImport(page,'first');await pick(application,page,f.source);
    await expect(page.getByRole('region',{name:'取込確認'})).toContainText('材料候補 30件');
    for(const width of [375,768,1280]){
      await page.locator('.app-main').evaluate(element=>{element.scrollTop=0;});await capture(page,'import-long-top',width);
      await page.locator('.import-list details').nth(2).locator('summary').click();await capture(page,'import-long-detail',width);await page.locator('.import-list details').nth(2).locator('summary').click();
      await page.getByRole('button',{name:'次の25件',exact:true}).click();await capture(page,'import-page-two',width);await page.getByRole('button',{name:'前の25件',exact:true}).click();
    }
    const all=page.getByRole('button',{name:'候補をすべて選択',exact:true});await page.mouse.move(0,0);await all.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');await expectKeyboardFocus(all);await capture(page,'import-focus');await page.keyboard.press('Enter');await expect(page.getByRole('checkbox',{name:'架空材料 2行 左を採用',exact:true})).toBeChecked();await expect(page.getByRole('checkbox',{name:'架空材料 1行 左を採用',exact:true})).not.toBeChecked();
  }finally{await application.close();await f.cleanup();}
});

test('pending file selection disables competing actions and confirmation requires acknowledgement',async()=>{
  const f=await fixture(syntheticWorkbook()),application=await f.launch();
  try {
    const page=await application.firstWindow();await openImport(page,'first');
    // ファイル選択ダイアログを release まで閉じない（閉じると取消）。
    await application.dialog('open',null,'test:release-picker');
    const picker=page.getByRole('button',{name:/ドロップ、またはクリックして選択/});
    await picker.click();
    await expect(page.getByRole('button',{name:'設定',exact:true})).toBeDisabled();
    await expect(picker).toBeDisabled();
    for(const width of [375,768,1280])await capture(page,'import-pending',width);
    await expect.poll(()=>application.count('test:release-picker')).toBe(1);
    await application.release('test:release-picker');
    await expect(wizardStatus(page)).toHaveText('ファイル選択を取り消しました。');
    // 内容確認から「次へ」で確定の段階へ進む。確認チェックを入れるまで確定ボタンは無効。
    await pick(application,page,f.source);await page.getByRole('button',{name:'次へ',exact:true}).click();const apply=page.getByRole('button',{name:'選択した候補を確定',exact:true});
    await expect(apply).toBeDisabled();await page.getByRole('checkbox',{name:'件数と内容を確認しました'}).check();
    await expect(apply).toBeEnabled();await apply.hover();await capture(page,'import-confirm-hover');
    // 確認チェックの後のTab順は フッターの「この取込を取り消す」→「戻る」→ 確定ボタン。
    await page.mouse.move(0,0);await page.getByRole('checkbox',{name:'件数と内容を確認しました'}).focus();
    await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'この取込を取り消す',exact:true})).toBeFocused();
    await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'戻る',exact:true})).toBeFocused();
    await page.keyboard.press('Tab');await expectKeyboardFocus(apply);await capture(page,'import-confirm-focus');await page.keyboard.press('Enter');
    await expect(wizardStatus(page)).toContainText('反映 4件');
  }finally{await application.close();await f.cleanup();}
});

test('held and heading rows with a name can be adopted after review while nameless rows and supplements stay locked',async()=>{
  const rows=`<row r="2">${textCell('A2','架空候補')}${textCell('B2','C-1')}</row><row r="3">${textCell('A3','架空型式なし')}${textCell('C3','架空社')}</row><row r="4">${textCell('C4','架空品名なし')}${textCell('G4','架空補足')}</row>`;
  const f=await fixture(zipParts(workbookParts(rows))),application=await f.launch();
  try {
    const page=await application.firstWindow();await openImport(page,'first');await pick(application,page,f.source);
    const review=page.getByRole('region',{name:'取込確認'});await expect(review).toContainText('材料候補 1件 / 要確認・保留 2件 / 補足保留 1件 / 除外（見出し）2件');
    const row=(label:string)=>review.locator('.import-row').filter({has:page.getByRole('checkbox',{name:label,exact:true})});
    const box=(label:string)=>page.getByRole('checkbox',{name:label,exact:true});
    // 材料候補だけが既定で選ばれる。要確認（型式なし）・列見出しの行は押せるが外れている。品名のない行と補足セルは押せず、理由を示す。
    await expect(box('架空材料 2行 左を採用')).toBeChecked();
    for(const label of ['架空材料 3行 左を採用','架空材料 1行 左を採用','架空材料 1行 右を採用']){await expect(box(label)).toBeEnabled();await expect(box(label)).not.toBeChecked();}
    await expect(box('架空材料 4行 左を採用')).toBeDisabled();await expect(row('架空材料 4行 左を採用')).toContainText('品名がないため採用できません');
    await expect(box('架空材料 4行 G4を採用')).toBeDisabled();await expect(row('架空材料 4行 G4を採用')).toContainText('補足セルは材料にできません');
    // バッジは文字に合わせた横長の形で、文字がはみ出さない（以前は Tailwind の同名ユーティリティで正方形に潰れていた）。
    for(const badge of await review.locator('.import-row .badge').all()){const size=await badge.evaluate(element=>({scroll:element.scrollWidth,client:element.clientWidth,height:element.getBoundingClientRect().height}));expect(size.scroll).toBeLessThanOrEqual(size.client);expect(size.height).toBeLessThan(30);}
    await box('架空材料 3行 左を採用').check();
    await expect(review.getByRole('status')).toHaveText('要確認・除外の行を 1件 選んでいます。原セルの値と表示を確認してから確定してください。');
    for(const width of [375,1280])await capture(page,'import-adopt-held',width);
    await page.setViewportSize({width:1280,height:800});
    await page.getByRole('button',{name:'次へ',exact:true}).click();
    await expect(wizard(page)).toContainText('選択した候補 2件を登録します（うち要確認・除外から選んだ行 1件）。');
    await confirm(page);await expect(wizardStatus(page)).toHaveText('反映 2件・保留 1件・補足保留 1件');
    const db=f.database();try{expect(db.prepare('SELECT name FROM materials ORDER BY name').all()).toEqual([{name:'架空候補'},{name:'架空型式なし'}]);}finally{db.close();}
  }finally{await application.close();await f.cleanup();}
});
