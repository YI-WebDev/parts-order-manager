import { useEffect, useRef, useState } from 'react';
import { QUERY_MAX_LENGTH } from '../shared/limits';
import type { DragEvent } from 'react';
import type { ImportResult, ImportReview, ImportRow } from '../shared/import-api';
import { MATERIAL_FIELDS } from '../shared/master-api';
import type { ManagedMaterial, ReimportChoice, ReimportReview, ReimportRow, SourceAssignment } from '../shared/master-api';
import { fieldLabels } from './MaterialManager';
import type { WizardStart } from './MaterialManager';
import type { Notify } from './InvoicePanel';

type Kind = 'first' | 're';
const cellNames = ['品名', '形式又はタイプ', 'メーカー', '数量', '備考', '単価'];
const statusLabels = { preview: '確認中', applied: '確定済み', cancelled: '取消', failed: '保存失敗' } as const;
const tags = { candidate: ['材料候補', 'ok'], held: ['要確認', 'warn'], supplement: ['補足保留', 'warn'], header: ['除外', ''] } as const;
const comparisons = { same: ['同内容', 'ok'], changed: ['変更あり', 'ok'], ambiguous: ['複数候補・要判断', 'warn'], unmatched: ['対応なし', 'warn'], held: ['保留・表示要確認', 'warn'] } as const;
const blockName = (block: string): string => block === 'left' ? '左' : block === 'right' ? '右' : block;
function cellRange(item: ImportRow): string {
  const columns = item.cells.map(cell => cell.column).filter(Boolean);
  const first = columns[0], last = columns[columns.length - 1];
  return first && last ? `${item.sheetName} ${first}${item.rowIndex}${last !== first ? `:${last}${item.rowIndex}` : ''}` : `${item.sheetName} ${item.rowIndex}行`;
}
/** 採用できる行か（本体の imports:apply と同じ判定）。材料候補に加え、要確認・列見出しの行も品名があれば確認のうえで採用できる。補足セルと品名のない行は採用しない。 */
const adoptable = (item: ImportRow): boolean => item.classification !== 'supplement' && !item.applied && (item.values[0] ?? '').trim() !== '';
/** 採用できない理由（チェックボックスを押せない行に表示する）。 */
const lockedReason = (item: ImportRow): string => item.applied ? '' : item.classification === 'supplement' ? '補足セルは材料にできません' : '品名がないため採用できません';
function formatSize(bytes: number): string { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }

function CellDetails({ item }: { readonly item: ImportRow }) {
  return <details><summary>原セルを確認</summary><div className="cell-details">
    <p className="note">{item.sheetName} / {item.rowIndex}行 / {blockName(item.block)} ・ {item.reason}</p>
    <dl className="stack gap-8">{item.cells.map((cell, index) => <div key={cell.column}>
      <dt>{item.classification === 'supplement' ? cell.column : cellNames[index]}（{cell.column}）</dt>
      <dd className="original-text">{cell.displayText === '' ? '（空欄）' : cell.displayText}</dd>
      <dd className="note original-text">元値: {cell.rawValue === null ? '（値なし）' : cell.rawValue === '' ? '（空文字）' : cell.rawValue} / {cell.kind} / {cell.presence === 'missing' ? 'セル未定義' : 'セルあり'}{cell.formatCode ? ` / 書式: ${cell.formatCode}` : ''}{!cell.displayVerified ? ' / 表示要確認' : ''}</dd>
    </div>)}</dl>
  </div></details>;
}

