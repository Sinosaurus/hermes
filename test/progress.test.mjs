import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createProgress, progressLine, formatBytes } from '../src/progress.mjs';
import { command } from '../src/common.mjs';

test('progress shows package completion and separate transfer/reuse statistics', () => {
  const line = progressLine({ phase: 'import', completed: 2, total: 4, uploaded: 1, reused: 1, downloaded: 3, uploadBytes: 2048, downloadBytes: 4096, name: '@scope/pkg', version: '1.0.0' }, 4000);
  assert.match(line, /\[##########\.{10}\] 2\/4/);
  assert.match(line, /上传 1 \(2.0 KiB\)/);
  assert.match(line, /下载 3 \(4.0 KiB\)/);
  assert.match(line, /复用 1/);
  assert.match(line, /预计剩余 4s/);
  assert.match(line, /@scope\/pkg@1.0.0/);
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024 ** 3), '1.0 GiB');
});

test('TTY updates refresh one line; redirected progress is plain and none is silent', async () => {
  const events = [], stream = { isTTY: true, write: chunk => events.push(chunk) };
  const progress = createProgress({ stream, intervalMs: 5 });
  progress.update({ phase: 'download', completed: 0, total: 1 });
  await new Promise(resolve => setTimeout(resolve, 16));
  progress.update({ phase: 'download', completed: 1, total: 1, downloaded: 1 });
  progress.stop();
  assert.ok(events.length >= 3);
  assert.ok(events[0].startsWith('\r\x1b[2K'));
  assert.equal(events.at(-1), '\n');
  const plain = [];
  const redirected = createProgress({ stream: { isTTY: false, write: value => plain.push(value) } });
  redirected.update({ phase: 'download', completed: 1, total: 1 });
  redirected.stop();
  assert.equal(plain.length, 1);
  assert.doesNotMatch(plain[0], /\x1b|\r/);
  createProgress({ mode: 'none', stream }).update({ phase: 'download', completed: 0, total: 1 });
  assert.throws(() => createProgress({ mode: 'wrong' }), /--progress/);
});

test('CLI bulk files validate their shape and reject project mixing before collecting', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'offline-npm-bulk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'packages.json');
  await writeFile(file, JSON.stringify({ package: 'wrong-shape' }));
  await assert.rejects(command(process.execPath, ['src/cli.mjs', 'collect', '--packages-file', file, '--out', path.join(root, 'bundle')]), /nonempty JSON array/);
  await writeFile(file, JSON.stringify(['one@1.0.0', 'two@2.0.0']));
  await assert.rejects(command(process.execPath, ['src/cli.mjs', 'collect', '--project', root, '--packages-file', file, '--out', path.join(root, 'bundle')]), /cannot be combined/);
  await assert.rejects(command(process.execPath, ['src/cli.mjs', 'collect', '--package', 'one', '--out', path.join(root, 'bundle'), '--progress', 'wrong']), /--progress must/);
});
