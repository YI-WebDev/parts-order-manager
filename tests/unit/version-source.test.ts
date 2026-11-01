import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 版の出所は package.json の1か所（TD-04）。Rust 側の Cargo.toml は手で合わせるため、ずれたらここで失敗させる。
const read = (path: string): string => readFileSync(path, 'utf8');
const cargoVersion = (path: string): string => /^\[package\][\s\S]*?^version = "([^"]+)"/m.exec(read(path))?.[1] ?? '';
const packageVersion = (JSON.parse(read('package.json')) as { version: string }).version;

describe('version single source', () => {
  it('Cargo.toml (app and core) match package.json', () => {
    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(cargoVersion('src-tauri/Cargo.toml')).toBe(packageVersion);
    expect(cargoVersion('src-tauri/core/Cargo.toml')).toBe(packageVersion);
  });

  it('tauri.conf.json takes the version from package.json', () => {
    expect((JSON.parse(read('src-tauri/tauri.conf.json')) as { version: string }).version).toBe('../package.json');
  });

  it('the bridge does not hard-code a version', () => {
    expect(read('src-tauri/src/bin/pom-bridge.rs')).not.toMatch(/version:\s*"\d/);
    expect(read('src-tauri/src/bin/pom-bridge.rs')).toContain('env!("CARGO_PKG_VERSION")');
  });
});
