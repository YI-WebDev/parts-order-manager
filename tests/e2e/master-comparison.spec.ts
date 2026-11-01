import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, pick, confirm, capture, openImport } from './app';
import { textCell, workbookParts, zipParts } from '../fixtures/xlsx';
import { evidencePath } from './evidence';
// Excel のセルの値（原セル）。登録・比較する取込値は前後の空白を除いた形（文中の改行・ゼロはそのまま）になる（利用者の指示、2026年10月15日）。
const original=[' 架空品 ','001-A','  ','','一行'+String.fromCharCode(10)+'二行','0'];
const registered=original.map(v=>v.trim());
const changed=['架空品X','1-A','架空社','0','一行二行',''];
const book=(values:readonly string[])=>zipParts(workbookParts('<row r="2">'+values.map((v,i)=>textCell(String.fromCharCode(65+i)+'2',v)).join('')+'</row>'));
test('material comparison trims edge spaces but preserves newline and zeros and updates its baseline only on confirmed reimport',async()=>{
  const f=await fixture(book(original)),app=await f.launch();
  try{const page=await app.firstWindow();await openImport(page,'first');await pick(app,page,f.source);await page.getByRole('button',{name:'候補をすべて選択'}).click();await confirm(page);
    const id=await page.evaluate(async()=>{const r=await window.appApi.materials.search({query:'',categoryId:null,includeInactive:false,offset:0});if(r.status!=='ok'||!r.data.rows[0])throw new Error('fixture');return r.data.rows[0].id;});
    // 旧「検索結果の選択 →この材料を編集」は、材料台帳の行の編集ボタン →編集ドロワーに置き換わった。
    const table=page.getByRole('table',{name:'材料台帳'}),drawer=page.getByRole('dialog',{name:'材料を編集'});
    await page.getByRole('button',{name:'材料',exact:true}).click();await table.getByRole('row').filter({hasText:'001-A'}).getByRole('button',{name:/架空品\s*を編集$/}).click();
    await expect(drawer.getByText('前回確認済み取込値と現在値を比較',{exact:true})).toBeVisible({timeout:2000});await drawer.getByText('前回確認済み取込値と現在値を比較',{exact:true}).click();
    const rows=drawer.locator('.material-comparison tbody tr');await expect(rows).toHaveCount(6);await expect(drawer.locator('.material-comparison').getByText('一致',{exact:true})).toHaveCount(6);
    await rows.first().scrollIntoViewIfNeeded();await capture(page,'comparison-unchanged');
    const labels=['品名','型式','メーカー','数量','備考','単価'];for(const [i,label] of labels.entries())await drawer.getByRole('textbox',{name:label,exact:true}).fill(changed[i]??'');
    await expect(drawer.locator('.material-comparison').getByText('変更あり',{exact:true})).toHaveCount(6);
    await drawer.getByRole('checkbox',{name:'空白・改行を記号で表示（JSON）'}).check();
    for(let i=0;i<6;i++){expect(await rows.nth(i).locator('td').nth(1).textContent()).toBe(JSON.stringify(registered[i]));expect(await rows.nth(i).locator('td').nth(2).textContent()).toBe(JSON.stringify(changed[i]));}
    for(const width of [1280,760]){await page.setViewportSize({width,height:800});await rows.first().scrollIntoViewIfNeeded();await capture(page,'comparison-changed-top',width);await rows.last().scrollIntoViewIfNeeded();await capture(page,'comparison-changed-bottom',width);}
    await drawer.getByRole('button',{name:'材料を保存',exact:true}).click();await expect(page.getByText('材料を保存しました。',{exact:true})).toBeVisible();
    const prior=await page.evaluate(async id=>{const r=await window.appApi.master.get(id);if(r.status!=='ok')throw new Error('get');return r.data.material;},id);expect(prior?.source?.values).toEqual(registered);
    const incoming=[...original];incoming[1]='0009-NEW';const file=path.join(f.root,'架空比較更新.xlsx');await writeFile(file,book(incoming));
    const series=await page.evaluate(async()=>{const r=await window.appApi.master.series();if(r.status!=='ok'||!r.data[0])throw new Error('series');return r.data[0].id;});await app.dialog('open',file);
    const updated=await page.evaluate(async({series,id})=>{const r=await window.appApi.master.choose(series);if(r.status!=='ok')throw new Error('stage');return window.appApi.master.apply({batchId:r.data.batch.id,choices:r.data.rows.map(row=>row.source.classification==='candidate'?{itemId:row.source.id,action:'map',materialId:id,fields:[]}:{itemId:row.source.id,action:'hold'}),inactiveIds:[],confirmed:true});},{series,id});expect(updated.status).toBe('ok');
    await table.getByRole('row').filter({hasText:'1-A'}).getByRole('button',{name:'架空品Xを編集',exact:true}).click();await drawer.getByText('前回確認済み取込値と現在値を比較',{exact:true}).click();
    await drawer.getByRole('checkbox',{name:'空白・改行を記号で表示（JSON）'}).check();expect(await rows.nth(1).locator('td').nth(1).textContent()).toBe(JSON.stringify('0009-NEW'));expect(await rows.nth(1).locator('td').nth(2).textContent()).toBe(JSON.stringify('1-A'));await rows.nth(1).scrollIntoViewIfNeeded();await capture(page,'comparison-new-baseline');
    // 旧注記「手動作成のため、比較する元取込値はありません。」は新ドロワーにない。出典表示「手動作成」と比較欄が無いことで確認する。
    await drawer.getByRole('button',{name:'編集を取り消す'}).click();await page.getByRole('button',{name:'手動で追加',exact:true}).click();
    const manual=page.getByRole('dialog',{name:'材料を手動追加'});await expect(manual.locator('.drawer-head')).toContainText('手動作成');await expect(manual.getByText('前回確認済み取込値と現在値を比較',{exact:true})).toHaveCount(0);await expect(manual.locator('.material-comparison')).toHaveCount(0);await capture(page,'comparison-manual-none');
    await writeFile(evidencePath('comparison-result.json'),JSON.stringify({unchangedSix:true,changedSix:true,exactRawStrings:true,edgeSpacesTrimmed:true,newBaseline:true,manualNoSource:true,osPicker:'mock'},null,2));
  }finally{await app.close();await f.cleanup();}
});