export function ImportWizard({ start, onBusyChange, onExit, notify }: { readonly start: WizardStart; readonly onBusyChange: (busy: boolean) => void; readonly onExit: (view: 'ledger' | 'history') => void; readonly notify: Notify }) {
  const [kind, setKind] = useState<Kind>(start?.kind ?? 'first'), [step, setStep] = useState(start ? 2 : 0);
  const [series, setSeries] = useState<readonly { readonly id: string; readonly label: string }[] | null>(null), [seriesId, setSeriesId] = useState('');
  const [dropped, setDropped] = useState<File | null>(null), [dragging, setDragging] = useState(false), [fileError, setFileError] = useState('');
  const [first, setFirst] = useState<ImportReview | null>(null), [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set()), [filter, setFilter] = useState<'all' | 'candidate' | 'held' | 'header'>('all');
  const [re, setRe] = useState<ReimportReview | null>(null), [choices, setChoices] = useState<ReadonlyMap<string, ReimportChoice>>(new Map()), [inactive, setInactive] = useState<ReadonlySet<string>>(new Set());
  const [page, setPage] = useState(0), [reFilter, setReFilter] = useState<'needed' | 'all'>('needed'), [decisionPage, setDecisionPage] = useState(0), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(start !== null), [message, setMessage] = useState(''), [error, setError] = useState('');
  const lock = useRef(false), composing = useRef(false), errorElement = useRef<HTMLParagraphElement>(null);
  const review = kind === 'first' ? first?.batch : re?.batch;
  const preview = review?.status === 'preview';
  useEffect(() => { onBusyChange(busy || (kind === 're' && re?.batch.status === 'preview')); return () => onBusyChange(false); }, [busy, kind, re, onBusyChange]);
  useEffect(() => { if (error) errorElement.current?.focus(); }, [error]);
  useEffect(() => {
    let active = true;
    void window.appApi.master.series().then(result => { if (!active) return; if (result.status === 'ok') { setSeries(result.data); setSeriesId(current => current || (result.data.length === 1 ? result.data[0]?.id ?? '' : '')); } else { setSeries([]); if (result.status === 'error') setMessage(result.message); } }, () => { if (active) setSeries([]); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!start) return;
    void execute(() => start.kind === 'first' ? window.appApi.imports.review(start.batchId) : window.appApi.master.review(start.batchId), start.kind, '取込記録を開いています…');
    // 初回表示時だけ開く。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadFirst(value: ImportReview): void { setFirst(value); setAccepted(new Set(value.items.filter(item => item.classification === 'candidate' && !item.applied).map(item => item.id))); setConfirmed(false); setPage(0); setFilter('all'); }
  function loadRe(value: ReimportReview): void { setRe(value); setChoices(new Map(value.rows.map(row => [row.source.id, { itemId: row.source.id, action: 'hold' }]))); setInactive(new Set()); setConfirmed(false); setPage(0); setReFilter('needed'); setDecisionPage(0); }
  /** 既存の取込・更新取込パネルと同じ結果処理。kindを明示して古い状態との取り違えを防ぐ。 */
  async function execute(action: () => Promise<ImportResult<ImportReview | ReimportReview>>, target: Kind, working: string, applying = false): Promise<'ok' | 'cancelled' | 'error'> {
    if (lock.current || composing.current) { setBusy(lock.current); return 'error'; }
    lock.current = true; setBusy(true); setMessage(working); setError('');
    try {
      const result = await action();
      switch (result.status) {
        case 'ok': {
          if (target === 'first') { const data = result.data as ImportReview; loadFirst(data); setMessage(data.batch.status === 'applied' ? `反映 ${data.batch.counts.applied}件・保留 ${data.batch.counts.held}件・補足保留 ${data.batch.counts.supplements}件` : data.batch.status === 'preview' ? '確認内容を保存しました。材料への反映は確定操作後です。' : ''); }
          else { const data = result.data as ReimportReview; loadRe(data); setMessage(data.batch.status === 'applied' ? '確定済みの取込です。重複して反映しません。' : data.batch.status === 'preview' ? '原記録を保存しました。まだ材料へ反映していません。' : ''); }
          return 'ok';
        }
        case 'cancelled': setMessage('ファイル選択を取り消しました。'); return 'cancelled';
        case 'error':
          setError(result.message); setMessage('');
          if (applying && target === 're' && result.code === 'CONFLICT') setRe(current => current ? { ...current, stale: true } : null);
          if (target === 'first' && first) { const current = await window.appApi.imports.review(first.batch.id); if (current.status === 'ok') setFirst(current.data); }
          return 'error';
      }
    } catch { setError('処理結果を確認できませんでした。取込履歴を開いて状態を確認してください。原記録と入力は保持されています。'); setMessage(''); return 'error'; }
    finally { lock.current = false; setBusy(false); }
  }

  async function choose(file: File | null): Promise<void> {
    if (kind === 're' && !seriesId) { setFileError('先に更新する取込元を選んでください。'); return; }
    const outcome = await execute(() => kind === 'first' ? (file ? window.appApi.imports.chooseFile(file) : window.appApi.imports.choose()) : (file ? window.appApi.master.chooseFile(seriesId, file) : window.appApi.master.choose(seriesId)), kind, 'Excelを解析しています…');
    if (outcome === 'ok') { setDropped(null); setStep(2); }
  }
  function dropFile(event: DragEvent<HTMLButtonElement>): void {
    event.preventDefault(); setDragging(false);
    if (busy || staged) return;
    const files = event.dataTransfer.files;
    const file = files.length === 1 ? files[0] : undefined;
    if (!file) { setFileError('ファイルを1つだけドロップしてください。'); return; }
    if (!file.name.toLowerCase().endsWith('.xlsx')) { setFileError('.xlsxファイルを選んでください。古い形式（.xls）やCSVは取り込めません。'); setDropped(null); return; }
    setFileError(''); setDropped(file);
  }
  const staged = kind === 'first' ? first !== null : re !== null;
  const exit = (view: 'ledger' | 'history'): void => {
    if (re?.batch.status === 'preview') notify('原記録は取込履歴に保持しています。未確定の選択は保存していません。');
    else if (first?.batch.status === 'preview') notify('確認中の取込は取込履歴から再開できます。');
    onExit(view);
  };
  async function cancelImport(): Promise<void> {
    if (!review || !preview) { onExit('ledger'); return; }
    const outcome = await execute(() => kind === 'first' ? window.appApi.imports.cancel(review.id) : window.appApi.master.cancel(review.id), kind, '取込を取り消しています…');
    if (outcome === 'ok') { notify('取込を取り消しました。原記録は取込履歴に保持しています。'); onExit('history'); }
  }
  async function resume(): Promise<void> {
    if (!review) return;
    const outcome = await execute(() => kind === 'first' ? window.appApi.imports.resume(review.id) : window.appApi.master.resume(review.id), kind, '未反映の候補を開いています…');
    if (outcome === 'ok') setStep(2);
  }
  async function apply(): Promise<void> {
    if (!review || !preview || !confirmed || (kind === 're' && re?.stale)) return;
    if (kind === 'first') await execute(() => window.appApi.imports.apply({ batchId: review.id, acceptedIds: [...accepted] }), 'first', '材料を保存しています…');
    else if (re) await execute(() => window.appApi.master.apply({ batchId: review.id, choices: [...choices.values()], inactiveIds: [...inactive], confirmed: true }), 're', '確定内容を反映しています…', true);
  }
  async function next(): Promise<void> {
    if (step === 0) { setStep(1); return; }
    if (step === 1) { if (dropped) await choose(dropped); else if (staged) setStep(2); return; }
    if (step === 2) { setStep(3); return; }
    await apply();
  }

  const applied = review !== undefined && !preview;
  const candidateCount = first?.items.filter(item => item.classification === 'candidate' && !item.applied).length ?? 0;
  // 確認中でない記録から再確認できない理由（本体が imports:resume・reimport:resume と同じ条件で返す）。
  const resumeBlocked = (kind === 'first' ? first?.resumeBlocked : re?.resumeBlocked) ?? null;
  const heldCount = first ? first.batch.counts.held + first.batch.counts.supplements : 0;
  const acceptedAs = (classification: ImportRow['classification']): number => first?.items.filter(item => item.classification === classification && accepted.has(item.id)).length ?? 0;
  const acceptedCandidates = acceptedAs('candidate'), acceptedHeld = acceptedAs('held'), acceptedOthers = accepted.size - acceptedCandidates;
  const reApply = [...choices.values()].filter(choice => choice.action !== 'hold').length;
  const reRows = re?.rows.filter(row => row.source.classification !== 'header') ?? [];
  const nextLocked = busy || (step === 1 && !dropped && !staged) || (step === 1 && kind === 're' && !seriesId && !staged) || (step === 3 && (!confirmed || (kind === 're' && re?.stale === true)));
  const nextLabel = step === 3 ? (kind === 're' ? '確認した内容を確定適用' : '選択した候補を確定') : step === 1 ? '解析して次へ' : '次へ';
  const stepLabels = ['種類', 'ファイル', kind === 're' ? '差分を確認' : '内容を確認', '確定'];

  return <div className="page page-wizard" role="region" aria-label="Excelから取込" aria-busy={busy} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
    <div className="row gap-12"><button className="btn text" disabled={busy} onClick={() => exit('ledger')}>← 材料へ戻る</button><h1>Excelから取込</h1></div>
    <ol className="steps" aria-label="取込の手順">{stepLabels.map((label, index) => <li key={label} className={index < step ? 'done' : index === step ? 'current' : undefined} aria-current={index === step ? 'step' : undefined}>{index + 1}. {label}</li>)}</ol>
    {message && <p role="status" className="status-line">{message}</p>}
    {error && <p ref={errorElement} role="alert" tabIndex={-1}>{error}</p>}

    {step === 0 && <section className="stack" aria-labelledby="wizard-kind">
      <h2 id="wizard-kind">何を取り込みますか</h2>
      {([['first', '新しいExcelを初回取込', '材料候補を確認して登録します。シートは同名のカテゴリになります（既存カテゴリへ自動統合しません）。'], ['re', '変更したExcelで更新', '以前取り込んだExcelの変更版から、差分と対応関係を確認して反映します。手動作成材料や過去の請求書は変わりません。']] as const).map(([key, label, desc]) =>
        <button key={key} className="choice-card" aria-pressed={kind === key} disabled={busy} onClick={() => { if (kind !== key) { setKind(key); setDropped(null); setFileError(''); } }}><span className="choice-title">{label}</span><span className="choice-desc">{desc}</span></button>)}
      {kind === 're' && series !== null && series.length === 0 && <p className="note">更新できる取込元がありません。先に初回取込を確定してください。</p>}
      <p className="note">元のExcelは変更しません。要確認行と列見出しの行は既定では保留しますが、内容を確認してチェックすれば採用できます。G列などの補足セルは採用しません。</p>
    </section>}

    {step === 1 && <section className="stack" aria-labelledby="wizard-file">
      <h2 id="wizard-file">Excelファイルを選択</h2>
      {kind === 're' && <label className="labelled narrow"><span className="label-text">更新する取込元</span><select className="field" value={seriesId} disabled={busy || staged} onChange={event => { setSeriesId(event.target.value); setFileError(''); }}><option value="">選択してください</option>{(series ?? []).map(s => <option key={s.id} value={s.id}>{s.label} / {s.id.slice(0, 8)}</option>)}</select></label>}
      <button className={`drop-zone${dragging ? ' dragging' : ''}${dropped || staged ? ' chosen' : ''}`} disabled={busy || staged || (kind === 're' && !seriesId)} aria-describedby="drop-help"
        onClick={() => { setFileError(''); void choose(null); }}
        onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = busy || staged ? 'none' : 'copy'; if (!dragging) setDragging(true); }}
        onDragLeave={() => setDragging(false)} onDrop={dropFile}>
        <span>{staged ? `解析済み: ${review?.displayName ?? ''}` : dropped ? dropped.name : 'ここにExcel（.xlsx）をドロップ、またはクリックして選択'}</span>
        <span id="drop-help" className="note">{staged ? '別のファイルにする場合は「この取込を取り消す」で取り消してから選び直してください。' : dropped ? `${formatSize(dropped.size)} ・ 「解析して次へ」で内容を確認します` : 'クリックするとファイルを選んで解析し、内容の確認へ進みます。元のExcelは変更しません。'}</span>
      </button>
      {fileError && <p role="alert">{fileError}</p>}
    </section>}

    {step >= 2 && kind === 'first' && first && <FirstReview review={first} accepted={accepted} filter={filter} page={page} busy={busy} step={step}
      setFilter={value => { setFilter(value); setPage(0); }} setPage={setPage} onResume={() => { void resume(); }} reopened={start === null}
      setAccepted={value => { setAccepted(value); setConfirmed(false); }}/>}
    {step >= 2 && kind === 're' && re && <ReReview review={re} rows={reRows} choices={choices} inactive={inactive} filter={reFilter} page={page} decisionPage={decisionPage} busy={busy} step={step}
      setFilter={value => { setReFilter(value); setPage(0); }} setPage={setPage} setDecisionPage={setDecisionPage} onResume={() => { void resume(); }} reopened={start === null}
      onChange={choice => { setChoices(old => new Map(old).set(choice.itemId, choice)); setConfirmed(false); if (choice.action === 'map') setInactive(old => new Set([...old].filter(id => id !== choice.materialId))); }}
      onInactive={(id, on) => { setInactive(old => { const n = new Set(old); if (on) n.add(id); else n.delete(id); return n; }); setConfirmed(false); }}/>}

    {step === 3 && review && <section className="card padded stack gap-16" aria-labelledby="wizard-confirm">
      <h2 id="wizard-confirm">確定して反映</h2>
      <dl className="summary-cards">{(kind === 'first'
        ? [['登録する候補', applied ? first?.batch.counts.applied ?? 0 : accepted.size, 'ok'], ['未選択（保留）', applied ? 0 : candidateCount - acceptedCandidates, ''], ['要確認・補足（保留）', applied ? heldCount : heldCount - acceptedHeld, 'warn']]
        : [['反映する行', applied ? re?.batch.counts.applied ?? 0 : reApply, 'ok'], ['保留', applied ? 0 : reRows.length - reApply, ''], ['無効にする材料', inactive.size, 'warn']]).map(([label, n, tone]) =>
        // 注意の色は、保留・無効化する行があるときだけ付ける（0件を警告の色で出さない）。
        <div key={label} className={tone === 'warn' && n === 0 ? undefined : String(tone) || undefined}><dt>{label}</dt><dd>{n}件</dd></div>)}</dl>
      {!applied && <p>{kind === 'first' ? `選択した候補 ${accepted.size}件を登録します${acceptedOthers > 0 ? `（うち要確認・除外から選んだ行 ${acceptedOthers}件）` : ''}。未選択 ${candidateCount - acceptedCandidates}件と、選んでいない要確認・補足・除外は保留します。` : `反映する行 ${reApply}件 / 明示的な無効化 ${inactive.size}件。それ以外は保留し、現在の材料を変更しません。`}</p>}
      <label className="check-control"><input type="checkbox" checked={confirmed || applied} disabled={applied || busy || (kind === 're' && re?.stale === true)} onChange={event => setConfirmed(event.target.checked)}/>{kind === 'first' ? '件数と内容を確認しました' : '対応関係・反映する項目・保留・無効化を確認しました'}</label>
      {review.status === 'applied' && <p role="status" className="notice">{kind === 'first' ? `材料を登録しました（反映 ${first?.batch.counts.applied ?? 0}件）。` : `確認した内容を反映しました（反映 ${re?.batch.counts.applied ?? 0}件）。`}</p>}
      {applied && review.status !== 'applied' && <p className="note">この取込は{statusLabels[review.status]}です。</p>}
      {applied && resumeBlocked === null && <button className="btn medium" disabled={busy} onClick={() => { void resume(); }}>{review.status === 'cancelled' ? '最初から確認し直す' : kind === 're' ? '未反映分を再確認' : '未反映の候補を再確認'}</button>}
    </section>}

    <div className="wizard-footer">
      {applied || (step >= 2 && !staged && !busy)
        ? <button className="btn primary push-end" disabled={busy} onClick={() => onExit('ledger')}>材料台帳を開く</button>
        : <>
          {/* 取り消す記録（解析した確認中の取込）がまだないうちは出さない（戻るだけの操作を、取消の色で出さない）。 */}
          {review && <button className="btn danger" disabled={busy} onClick={() => { void cancelImport(); }}>この取込を取り消す</button>}
          <button className="btn push-end" disabled={busy} onClick={() => { if (step === 0 || (step === 2 && start)) exit('ledger'); else setStep(step - 1); }}>戻る</button>
          <button className="btn primary" disabled={nextLocked} onClick={() => { void next(); }}>{nextLabel}</button>
        </>}
    </div>
  </div>;
}

function Pager({ page, size, total, unit, busy, setPage }: { readonly page: number; readonly size: number; readonly total: number; readonly unit: string; readonly busy: boolean; readonly setPage: (page: number) => void }) {
  if (total <= size) return null;
  const pages = Math.ceil(total / size);
  return <div className="pager"><button className="btn medium" disabled={busy || page === 0} onClick={() => setPage(page - 1)}>前の{size}{unit}</button><span className="status-line">{page + 1} / {pages}ページ（{total}{unit}）</span><button className="btn medium" disabled={busy || page + 1 >= pages} onClick={() => setPage(page + 1)}>次の{size}{unit}</button></div>;
}

function FirstReview({ review, accepted, filter, page, busy, step, reopened, setFilter, setPage, setAccepted, onResume }: {
  readonly review: ImportReview; readonly accepted: ReadonlySet<string>; readonly filter: 'all' | 'candidate' | 'held' | 'header'; readonly page: number; readonly busy: boolean; readonly step: number; readonly reopened: boolean;
  readonly setFilter: (value: 'all' | 'candidate' | 'held' | 'header') => void; readonly setPage: (page: number) => void; readonly setAccepted: (value: ReadonlySet<string>) => void; readonly onResume: () => void;
}) {
  const editable = review.batch.status === 'preview' && !busy;
  const count = (value: typeof filter): number => review.items.filter(item => value === 'all' || (value === 'held' ? item.classification === 'held' || item.classification === 'supplement' : item.classification === value)).length;
  const visible = review.items.filter(item => filter === 'all' || (filter === 'held' ? item.classification === 'held' || item.classification === 'supplement' : item.classification === filter));
  const sheets = Array.from(new Map(review.items.map(item => [item.sheetOrder, item.sheetName])));
  const counts = review.batch.counts;
  const extra = review.items.filter(item => item.classification !== 'candidate' && accepted.has(item.id)).length;
  if (step === 3) return null;
  return <section className="stack" aria-label="取込確認">
    <div className="row gap-12"><h2 id="wizard-review">内容を確認</h2><span className="muted push-end original-text">{review.batch.displayName} ・ シート{sheets.length} → 同名カテゴリ ・ {statusLabels[review.batch.status]}</span></div>
    <p className="note">材料候補 {counts.candidates}件 / 要確認・保留 {counts.held}件 / 補足保留 {counts.supplements}件 / 除外（見出し）{counts.excluded}件 / 空行ブロック {counts.empty}件 / 反映 {counts.applied}件</p>
    <details><summary>シートとカテゴリの対応</summary><ul>{sheets.map(([order, name]) => <li key={order} className="original-text">{name} → 同名のカテゴリ（同じ名前でも既存カテゴリへ自動統合しません）</li>)}</ul></details>
    {review.batch.status !== 'preview' && <ClosedNotice status={review.batch.status} reopened={reopened} blocked={review.resumeBlocked} busy={busy} onResume={onResume} resumeLabel="未反映の候補を再確認"
      closed={`この取込は${statusLabels[review.batch.status]}です。確定した記録は再反映しません。取消・失敗・未選択の材料候補と、品名のある要確認行は、元の項目を使って再確認できます。`}/>}
    <div className="row"><div className="filter-pills" role="group" aria-label="表示する項目">{([['all', 'すべて'], ['candidate', '材料候補'], ['held', '要確認・補足'], ['header', '除外']] as const).map(([key, label]) => <button key={key} aria-pressed={filter === key} disabled={busy} onClick={() => setFilter(key)}>{label} {count(key)}</button>)}</div>
      {review.batch.status === 'preview' && <div className="row push-end"><button className="btn small" disabled={busy} onClick={() => setAccepted(new Set(review.items.filter(item => item.classification === 'candidate' && !item.applied).map(item => item.id)))}>候補をすべて選択</button><button className="btn small" disabled={busy} onClick={() => setAccepted(new Set())}>選択を解除</button></div>}</div>
    {review.batch.status === 'preview' && <p className="note">チェックを外した行は保留として残ります。要確認・除外の行も、「原セルを確認」で内容を確かめてチェックすれば採用できます（品名のない行と補足セルは採用できません）。</p>}
    {review.batch.status === 'preview' && extra > 0 && <p className="notice" role="status">要確認・除外の行を {extra}件 選んでいます。原セルの値と表示を確認してから確定してください。</p>}
    {visible.length === 0 ? <p className="empty-state">該当する項目はありません。</p> : <ul className="card import-list">{visible.slice(page * 25, (page + 1) * 25).map(item => {
      const selectable = adoptable(item); const tag = item.applied ? ['反映済み', 'ok'] as const : tags[item.classification];
      const label = `${item.sheetName} ${item.rowIndex}行 ${blockName(item.block)}を採用`;
      return <li key={item.id} className={`import-row${selectable ? '' : ' locked'}`}>
        <input id={`import-${item.id}`} type="checkbox" aria-label={label} checked={selectable && accepted.has(item.id)} disabled={!selectable || !editable} onChange={() => { const n = new Set(accepted); if (n.has(item.id)) n.delete(item.id); else n.add(item.id); setAccepted(n); }}/>
        <div className="stack gap-8">
          <label htmlFor={`import-${item.id}`} className="card-title"><span className="row-title">{item.values[0] || '（品名なし）'}</span><span className="note original-text">{[item.values[1] || '型式なし', item.values[2] || 'メーカーなし'].join(' ・ ')} ・ <span className="mono">{cellRange(item)}</span></span></label>
          {!selectable && !item.applied && <span className="note">{lockedReason(item)}</span>}
          <CellDetails item={item}/>
        </div>
        <span className={`badge medium ${tag[1]}`}>{tag[0]}</span>
      </li>;
    })}</ul>}
    <Pager page={page} size={25} total={visible.length} unit="件" busy={busy} setPage={setPage}/>
  </section>;
}

/**
 * 確認中でない記録の案内。取り消した記録は「最初から確認し直す」、確定済み・保存失敗の記録は未反映分の再確認を出す。
 * 再確認できないとき（blocked）はボタンを出さずに理由を示す。reopened: 同じファイルを選び直して前回の記録が開いた。
 */
function ClosedNotice({ status, reopened, closed, blocked, resumeLabel, busy, onResume }: {
  readonly status: keyof typeof statusLabels; readonly reopened: boolean; readonly closed: string; readonly blocked: string | null; readonly resumeLabel: string; readonly busy: boolean; readonly onResume: () => void;
}) {
  const cancelled = status === 'cancelled';
  const lead = reopened ? 'このファイルは前回、確定する前に取り消しています。' : 'この取込は取り消し済みのため、ここからは反映できません。';
  const text = !cancelled ? closed : blocked === null ? `${lead}もう一度取り込む場合は「最初から確認し直す」を押してください。前回の選択は残っておらず、確定するまで材料は変わりません。` : `${lead}この記録からは取り込み直せません。`;
  return <div className="notice stack gap-8"><span>{text}</span>
    {blocked === null ? <button className="btn medium" disabled={busy} onClick={onResume}>{cancelled ? '最初から確認し直す' : resumeLabel}</button> : <span className="note">{blocked}</span>}
  </div>;
}

type ReEntry ={ readonly kind: 'row'; readonly row: ReimportRow } | { readonly kind: 'missing'; readonly material: ManagedMaterial };

/** 確認が必要な行か。前回の取込と全項目が同じ行・反映済みの行・補足セルは除く（品名のない行はExcelの入力漏れかもしれないので残す）。判断を変えた行は常に含める。 */
function needsReview(row: ReimportRow, choice: ReimportChoice | undefined, materials: ReadonlyMap<string, ManagedMaterial>): boolean {
  if (choice && choice.action !== 'hold') return true;
  if (row.source.applied || row.source.classification === 'supplement') return false;
  const base = row.suggestedIds.length === 1 ? materials.get(row.suggestedIds[0] ?? '')?.source : undefined;
  return !(base && base.values.length === row.source.values.length && base.values.every((value, index) => value === row.source.values[index]));
}

/** 新Excelの行と、Excelに見当たらない材料を1つの一覧にする。見当たらない材料は前回あった位置（同名シートの行番号）に並べる。 */
function reEntries(rows: readonly ReimportRow[], missing: readonly ManagedMaterial[]): readonly ReEntry[] {
  const sheets = new Map<string, number>();
  for (const row of rows) if (!sheets.has(row.source.sheetName)) sheets.set(row.source.sheetName, row.source.sheetOrder);
  const key = (item: ImportRow, entry: ReEntry['kind']): readonly [number, number, string, number] =>
    [entry === 'row' ? item.sheetOrder : sheets.get(item.sheetName) ?? Number.MAX_SAFE_INTEGER / 2 + item.sheetOrder, item.rowIndex, item.block, entry === 'missing' ? 0 : 1];
  const keyed = [...rows.map(row => ({ entry: { kind: 'row', row } as ReEntry, key: key(row.source, 'row') })),
    ...missing.flatMap(material => material.source ? [{ entry: { kind: 'missing', material } as ReEntry, key: key(material.source, 'missing') }] : [])];
  return keyed.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2].localeCompare(b.key[2]) || a.key[3] - b.key[3]).map(item => item.entry);
}

