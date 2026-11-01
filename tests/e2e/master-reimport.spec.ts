import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, pick, confirm, capture, openImport, subject } from './app';
import { textCell, workbookParts, zipParts } from '../fixtures/xlsx';
import { evidencePath } from './evidence';
const book=(rows:readonly (readonly [number,string,string])[])=>zipParts(workbookParts(rows.map(([n,name,model])=>`<row r="${n}">${textCell(`A${n}`,name)}${textCell(`B${n}`,model)}${textCell(`D${n}`,'02 本')}</row>`).join('')));
const wizard=(page:Page)=>page.getByRole('region',{name:'Excelから取込'});
const ledger=(page:Page)=>page.getByRole('region',{name:'材料'});
/** 材料台帳の件数表示（選択の帯の「N件を選択中」の status は除く）。 */
const ledgerStatus=(page:Page)=>ledger(page).locator('p[role="status"]:not([aria-label])');
/** 材料台帳で、指定テキストを含む行の編集ボタンを押してドロワーを開く。 */
async function editRow(page:Page,rowText:string,name:string):Promise<void>{await page.getByRole('table',{name:'材料台帳'}).getByRole('row').filter({hasText:rowText}).getByRole('button',{name:`${name}を編集`,exact:true}).click();}
test('management and explicit reimport preserve snapshots through conflicts failure retry and restart',async()=>{
  test.setTimeout(60000);const f=await fixture(book([[2,'架空部品','001-A'],[3,'消失候補','002-B']]));let application=await f.launch();
  try{let page=await application.firstWindow();await openImport(page,'first');await pick(application,page,f.source);
    await page.getByRole('button',{name:'候補をすべて選択'}).click();await confirm(page);
    const ids=await page.evaluate(async()=>{const r=await window.appApi.materials.search({query:'',categoryId:null,includeInactive:false,offset:0});if(r.status!=='ok')throw new Error('search');return r.data.rows.map(m=>({id:m.id,name:m.name}));});
    const original=ids.find(m=>m.name==='架空部品');if(!original)throw new Error('material');
    const documentId=await page.evaluate(async id=>{const opened=await window.appApi.documents.open(null);if(opened.status!=='ok')throw new Error('open');const line=await window.appApi.documents.addLine({sessionId:opened.data.sessionId,materialId:id});if(line.status!=='ok')throw new Error('line');const saved=await window.appApi.documents.save({sessionId:opened.data.sessionId,requestNumber:1,generation:1,expectedRevision:0,draft:{...opened.data.draft,title:'架空保持検証',lines:[line.data]}});if(saved.status!=='ok')throw new Error('save');return saved.data.documentId;},original.id);
    const db=f.database(),before=db.prepare('SELECT * FROM document_lines WHERE document_id=?').all(documentId as never);db.close();
    await page.getByRole('button',{name:'材料',exact:true}).click();await page.getByRole('button',{name:'手動で追加',exact:true}).click();
    const created=page.getByRole('dialog',{name:'材料を手動追加'});
    await created.getByLabel('品名',{exact:true}).fill('手動作成の架空材料');await created.getByLabel('型式',{exact:true}).fill('000-手動');await created.getByLabel('数量',{exact:true}).fill('02 本');await created.locator('.drawer-body').evaluate(el=>{el.scrollTop=0;});await expect(created.getByRole('checkbox',{name:'有効（外すと検索の既定結果から除外）'})).toHaveCSS('height','20px');await expect(created.getByRole('checkbox',{name:'有効（外すと検索の既定結果から除外）'})).toHaveCSS('width','20px');await capture(page,'master-new');await capture(page,'master-new',760);await created.getByRole('button',{name:'材料を保存',exact:true}).scrollIntoViewIfNeeded();await capture(page,'master-new-actions',760);await created.getByRole('button',{name:'材料を保存',exact:true}).click();await expect(page.getByText('材料を保存しました。',{exact:true})).toBeVisible();
    await ledger(page).getByLabel('キーワード',{exact:true}).fill('架空部品');await expect(ledgerStatus(page)).toHaveText('1件中 1～1件');await editRow(page,'001-A','架空部品');await expect(page.getByRole('heading',{name:'材料を編集',exact:true})).toBeVisible();await page.getByRole('dialog',{name:'材料を編集'}).getByRole('textbox',{name:'型式',exact:true}).fill('手動-009');await page.getByRole('dialog',{name:'材料を編集'}).getByRole('button',{name:'材料を保存',exact:true}).click();
    const changed=path.join(f.root,'架空変更.xlsx');await writeFile(changed,book([[8,'架空部品','001-Z'],[9,'追加部品','003-C']]));
    // 材料ドロワーが閉じる（保存完了）までナビゲーションは無効なので、openImport は保存後に進む。
    await openImport(page,'re');const series=await page.evaluate(async()=>{const r=await window.appApi.master.series();if(r.status!=='ok'||!r.data[0])throw new Error('series');return r.data[0].id;});await page.getByLabel('更新する取込元').selectOption(series);
    await pick(application,page,changed);
    await page.getByLabel('8行 leftの扱い',{exact:true}).selectOption(original.id);await expect(page.getByText('競合',{exact:true})).toBeVisible();await expect(page.getByRole('checkbox',{name:'型式を反映',exact:true})).not.toBeChecked();await expect(page.getByRole('checkbox',{name:'型式を反映',exact:true})).toHaveCSS('width','20px');
    // 旧 .reimport-comparison（6項目の比較表）は、行カード内の差分行に置き換わった。8行の行カードを証跡にする。
    const comparison=page.locator('.re-row').filter({has:page.getByLabel('8行 leftの扱い',{exact:true})});
    await page.getByLabel('9行 leftの扱い',{exact:true}).selectOption('new');await capture(page,'reimport-conflict');await capture(page,'reimport-conflict',760);await comparison.scrollIntoViewIfNeeded();await capture(page,'reimport-comparison',760);await page.setViewportSize({width:1280,height:800});await comparison.scrollIntoViewIfNeeded();await capture(page,'reimport-comparison');
    // Excelに見当たらない材料は差分の一覧に並ぶ（行のある材料は出ない）。無効化は差分確認の段階、確認チェックと確定適用は「次へ」の後の確定の段階にある。
    await expect(wizard(page).locator('.re-row').filter({hasText:'Excelに見当たらない'})).toHaveCount(1);
    const missing=page.getByLabel('消失候補（Excelに見当たらない）の扱い',{exact:true});
    await missing.selectOption('inactive');await page.getByRole('button',{name:'次へ',exact:true}).click();
    for(const width of [1280,760]){await page.setViewportSize({width,height:800});await page.getByRole('button',{name:'確認した内容を確定適用'}).scrollIntoViewIfNeeded();await capture(page,'reimport-confirm-before',width);}
    await page.getByRole('checkbox',{name:'対応関係・反映する項目・保留・無効化を確認しました'}).check();
    for(const width of [1280,760]){await page.setViewportSize({width,height:800});await page.getByRole('button',{name:'確認した内容を確定適用'}).scrollIntoViewIfNeeded();await capture(page,'reimport-confirm-after',width);}
    const fail=f.database();fail.exec("CREATE TRIGGER step10_fail BEFORE INSERT ON import_decisions BEGIN SELECT RAISE(ABORT,'fictional'); END;");fail.close();await page.getByRole('button',{name:'確認した内容を確定適用'}).click();await expect(page.getByText(/処理できませんでした。入力と原記録/)).toBeVisible();await expect(wizard(page).getByRole('alert')).toBeFocused();await capture(page,'reimport-failure');
    const retry=f.database();expect(retry.prepare('SELECT * FROM document_lines WHERE document_id=?').all(documentId as never)).toEqual(before);expect(retry.prepare("SELECT count(*) AS n FROM materials WHERE name='追加部品'").get()).toEqual({n:0});retry.exec('DROP TRIGGER step10_fail');retry.close();
    await page.getByRole('button',{name:'確認した内容を確定適用'}).click();await expect(page.getByText('確定済みの取込です。重複して反映しません。')).toBeVisible();await capture(page,'reimport-applied');
    // 確定の段階では判断履歴は表示されない。取込履歴から確定済みの記録を開いて確認する。
    await page.getByRole('button',{name:'材料台帳を開く',exact:true}).click();await page.getByRole('tab',{name:'取込履歴',exact:true}).click();await page.getByRole('button',{name:'架空変更.xlsx（確定済み）を開く',exact:true}).click();
    await page.getByText(/^確定した判断履歴/).click();await capture(page,'reimport-decisions');await page.getByText('利用者が未対応材料の無効化を明示',{exact:true}).scrollIntoViewIfNeeded();await capture(page,'reimport-decision-reason');
    await application.close();application=await f.launch();page=await application.firstWindow();const verified=f.database();expect(verified.prepare('SELECT * FROM document_lines WHERE document_id=?').all(documentId as never)).toEqual(before);expect(verified.prepare('SELECT model FROM materials WHERE id=?').get(original.id as never)).toEqual({model:'手動-009'});expect(verified.prepare("SELECT active FROM materials WHERE name='消失候補'").get()).toEqual({active:0});expect(verified.prepare("SELECT count(*) AS n FROM materials WHERE name='手動作成の架空材料' AND last_source_item_id IS NULL").get()).toEqual({n:1});verified.close();
    await page.getByRole('button',{name:'材料',exact:true}).click();await ledger(page).getByRole('checkbox',{name:'無効も表示',exact:true}).check();await ledger(page).getByLabel('キーワード',{exact:true}).fill('消失候補');await expect(ledgerStatus(page)).toHaveText('1件中 1～1件');await editRow(page,'002-B','消失候補');
    const inactive=page.getByRole('dialog',{name:'材料を編集'});await expect(inactive.getByLabel('有効（外すと検索の既定結果から除外）')).not.toBeChecked();await inactive.locator('.drawer-body').evaluate(el=>{el.scrollTop=0;});await capture(page,'master-inactive');
    for(const width of [1280,760]){await page.setViewportSize({width,height:800});await inactive.getByRole('button',{name:'材料を保存',exact:true}).scrollIntoViewIfNeeded();await capture(page,'master-inactive-actions',width);}
    await inactive.getByRole('button',{name:'編集を取り消す'}).click();
    await writeFile(evidencePath('master-reimport-result.json'),JSON.stringify({...subject(),status:'passed',windows:process.platform,snapshotUnchanged:true,manualPreserved:true,rollback:true,retry:true,restart:true,openDialog:'mock',realOsIme:'not-executed'},null,2));
  }finally{await application.close();await f.cleanup();}
});
test('reimport rejects stale confirmation and malformed IPC; cancellation preserves records',async()=>{
  const f=await fixture(book([[2,'境界部品','001-A']])),application=await f.launch();
  try{const page=await application.firstWindow();await openImport(page,'first');await pick(application,page,f.source);await page.getByRole('button',{name:'候補をすべて選択'}).click();await confirm(page);
    await openImport(page,'re');const series=await page.evaluate(async()=>{const r=await window.appApi.master.series();if(r.status!=='ok'||!r.data[0])throw new Error('series');return r.data[0].id;});await page.getByLabel('更新する取込元').selectOption(series);
    await pick(application,page,null);await expect(page.getByText('ファイル選択を取り消しました。')).toBeVisible();await capture(page,'reimport-cancelled-dialog');
    const changed=path.join(f.root,'架空境界.xlsx');await writeFile(changed,book([[5,'境界部品','001-B']]));await pick(application,page,changed);await page.getByLabel('5行 leftの扱い',{exact:true}).selectOption('new');
    await page.evaluate(async()=>{const r=await window.appApi.materials.search({query:'境界部品',categoryId:null,includeInactive:false,offset:0});if(r.status!=='ok'||!r.data.rows[0])throw new Error('material');const f=await window.appApi.master.get(r.data.rows[0].id);if(f.status!=='ok'||!f.data.material)throw new Error('form');const m=f.data.material;const saved=await window.appApi.master.save({id:m.id,expectedRevision:m.revision,categoryId:m.categoryId,newCategoryName:'',active:true,values:{...m.values,remarks:'確認後の架空編集'}});if(saved.status!=='ok')throw new Error('save');});
    await page.getByRole('button',{name:'次へ',exact:true}).click();
    await page.getByRole('checkbox',{name:'対応関係・反映する項目・保留・無効化を確認しました'}).check();await page.getByRole('button',{name:'確認した内容を確定適用'}).click();await expect(page.getByText(/材料または取込履歴が変更されています/)).toBeVisible();await expect(page.getByRole('button',{name:'確認した内容を確定適用'})).toBeDisabled();await expect(wizard(page).getByRole('alert').first()).toBeFocused();await capture(page,'reimport-stale');
    const db=f.database();expect(db.prepare('SELECT count(*) AS n FROM materials').get()).toEqual({n:1});const originals=db.prepare('SELECT * FROM import_items ORDER BY id').all();db.close();
    // 旧版の「別ウィンドウ（preload 付き）からの要求」に当たる、信頼できない送信元からの要求は拒否する（アプリ版では権限設定でメインウィンドウ以外は ipc を呼べず、さらに本体が送信元を確かめる）。
    const batchId=await page.evaluate(async()=>{const r=await window.appApi.master.list();if(r.status!=='ok'||!r.data[0])throw new Error('batch');return r.data[0].id;});
    expect([(await application.untrustedInvoke('master:get',null)).value,(await application.untrustedInvoke('reimport:review',batchId)).value]).toMatchObject([{status:'error'},{status:'error'}]);
    expect(await page.evaluate(async()=>{const r=await Reflect.apply(window.appApi.master.save,null,[{id:null,expectedRevision:0,categoryId:null,newCategoryName:'架空',active:true,values:{name:'架空',model:'',manufacturer:'',quantity:'',remarks:'',unitPrice:''},sql:'DROP TABLE materials'}]);return r.status;})).toBe('error');
    // 新UIでは確認中（preview）の記録に「未反映分を再確認」が出ないため、取り消してから取込履歴で開き直し、再確認する
    //（旧UIの再確認 master.resume も、古くなった確認中の記録を取消扱いにして新しい確認中の記録を作る）。
    await page.getByRole('button',{name:'この取込を取り消す',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'取込を取り消しました。原記録は取込履歴に保持しています。'})).toBeVisible();
    await page.getByRole('button',{name:'架空境界.xlsx（取消）を開く',exact:true}).click();await expect(wizard(page)).toContainText('この取込は取り消し済みのため、ここからは反映できません。');
    await page.getByRole('button',{name:'最初から確認し直す',exact:true}).click();await expect(page.getByText('原記録を保存しました。まだ材料へ反映していません。')).toBeVisible();await page.getByRole('button',{name:'次へ',exact:true}).click();await expect(page.getByRole('checkbox',{name:'対応関係・反映する項目・保留・無効化を確認しました'})).not.toBeChecked();await capture(page,'reimport-refreshed');
    // 旧UIの「状態: cancelled」表示は、取込履歴の状態バッジ（取消）で確認する。
    await page.getByRole('button',{name:'この取込を取り消す',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'取込を取り消しました。原記録は取込履歴に保持しています。'})).toBeVisible();
    const history=page.getByRole('table',{name:'取込履歴'});await expect(history.getByRole('button',{name:'架空境界.xlsx（取消）を開く',exact:true})).toHaveCount(2);await expect(history.getByRole('button',{name:'架空境界.xlsx（確認中）を開く',exact:true})).toHaveCount(0);await capture(page,'reimport-cancelled');const after=f.database();expect(after.prepare('SELECT * FROM import_items ORDER BY id').all()).toEqual(originals);expect(after.prepare('SELECT count(*) AS n FROM materials').get()).toEqual({n:1});after.close();
    await writeFile(evidencePath('master-boundary-result.json'),JSON.stringify({...subject(),staleRejected:true,rawRecordsPreserved:true,extraKeyRejected:true,refreshResetsConfirmation:true,dialogCancellation:'mock',importCancellation:true},null,2));
  }finally{await application.close();await f.cleanup();}
});

