import { Component, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

// 描画中の例外で画面全体が外れても、Mainからの終了確認に応答してアプリを閉じられるようにする。
function CrashScreen() {
  const [message, setMessage] = useState('');
  useEffect(() => window.appApi.documents.onCloseRequested(token => {
    void window.appApi.documents.close(token).then(
      result => { if (result.status === 'error') setMessage(result.message); },
      () => { setMessage('終了できませんでした。もう一度お試しください。'); },
    );
  }), []);
  return <div className="page stack gap-8" role="alert">
    <h1>画面でエラーが発生しました</h1>
    <p>保存済みの内容は保持されています。最後の自動保存より後の入力は失われている可能性があります。アプリを終了して、もう一度起動してください。</p>
    {message && <p>{message}</p>}
    <div><button className="btn medium" onClick={() => { window.close(); }}>アプリを終了</button></div>
  </div>;
}

export class ErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  override render(): ReactNode { return this.state.failed ? <CrashScreen/> : this.props.children; }
}