function ReReview({ review, rows, choices, inactive, filter, page, decisionPage, busy, step, reopened, setFilter, setPage, setDecisionPage, onChange, onInactive, onResume }: {
  readonly review: ReimportReview; readonly rows: readonly ReimportRow[]; readonly choices: ReadonlyMap<string, ReimportChoice>; readonly inactive: ReadonlySet<string>;
  readonly filter: 'needed' | 'all'; readonly page: number; readonly decisionPage: number; readonly busy: boolean; readonly step: number; readonly reopened: boolean;
  readonly setFilter: (value: 'needed' | 'all') => void; readonly setPage: (page: number) => void; readonly setDecisionPage: (page: number) => void;
  readonly onChange: (choice: ReimportChoice) => void; readonly onInactive: (id: string, on: boolean) => void; readonly onResume: () => void;
}) {
  const editable = review.batch.status === 'preview' && !review.stale && !busy;
  const materials = new Map(review.materials.map(m => [m.id, m]));
  const mappedBy = new Map([...choices.values()].flatMap(c => c.action === 'map' ? [[c.materialId, c.itemId] as const] : []));
  // 見当たらない材料は確認中の取込だけで判断する（確定後は材料が変わっているため出さない）。
  const missing = review.batch.status === 'preview' ? review.missingIds.flatMap(id => materials.get(id) ?? []) : [];
  const entries = reEntries(rows, missing);
  const needed = entries.filter(entry => entry.kind === 'missing' || needsReview(entry.row, choices.get(entry.row.source.id), materials));
  const visible = filter === 'needed' ? needed : entries;
  // 保留に戻した行は「確認が必要」から外れることがあるため、ページを件数内に収める。
  const shown = Math.min(page, Math.max(0, Math.ceil(visible.length / 10) - 1));
  if (step === 3) return review.stale ? <p role="alert">確認後に材料または履歴が変わっています。取込履歴から開き直して再確認してください。</p> : null;
  return <section className="stack" aria-label="差分の確認">
    <div className="row gap-12"><h2 id="wizard-review">差分と対応関係を確認</h2><span className="muted push-end original-text">{review.batch.displayName} ・ {statusLabels[review.batch.status]} ・ 原記録 {review.rows.length}件</span></div>
    <p className="note">すべての行は既定で保留です。変更がある行だけ判断してください。要確認の行も品名があれば判断できます。候補は自動確定しません。行位置だけでは同一材料と判断しないでください。手動作成材料や過去の請求書は変わりません。</p>
    {review.stale && <p role="alert">確認後に材料または履歴が変わっています。再確認が必要です。</p>}
    {review.batch.status !== 'preview' && <ClosedNotice status={review.batch.status} reopened={reopened} blocked={review.resumeBlocked} busy={busy} onResume={onResume} resumeLabel="未反映分を再確認"
      closed={`この取込は${statusLabels[review.batch.status]}です。重複して反映しません。下の材料候補は現在の材料との比較です。`}/>}
    {review.batch.status === 'preview' && review.stale && <button className="btn medium" disabled={busy} onClick={onResume}>未反映分を再確認</button>}
    {review.batch.status === 'applied' && <details><summary>確定した判断履歴（{review.decisions.length}件）</summary><div className="stack gap-8">
      <ul className="stack gap-8">{review.decisions.slice(decisionPage * 25, decisionPage * 25 + 25).map((d, index) => <li key={index} className="card padded stack gap-8"><span className="original-text mono">原記録: {d.itemId}</span><span className="original-text mono">材料: {d.materialId ?? 'なし'}</span><span>{d.decision} / 反映項目: {d.selectedFields.join(', ') || 'なし'}</span><span className="note">{d.reason}</span></li>)}</ul>
      <Pager page={decisionPage} size={25} total={review.decisions.length} unit="判断" busy={busy} setPage={setDecisionPage}/>
    </div></details>}
    {missing.length > 0 && <p className="note">「Excelに見当たらない」は、新しいExcelのどの行にも当たらない既存材料です。前回あった位置に並べています。既定で保持し、「無効にする」を選んだ材料だけ無効にします。手動作成材料は含みません。</p>}
    <div className="filter-pills" role="group" aria-label="表示する行">{([['needed', '確認が必要', needed.length], ['all', 'すべて', entries.length]] as const).map(([key, label, n]) => <button key={key} aria-pressed={filter === key} disabled={busy} onClick={() => setFilter(key)}>{label} {n}</button>)}</div>
    {visible.length === 0 ? <p className="empty-state">確認が必要な行はありません。前回の取込と同じ内容の行は、保留のままでも材料は変わりません。「すべて」で全行を確認できます。</p>
      : <ul className="stack">{visible.slice(shown * 10, shown * 10 + 10).map(entry => entry.kind === 'row'
        ? <ReRowCard key={entry.row.source.id} row={entry.row} choice={choices.get(entry.row.source.id) ?? { itemId: entry.row.source.id, action: 'hold' }} materials={review.materials} assignments={review.assignments} editable={editable} onChange={onChange}/>
        : <MissingCard key={entry.material.id} material={entry.material} mappedRow={rows.find(row => row.source.id === mappedBy.get(entry.material.id))} inactive={inactive.has(entry.material.id)} editable={editable} onInactive={onInactive}/>)}</ul>}
    <Pager page={shown} size={10} total={visible.length} unit="件" busy={busy} setPage={setPage}/>
  </section>;
}

