import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { fixture, capture, subject } from './app';
import { workbookParts, zipParts } from '../fixtures/xlsx';
import { evidencePath } from './evidence';
import type { MaterialSave } from '../../src/shared/master-api';
for(const existing of [false,true])test(`manual save reply loss retries one request with existing category ${existing}`,async()=>{
  const f=await fixture(zipParts(workbookParts('')));let app=await f.launch();
  try{let page=await app.firstWindow();if(existing){const db=f.database();try{db.prepare('INSERT INTO categories(id,name,sort_order,active) VALUES(?,?,0,1)').run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as never,'既存架空' as never);}finally{db.close();}}
    await page.getByRole('button',{name:'材料',exact:true}).click();await page.getByRole('button',{name:'手動で追加',exact:true}).click();
    // 編集ドロワー（dialog）内にスコープする。旧 .editor-fields は fieldset（group 材料の値）。
    const drawer=page.getByRole('dialog',{name:'材料を手動追加'}),fields=drawer.getByRole('group',{name:'材料の値'});
    if(!existing)await drawer.getByLabel('新しいカテゴリ名',{exact:true}).fill('架空再送カテゴリ');
    await drawer.getByLabel('品名',{exact:true}).fill(' 架空再送部品 ');await drawer.getByLabel('型式',{exact:true}).fill('001-再送');
    // 保存は本体で確定させたうえで、最初の応答だけを失わせる（画面には失敗が届く）。送った要求は呼出しの記録から取り出す。
    await app.intercept('master:save',{dropFirst:true});
    await drawer.getByRole('button',{name:'材料を保存',exact:true}).click();await expect(drawer.getByRole('alert')).toBeVisible();await expect(fields).toHaveJSProperty('disabled',true);expect(await fields.locator('textarea').first().evaluate(el=>el.matches(':disabled'))).toBe(true);await expect(drawer.getByLabel('有効（外すと検索の既定結果から除外）')).toBeDisabled();
    for(const width of [1280,760]){await drawer.getByRole('alert').scrollIntoViewIfNeeded();await capture(page,`retry-uncertain-${existing}`,width);await drawer.getByRole('button',{name:'保存結果を後で確認して閉じる'}).scrollIntoViewIfNeeded();await capture(page,`retry-actions-${existing}`,width);}
    const request=(await app.events()).filter(event=>event.type==='call'&&event['channel']==='master:save').map(event=>(event['args'] as readonly MaterialSave[])[0]).at(-1);if(!request)throw new Error('request');
    const count=()=>{const db=f.database();try{return {materials:db.prepare('SELECT count(*) n FROM materials').get(),categories:db.prepare('SELECT count(*) n FROM categories').get(),receipts:db.prepare('SELECT count(*) n FROM material_create_receipts').get()};}finally{db.close();}};
    expect(count()).toEqual({materials:{n:1},categories:{n:1},receipts:{n:1}});
    await drawer.getByRole('button',{name:'材料を保存',exact:true}).click();await expect(page.getByText('材料を保存しました。',{exact:true})).toBeVisible();expect(count()).toEqual({materials:{n:1},categories:{n:1},receipts:{n:1}});await capture(page,`retry-saved-${existing}`);
    await app.close();app=await f.launch();page=await app.firstWindow();const replay=await page.evaluate(r=>window.appApi.master.save(r),request);expect(replay.status).toBe('ok');expect(count()).toEqual({materials:{n:1},categories:{n:1},receipts:{n:1}});
    const separate=await page.evaluate(async r=>{const form=await window.appApi.master.get(null);if(form.status!=='ok'||!form.data.createRequestId)throw new Error('new');return window.appApi.master.save({...r,createRequestId:form.data.createRequestId});},request);expect(separate.status).toBe('ok');expect(count().materials).toEqual({n:2});expect(count().categories).toEqual({n:existing?1:2});
    await writeFile(evidencePath(`retry-${existing}-result.json`),JSON.stringify({...subject(),responseLossAfterCommit:true,frozenInput:true,retryOneMaterial:true,restartSameRequest:true,explicitNewSeparate:true,automaticDraftRestore:false},null,2));
  }finally{await app.close();await f.cleanup();}
});
