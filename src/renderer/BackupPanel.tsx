import { useEffect, useState } from 'react';
import type { BackupInspection, BackupResult } from '../shared/backup-api';

const DAY = 24 * 60 * 60 * 1000;
const dateFormat = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export function BackupPanel({ disabled, run }: { readonly disabled: boolean; readonly run: (action: () => Promise<void>) => Promise<void> }) {
  const [inspection, setInspection] = useState<BackupInspection | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [last, setLast] = useState<{ readonly loaded: boolean; readonly at: number | null; readonly days: number | null }>({ loaded: false, at: null, days: null }), [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let active = true;
    void window.appApi.backups.status().then(result => {
      if (!active) return;
      const at = result.status === 'ok' && result.data.lastCreatedAt !== null ? new Date(result.data.lastCreatedAt).getTime() : NaN;
      setLast(Number.isNaN(at) ? { loaded: true, at: null, days: null } : { loaded: true, at, days: Math.floor((Date.now() - at) / DAY) });
    }, () => { if (active) setLast({ loaded: true, at: null, days: null }); });
    return () => { active = false; };
  }, [epoch]);
  function result<T>(value: BackupResult<T>, success: (data: T) => void): void {
    switch (value.status) {
      case 'ok': success(value.data); break;
      case 'cancelled': setFeedback({ error: false, text: '取り消しました。現在のデータは変更していません。' }); break;
      case 'error': setFeedback({ error: true, text: value.message }); break;
    }
  }
  async function perform(action: () => Promise<void>): Promise<void> {
    await run(async () => { setFeedback(null); try { await action(); } catch { setFeedback({ error: true, text: '応答を確認できませんでした。復元操作中ならアプリを終了し、もう一度起動して切替状態を確認してください。DBや退避ファイルは削除しないでください。' }); } });
  }
  const days = last.days;
  const stale = days === null || days >= 7;
  return <section className="stack backup-panel" aria-labelledby="backup-heading" aria-busy={disabled}>
    <h2 id="backup-heading">バックアップと復元</h2>
    <p>材料・請求書・原記録・判断履歴・保留項目・設定をまとめて保存します。元Excelや出力した帳票は含みません。</p>
    <div className="card settings-list">
      <div>
        <div className="grow"><span className="strong">バックアップを保存</span>
          {last.loaded && <span className={stale ? 'stale' : 'note'}>{days === null ? 'この端末で作成したバックアップの記録はありません' : `最終バックアップ ${dateFormat.format(new Date(last.at ?? 0))}（${days === 0 ? '今日' : `${days}日前`}）`}</span>}</div>
        <button disabled={disabled} className="btn primary" onClick={() => { void perform(async () => result(await window.appApi.backups.create(), text => { setFeedback({ error: false, text }); setEpoch(n => n + 1); })); }}>今すぐ保存</button>
      </div>
      <div>
        <div className="grow"><span className="strong">バックアップから復元</span><span className="note">ファイルを検査してから復元します。検査だけでは変更しません。</span></div>
        <button disabled={disabled} className="btn" onClick={() => { void perform(async () => { setInspection(null); result(await window.appApi.backups.inspect(), data => { setInspection(data); setFeedback({ error: false, text: '検査が完了しました。まだ復元していません。' }); }); }); }}>ファイルを選んで検査</button>
      </div>
      {inspection && <div className="inspection" aria-labelledby="inspection-heading">
        <h3 id="inspection-heading">検査したバックアップ</h3>
        <span className="strong">作成日時（UTC）{inspection.createdAt} ・ 材料 {inspection.materials}件 ・ 請求書 {inspection.documents}件</span>
        <span>現在の全データを退避して置き換え、アプリを終了します。次の確認画面で「戻る」を選ぶと変更しません。</span>
        <button className="btn danger" disabled={disabled} onClick={() => { void perform(async () => result(await window.appApi.backups.restore(inspection.id), () => { setInspection(null); setFeedback({ error: false, text: 'アプリを終了します。もう一度起動してください。' }); })); }}>このバックアップへ復元</button>
      </div>}
    </div>
    {disabled && <p role="status" className="status-line">処理しています。完了するまでお待ちください。</p>}
    {feedback && (feedback.error ? <p role="alert">{feedback.text}</p> : <p role="status" className="notice">{feedback.text}</p>)}
    <p className="note">暗号化されていない平文です。業務情報を含むため、アクセスできる人と保管先に注意してください。同じWindowsユーザーの別アプリや管理者からの保護はありません。</p>
    <details><summary>移行範囲・保存先・回復の注意</summary><div className="stack gap-8">
      <p>対応する同じアプリ版・DB版・帳票レイアウトのWindows x64環境へ移行できます。フォント・プリンター・出力済み帳票・元Excel・Windowsの設定は移行しません。</p>
      <p>保存は新しい.pombak名を使い、既存ファイルは上書きしません。ローカルの通常ドライブを使用してください。UNCは拒否しますが、ドライブ文字に割り当てたネットワーク・同期先まで厳密には判別しません。</p>
      <p>DBは128MiBまでの非圧縮形式です。チェックサムは破損検出用で、作成者の真正性は保証しません。信頼できるバックアップだけを選んでください。</p>
      <p>検査用コピーと復元前の退避にも平文が残ります。アプリの保存場所ごと安全に保管してください。途中終了は次回起動で切替記録から回復しますが、ディスク故障や電源断によるファイル破損まで損失ゼロを保証しません。起動できなければDB・退避・復元記録を削除せず保全してください。</p>
    </div></details>
  </section>;
}