function MissingCard({ material, mappedRow, inactive, editable, onInactive }: { readonly material: ManagedMaterial; readonly mappedRow: ReimportRow | undefined; readonly inactive: boolean; readonly editable: boolean; readonly onInactive: (id: string, on: boolean) => void }) {
  const name = material.values.name || '（品名なし）';
  return <li className={`card re-row${inactive ? ' deactivating' : mappedRow ? ' decided' : ''}`}>
    <div className="stack gap-8">
      <div className="row"><span className="strong original-text">{name}</span><span className="badge medium warn">Excelに見当たらない</span>{material.source && <span className="note mono">前回 {cellRange(material.source)}</span>}</div>
      <span className="note original-text">現在の材料: {name} / {material.values.model || '型式なし'} ・ {material.categoryName}</span>
      {mappedRow ? <span className="note">{cellRange(mappedRow.source)} の行をこの材料に対応付けています。</span>
        : <span className="note">新しいExcelに、この材料に当たる行が見つかりません。品名やメーカーを書き換えた行がある場合は、その行の「判断」でこの材料を選んでください。</span>}
    </div>
    <div className="stack gap-8">
      <label className="labelled"><span className="label-text">判断</span>
        <select className="field" aria-label={`${name}（Excelに見当たらない）の扱い`} disabled={!editable || mappedRow !== undefined} value={mappedRow ? 'mapped' : inactive ? 'inactive' : 'keep'} onChange={e => onInactive(material.id, e.target.value === 'inactive')}>
          {mappedRow && <option value="mapped">行に対応付け済み</option>}
          <option value="keep">保持（変更しない）</option><option value="inactive">無効にする</option>
        </select></label>
      {inactive && <p className="note">無効にした材料は材料検索に出なくなります。材料のデータと過去の請求書は残ります。</p>}
    </div>
  </li>;
}

