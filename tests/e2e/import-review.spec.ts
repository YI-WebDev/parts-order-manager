import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { capture, confirm, fixture, openImport, pick } from './app';
import { escapeXml, syntheticWorkbook, textCell, workbookParts, zipParts } from '../fixtures/xlsx';
import { evidencePath } from './evidence';

const wizard=(page:Page)=>page.getByRole('region',{name:'Excelから取込'});
const wizardStatus=(page:Page)=>wizard(page).locator('p.status-line[role="status"]');
/** 材料タブの「取込履歴」から、ファイル名で始まる記録を開く。 */
async function openRecord(page:Page,name:RegExp):Promise<void>{
  await page.getByRole('tab',{name:'取込履歴',exact:true}).click();
  await page.getByRole('table',{name:'取込履歴'}).getByRole('button',{name}).click();
}

for (const state of ['cancelled','failed'] as const) {
  test(`old ${state} import stays read-only after another source commits and restarts`, async () => {
    const f=await fixture(syntheticWorkbook());let app=await f.launch();
    try {
      let page=await app.firstWindow();await openImport(page,'first');await pick(app,page,f.source);
      await expect(page.getByRole('region',{name:'取込確認'})).toContainText('材料候補 4件');
      if(state==='cancelled')await page.getByRole('button',{name:'この取込を取り消す',exact:true}).click();
      else {
        const db=f.database();try{db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON materials BEGIN SELECT RAISE(ABORT,'fixture'); END;");}finally{db.close();}
        await confirm(page);await expect(wizard(page).getByRole('alert')).toContainText('保存に失敗');
        const db2=f.database();try{db2.exec('DROP TRIGGER fail_import');}finally{db2.close();}
      }
      const b=path.join(f.root,'別系列.xlsx');await writeFile(b,zipParts(workbookParts(`<row r="2">${textCell('A2','別系列の架空')}${textCell('B2','B-01')}</row>`)));
      await openImport(page,'first');await pick(app,page,b);await expect(page.getByRole('region',{name:'取込確認'})).toContainText('別系列.xlsx');
      // 別系列を確認中のまま材料タブへ戻り、取込履歴から古い記録を開く。
      await page.getByRole('button',{name:'← 材料へ戻る',exact:true}).click();await openRecord(page,/^架空材料\.xlsx（/);
      // 取り消した記録は「最初から確認し直す」、保存に失敗した記録は「未反映の候補を再確認」。別の取込を確認中なのはその場の状態なので、押してから理由を示す。
      const resumeLabel=state==='cancelled'?'最初から確認し直す':'未反映の候補を再確認';
      await page.getByRole('button',{name:resumeLabel,exact:true}).click();await expect(wizard(page).getByRole('alert')).toContainText('別の取込');
      await expect(page.getByRole('region',{name:'取込確認'})).toContainText('架空材料.xlsx');await wizard(page).getByRole('alert').scrollIntoViewIfNeeded();await capture(page,`review-${state}-other-preview`);
      await page.getByRole('button',{name:'← 材料へ戻る',exact:true}).click();await openRecord(page,/^別系列\.xlsx（/);await confirm(page);await expect(wizardStatus(page)).toContainText('反映 1件');
      await app.close();app=await f.launch();page=await app.firstWindow();await page.getByRole('button',{name:'材料',exact:true}).click();
      await openRecord(page,/^架空材料\.xlsx（/);
      // 別の取込を確定した後は再確認できないため、ボタンを出さずに理由を示す。
      const notice=page.getByRole('region',{name:'取込確認'}).locator('.notice');
      await expect(notice).toContainText('別の取込が確定済み');await expect(page.getByRole('button',{name:resumeLabel,exact:true})).toHaveCount(0);
      await notice.scrollIntoViewIfNeeded();await capture(page,`review-${state}-restart-blocked`);
      const check=f.database();try{expect(check.prepare('SELECT count(*) n FROM materials').get()).toEqual({n:1});expect(check.prepare("SELECT count(DISTINCT source_series_id) n FROM import_batches WHERE status='applied'").get()).toEqual({n:1});expect(check.prepare('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});}finally{check.close();}
      await writeFile(evidencePath(`review-${state}.json`),JSON.stringify({state,otherPreviewRefused:true,originalReviewRetained:true,restartOldResumeRefused:true,materials:1,committedSeries:1}));
    } finally {await app.close();await f.cleanup();}
  });
}

test('unsupported text stays held while shared formulas and oversized metadata leave no new batches', async () => {
  const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const style=(code:string)=>`<styleSheet xmlns="${ns}"><numFmts><numFmt numFmtId="164" formatCode="${escapeXml(code)}"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>`;
  const rows=`<row r="2">${textCell('A2','架空')}${textCell('B2','型')}<c r="D2" t="inlineStr" s="1"><is><t>02</t></is></c></row>`;
  const f=await fixture(zipParts(workbookParts(rows,{'xl/styles.xml':style('0;0;0;"QTY "@')}))),app=await f.launch();
  try {
    const page=await app.firstWindow();await openImport(page,'first');await pick(app,page,f.source);
    await expect(page.getByRole('region',{name:'取込確認'})).toContainText('材料候補 0件 / 要確認・保留 1件');await capture(page,'review-text-format-held');
    // 取消すと材料タブの取込履歴へ戻るため、拒否されるファイルはウィザードを開き直して選ぶ（解析エラーはファイル選択の段階に留まる）。
    await page.getByRole('button',{name:'この取込を取り消す',exact:true}).click();await openImport(page,'first');
    for(const [name,parts,message] of [
      ['shared',workbookParts(`<row r="2">${textCell('A2','架空')}${textCell('B2','型')}<c r="D2"><f t="shared" si="0" ref="D2:D3">1+1</f><v>2</v></c></row>`),'属性付きの数式'],
      ['format-limit',workbookParts(rows,{'xl/styles.xml':style('X'.repeat(1024*1024))}),'書式情報が上限'],
    ] as const){const file=path.join(f.root,`${name}.xlsx`);await writeFile(file,zipParts(parts,true));await pick(app,page,file);await expect(wizard(page).getByRole('alert')).toContainText(message);await capture(page,`review-${name}-rejected`);}
    const db=f.database();try{expect(db.prepare('SELECT count(*) n FROM import_batches').get()).toEqual({n:1});expect(db.prepare('SELECT count(*) n FROM import_items').get()).toEqual({n:3});expect(db.prepare('SELECT count(*) n FROM materials').get()).toEqual({n:0});}finally{db.close();}
  }finally{await app.close();await f.cleanup();}
});
