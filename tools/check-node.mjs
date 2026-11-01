const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 19) {
  console.error('Node.js 24.19.0以降の24系で実行してください。Node 26ではパッケージ生成が途中終了することを確認しています。');
  process.exitCode = 1;
}