function ReRowCard({ row, choice, materials, assignments, editable, onChange }: { readonly row: ReimportRow; readonly assignments: readonly SourceAssignment[]; readonly choice: ReimportChoice; readonly materials: readonly ManagedMaterial[]; readonly editable: boolean; readonly onChange: (choice: ReimportChoice) => void }) {
  const [query, setQuery] = useState('');
  const current = choice.action === 'map' ? materials.find(m => m.id === choice.materialId) : undefined;
  const assigned = (id: string): boolean => assignments.some(a => a.sourceBatchId === row.sourceBatchId && a.materialId === id && a.itemId !== row.source.id);
  const proposed = new Set(row.suggestedIds);
  const candidates = materials.filter(m => query ? [m.values.name, m.values.model, m.id].some(v => v.toLowerCase().includes(query.toLowerCase())) : proposed.has(m.id)).slice(0, 50);
  const options = current && !candidates.some(m => m.id === current.id) ? [current, ...candidates] : candidates;
  // 要確認の行も品名があれば判断できる（本体の reimport:apply と同じ判定。列見出しは一覧に出さない）。
  const decidable = editable && row.source.classification !== 'header' && adoptable(row.source);
  const preview = current ?? (row.suggestedIds.length === 1 ? materials.find(m => m.id === row.suggestedIds[0]) : undefined);
  function select(value: string): void {
    if (value === 'hold' || value === 'new') { onChange({ itemId: row.source.id, action: value }); return; }
    const target = materials.find(m => m.id === value); if (!target) return;
    const fields = MATERIAL_FIELDS.filter((key, index) => target.values[key] === (target.source?.values[index] ?? '') || target.values[key] === row.source.values[index]);
    onChange({ itemId: row.source.id, action: 'map', materialId: target.id, fields });
  }
  const tag = row.source.classification === 'header' ? ['除外した見出し', ''] as const : comparisons[row.comparison];
  const diffs = preview ? MATERIAL_FIELDS.flatMap((field, index) => {
    const base = preview.source?.values[index] ?? '', incoming = row.source.values[index] ?? '', local = preview.values[field];
    return local === incoming ? [] : [{ field, local, incoming, conflict: local !== base && incoming !== base && local !== incoming }];
  }) : [];
  return <li className={`card re-row${choice.action !== 'hold' ? ' decided' : ''}`}>
    <div className="stack gap-8">
      <div className="row"><span className="strong original-text">{row.source.values[0] || '（品名なし）'}</span><span className={`badge medium ${tag[1]}`}>{tag[0]}</span><span className="note mono">{cellRange(row.source)}</span></div>
      {choice.action === 'new' ? <span className="note">新規材料として追加します（既存の材料は変更しません）。</span>
        : <span className="note original-text">{current ? '対応する材料' : preview ? '候補の材料' : '対応する材料'}: {preview ? `${preview.values.name || '（品名なし）'} / ${preview.values.model || '型式なし'}${preview.active ? '' : '（無効）'}` : 'なし'}</span>}
      {choice.action === 'new'
        ? MATERIAL_FIELDS.map((field, index) => row.source.values[index] ? <div key={field} className="diff-line"><span/><span className="muted">{fieldLabels[field]}</span><span className="old">—</span><span className="muted">→</span><span className="new">{row.source.values[index]}</span></div> : null)
        : diffs.length === 0 ? (preview && <span className="note">現在の材料との差分はありません。</span>)
        : diffs.map(diff => <div key={diff.field} className="diff-line">
          {current && choice.action === 'map' ? <input type="checkbox" aria-label={`${fieldLabels[diff.field]}を反映`} disabled={!editable} checked={choice.fields.includes(diff.field)} onChange={e => onChange({ ...choice, fields: e.target.checked ? [...choice.fields, diff.field] : choice.fields.filter(f => f !== diff.field) })}/> : <span/>}
          <span className="muted">{fieldLabels[diff.field]}{diff.conflict && <span className="changed-mark"> 競合</span>}</span><span className="old">{diff.local || '（空欄）'}</span><span className="muted">→</span><span className="new">{diff.incoming || '（空欄）'}</span>
        </div>)}
      {current && choice.action === 'map' && <p className="note">チェックした項目だけを新Excelから反映します。未選択の項目は現在の値を保持します。競合項目は既定で未選択です。</p>}
      <details><summary>新Excelの原記録を確認</summary><CellDetails item={row.source}/></details>
    </div>
    <div className="stack gap-8">
      <label className="labelled"><span className="label-text">判断</span>
        <select className="field" aria-label={`${row.source.rowIndex}行 ${row.source.block}の扱い`} disabled={!decidable} value={choice.action === 'map' ? choice.materialId : choice.action} onChange={e => select(e.target.value)}>
          <option value="hold">保留</option><option value="new">新規材料として追加</option>
          {options.map(m => <option key={m.id} value={m.id} disabled={assigned(m.id)}>差分を反映: {m.values.name.slice(0, 40)} / {m.values.model.slice(0, 30)} / {m.id.slice(0, 8)}{m.active ? '' : ' / 無効'}{assigned(m.id) ? ' / 別行に対応済み' : ''}</option>)}
        </select></label>
      {decidable && <label className="labelled"><span className="label-text">既存材料を探す（品名・型式・ID）</span><input className="field" maxLength={QUERY_MAX_LENGTH} value={query} onChange={e => setQuery(e.target.value)}/></label>}
      {decidable && options.some(m => assigned(m.id)) && <p className="note">同じ元ブックの別行に対応済みの材料は選択できません。</p>}
      {decidable && row.source.classification === 'held' && <p className="note">要確認の行です。「新Excelの原記録を確認」で値と表示を確かめてから判断してください。</p>}
      {!row.source.applied && !adoptable(row.source) && <p className="note">{lockedReason(row.source)}。保留のまま残します。</p>}
    </div>
  </li>;
}