test('reimport lets a held row with a name be added after review while a nameless row stays held',async()=>{
  const f=await fixture(book([[2,'架空部品','001-A']])),application=await f.launch();
  try{const page=await application.firstWindow();await openImport(page,'first');await pick(application,page,f.source);await expect(page.getByRole('region',{name:'取込確認'})).toBeVisible();await confirm(page);
    // 3行目は型式が空欄（品名あり）の要確認、4行目は品名が空欄の要確認。
    const changed=path.join(f.root,'架空要確認.xlsx');await writeFile(changed,book([[2,'架空部品','001-A'],[3,'架空型式なし',''],[4,'','003-C']]));
    await openImport(page,'re');const series=await page.evaluate(async()=>{const r=await window.appApi.master.series();if(r.status!=='ok'||!r.data[0])throw new Error('series');return r.data[0].id;});await page.getByLabel('更新する取込元').selectOption(series);
    await pick(application,page,changed);
    const card=(row:number)=>wizard(page).locator('.re-row').filter({has:page.getByLabel(`${row}行 leftの扱い`,{exact:true})});
    await expect(page.getByLabel('3行 leftの扱い',{exact:true})).toBeEnabled();await expect(card(3)).toContainText('要確認の行です。');
    await expect(page.getByLabel('4行 leftの扱い',{exact:true})).toBeDisabled();await expect(card(4)).toContainText('品名がないため採用できません。保留のまま残します。');
    // 前回と同じ内容の2行目は「確認が必要」には出ず、「すべて」で確認できる。
    await expect(page.getByLabel('2行 leftの扱い',{exact:true})).toHaveCount(0);await wizard(page).getByRole('button',{name:/^すべて \d+$/}).click();await expect(page.getByLabel('2行 leftの扱い',{exact:true})).toBeVisible();
    await page.getByLabel('3行 leftの扱い',{exact:true}).selectOption('new');await capture(page,'reimport-held-new');
    await page.getByRole('button',{name:'次へ',exact:true}).click();await page.getByRole('checkbox',{name:'対応関係・反映する項目・保留・無効化を確認しました'}).check();await page.getByRole('button',{name:'確認した内容を確定適用'}).click();
    await expect(wizard(page)).toContainText('確認した内容を反映しました（反映 1件）。');
    const db=f.database();try{expect(db.prepare("SELECT count(*) AS n FROM materials WHERE name='架空型式なし'").get()).toEqual({n:1});expect(db.prepare('SELECT count(*) AS n FROM materials').get()).toEqual({n:2});}finally{db.close();}
  }finally{await application.close();await f.cleanup();}
});
