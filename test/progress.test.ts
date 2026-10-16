// 文件职责：进度显示与批量输入校验/合并的回归测试。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createProgress, progressLine, formatBytes } from '../src/cli/progress.js';
import { packageInputs, collectDefaults, targetRegistry } from '../src/cli/actions.js';
import { command } from '../src/lib/index.js';

test('progress shows package completion and separate transfer/reuse statistics', () => {
  const line = progressLine(
    {
      phase: 'import',
      completed: 2,
      total: 4,
      uploaded: 1,
      reused: 1,
      downloaded: 3,
      uploadBytes: 2048,
      downloadBytes: 4096,
      name: '@scope/pkg',
      version: '1.0.0',
    },
    4000,
  );
  assert.match(line, /2\/4/);
  assert.match(line, /上传 1 \(2.0 KiB\)/);
  assert.match(line, /下载 3 \(4.0 KiB\)/);
  assert.match(line, /复用 1/);
  assert.match(line, /@scope\/pkg@1.0.0/);
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024 ** 3), '1.0 GiB');
});

test('TTY updates refresh one line; redirected progress is plain and none is silent', async () => {
  const events = [],
    stream = { isTTY: true, write: (chunk) => events.push(chunk) };
  const progress = createProgress({ stream });
  progress.update({ phase: 'download', completed: 0, total: 1 });
  await new Promise((resolve) => setTimeout(resolve, 16));
  progress.update({ phase: 'download', completed: 1, total: 1, downloaded: 1 });
  progress.stop();
  assert.ok(events.length >= 3);
  // oxlint-disable-next-line no-control-regex -- 校验终端 ANSI 转义是否正确输出或清除。
  assert.match(events.join(''), /\x1b/);
  assert.match(events.join(''), /下载 1/);
  assert.match(events.join(''), /ETA/);
  assert.equal(events.at(-1), '\n');
  const plain = [];
  const redirected = createProgress({
    stream: { isTTY: false, write: (value) => plain.push(value) },
  });
  redirected.update({ phase: 'download', completed: 1, total: 1 });
  redirected.stop();
  assert.equal(plain.length, 1);
  // oxlint-disable-next-line no-control-regex -- 校验终端 ANSI 转义是否正确输出或清除。
  assert.doesNotMatch(plain[0], /\x1b|\r/);
  createProgress({ mode: 'none', stream }).update({ phase: 'download', completed: 0, total: 1 });
  assert.throws(() => createProgress({ mode: 'wrong' }), /--progress/);
});

test('CLI bulk files validate their shape and reject project mixing before collecting', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'offline-npm-bulk-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'packages.json');
  await writeFile(file, JSON.stringify({ package: 'wrong-shape' }));
  await assert.rejects(
    command(process.execPath, [
      'dist/cli/index.js',
      'collect',
      '--packages-file',
      file,
      '--out',
      path.join(root, 'bundle'),
    ]),
    /nonempty JSON array/,
  );
  await writeFile(file, JSON.stringify(['one@1.0.0', 'two@2.0.0']));
  assert.deepEqual(
    await packageInputs({ packagesFile: file, package: ['two@2.0.0', 'three@3.0.0'] }),
    ['one@1.0.0', 'two@2.0.0', 'three@3.0.0'],
  );
  await assert.rejects(
    command(process.execPath, [
      'dist/cli/index.js',
      'collect',
      '--project',
      root,
      '--packages-file',
      file,
      '--out',
      path.join(root, 'bundle'),
    ]),
    /cannot be used/,
  );
  await assert.rejects(
    command(process.execPath, [
      'dist/cli/index.js',
      'collect',
      '--package',
      'one',
      '--out',
      path.join(root, 'bundle'),
      '--progress',
      'wrong',
    ]),
    /--progress/,
  );
});

test('collection defaults prefer packages.json and explicit input; publishing never infers the public registry', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'offline-npm-defaults-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(collectDefaults({}, root), /No input found/);
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  assert.equal((await collectDefaults({}, root)).project, root);
  await writeFile(path.join(root, 'packages.json'), '["pkg@1.0.0"]');
  assert.equal((await collectDefaults({}, root)).packagesFile, path.join(root, 'packages.json'));
  assert.deepEqual(await collectDefaults({ package: ['explicit@1'] }, root), {
    package: ['explicit@1'],
  });
  assert.equal(
    await targetRegistry(undefined, async () => 'https://registry.internal/npm/\n'),
    'https://registry.internal/npm/',
  );
  await assert.rejects(
    targetRegistry(undefined, async () => 'https://registry.npmjs.org/'),
    /default public registry/,
  );
  assert.equal(await targetRegistry('https://explicit.internal/'), 'https://explicit.internal/');
  const modules = path.join(root, 'node_modules');
  await mkdir(path.join(modules, 'fixture'), { recursive: true });
  await writeFile(
    path.join(modules, 'fixture', 'package.json'),
    '{"name":"fixture","version":"1.0.0"}',
  );
  const output = JSON.parse(
    await command(
      process.execPath,
      [path.resolve('dist/cli/index.js'), 'inventory', '--progress=none'],
      { cwd: root },
    ),
  );
  assert.equal(output.instances[0].name, 'fixture');
  assert.equal(output.instances[0].locations[0], await realpath(path.join(modules, 'fixture')));
});

test('resource defaults apply to explicit inputs without replacing an explicit resource file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'offline-npm-resource-defaults-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const input = { package: ['fixture@1.0.0'] };
  assert.deepEqual(await collectDefaults(input, root), input);
  const resources = path.join(root, 'resources.json');
  await writeFile(resources, '{"resources":[]}');
  assert.deepEqual(await collectDefaults(input, root), { ...input, resources });
  const explicit = { ...input, resources: path.join(root, 'explicit-resources.json') };
  assert.deepEqual(await collectDefaults(explicit, root), explicit);
  assert.equal((await collectDefaults({ project: root }, root)).resources, resources);
});
