import type { DocumentResult, EditorSession, InvoiceDraft, SaveDocument, SaveReceipt } from '../shared/document-api';
export interface EditorState { readonly session: EditorSession | null; readonly status: 'idle' | 'waiting' | 'saving' | 'saved' | 'error'; readonly message: string; readonly dirty: boolean; readonly composing: boolean }

export class EditorStore {
  private state: EditorState = { session: null, status: 'idle', message: '', dirty: false, composing: false };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private savedGeneration = 0;
  private requestNumber = 1;
  private pending: SaveDocument | null = null;
  private unknownOutcome = false;
  private running: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstEdit = 0;
  private paused = false;
  private drainEpoch = 0;
  private discarding = false;
  private savedDraft: InvoiceDraft | null = null;
  constructor(private readonly send: (request: SaveDocument) => Promise<DocumentResult<SaveReceipt>>) {}
  readonly getSnapshot = (): EditorState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(next: Partial<EditorState>): void { this.state = { ...this.state, ...next }; for (const listener of this.listeners) listener(); }
  private clearTimer(): void { clearTimeout(this.timer); this.timer = undefined; }
  load(session: EditorSession): void {
    if (this.running || this.unknownOutcome) throw new Error('Unresolved save cannot be replaced');
    this.clearTimer(); this.generation = 0; this.savedGeneration = session.revision === 0 ? -1 : 0; this.requestNumber = 1;
    this.pending = null; this.savedDraft = session.draft; this.firstEdit = Date.now();
    this.publish({ session, status: session.revision === 0 ? 'waiting' : 'saved', dirty: session.revision === 0, message: '', composing: false }); this.schedule();
  }
  edit(draft: InvoiceDraft): void {
    const session = this.state.session; if (!session || JSON.stringify(draft) === JSON.stringify(session.draft)) return;
    if (!this.state.dirty) this.firstEdit = Date.now();
    this.generation += 1;
    this.publish({ session: { ...session, draft }, dirty: true, status: this.running ? 'saving' : this.state.status === 'error' ? 'error' : 'waiting' }); this.schedule();
  }
  compose(value: boolean): void { this.publish({ composing: value }); if (value) this.clearTimer(); else this.schedule(); }
  pause(value: boolean): void { this.paused = value; if (value) this.clearTimer(); else this.schedule(); }
  private schedule(): void {
    this.clearTimer();
    if (!this.state.dirty || this.running || this.discarding || this.state.composing || this.paused || this.state.status === 'error') return;
    const delay = Math.max(0, Math.min(500, 2000 - (Date.now() - this.firstEdit)));
    this.timer = setTimeout(() => { if (!this.state.composing && !this.paused) void this.flush(false); }, delay);
  }
  private async attempt(request: SaveDocument): Promise<boolean> {
    try {
      const result = await this.send(request);
      switch (result.status) {
        case 'error': this.pending = null; this.unknownOutcome = false; this.publish({ status: 'error', message: result.message }); return false;
        case 'ok': {
          const receipt = result.data, session = this.state.session;
          if (!session || receipt.sessionId !== session.sessionId || receipt.requestNumber !== request.requestNumber || receipt.generation !== request.generation || receipt.revision !== request.expectedRevision + 1 || (session.documentId !== null && receipt.documentId !== session.documentId)) {
            this.unknownOutcome = true; this.publish({ status: 'error', message: '保存応答を確認できません。同じ要求を再確認してください。' }); return false;
          }
          this.unknownOutcome = false; this.pending = null; this.requestNumber += 1; this.savedGeneration = request.generation; this.savedDraft = request.draft;
          const dirty = this.generation !== this.savedGeneration;
          this.publish({ session: { ...session, documentId: receipt.documentId, revision: receipt.revision }, dirty, status: dirty ? 'waiting' : 'saved', message: '' }); return true;
        }
      }
    } catch {
      this.unknownOutcome = true; this.publish({ status: 'error', message: '保存結果が不明です。入力を保持しています。再試行で同じ要求を確認してください。' }); return false;
    }
  }
  async flush(forceDrain = true): Promise<boolean> {
    this.clearTimer(); if (this.state.composing || this.discarding) return false;
    const epoch = this.drainEpoch;
    if (this.running) { const result = await this.running; if (epoch !== this.drainEpoch || this.discarding) return false; if (!result && (this.state.status === 'error' || this.state.composing)) return false; return this.state.dirty ? this.flush(forceDrain) : true; }
    if (!this.state.dirty) return true;
    const drain = async (): Promise<boolean> => {
      do {
        const session = this.state.session; if (!session || this.state.composing) return false;
        this.pending ??= { sessionId: session.sessionId, requestNumber: this.requestNumber, generation: this.generation, expectedRevision: session.revision, draft: structuredClone(session.draft) };
        this.publish({ status: 'saving', message: '' });
        if (!await this.attempt(this.pending)) return false;
      } while (epoch === this.drainEpoch && !this.discarding && this.state.dirty && (!this.paused || forceDrain) && !this.state.composing);
      return !this.state.dirty;
    };
    this.running = drain();
    try { return await this.running; } finally { this.running = null; this.schedule(); }
  }
  async discard(): Promise<boolean> {
    this.clearTimer();
    this.drainEpoch += 1; this.discarding = true;
    try {
      if (this.running) await this.running;
      if (this.unknownOutcome && this.pending && !await this.attempt(this.pending)) return false;
      const session = this.state.session;
      if (session && this.savedDraft) this.publish({ session: { ...session, draft: this.savedDraft }, dirty: false, status: session.revision ? 'saved' : 'idle', message: '' });
      this.generation = this.savedGeneration; this.pending = null; return true;
    } finally { this.discarding = false; }
  }
  /** 開いている請求書を閉じる（その請求書を削除したとき）。保存中・保存結果が不明なときは閉じずに false を返す。 */
  unload(): boolean {
    if (this.running || this.unknownOutcome) return false;
    this.clearTimer(); this.generation = 0; this.savedGeneration = 0; this.requestNumber = 1; this.pending = null; this.savedDraft = null;
    this.publish({ session: null, status: 'idle', dirty: false, message: '', composing: false }); return true;
  }
  dispose(): void { this.clearTimer(); this.listeners.clear(); }
}
