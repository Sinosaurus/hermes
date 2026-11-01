// 文件职责：验证平台可选依赖闭包补齐、锁文件保留以及不完整输入的失败边界。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { expandPlatformInputs, type PlatformResolver } from '../src/core/collection/platforms.js';
import { entriesFromLock, type ResolvedInput } from '../src/core/collection/resolution.js';
import type { Bundle } from '../src/core/collection/bundle.js';
import type { NpmLock } from '../src/core/types.js';

function input(context: string, packages: NpmLock['packages']): ResolvedInput {
  const lock = { lockfileVersion: 3, packages };
  return {
    context,
    lock,
    lockName: 'package-lock.json',
    packageJson: { name: 'fixture', version: '1.0.0' },
    parsed: entriesFromLock(lock),
  };
}
const bundle = { report() {} } as Bundle;
const root = input('project', { 'node_modules/a': { version: '1.0.0' } });
const metadata = (name: string, version = '1.0.0', extras = {}) => ({ name, version, ...extras });

function resolver(records, resolutions = {}): PlatformResolver & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    async metadata(entry) {
      const result = records[`${entry.name}@${entry.version}`];
      assert.ok(result, `Metadata fixture missing: ${entry.name}@${entry.version}`);
      return result;
    },
    async resolve(spec, context) {
      requested.push(spec);
      const packages = resolutions[spec];
      assert.ok(packages, `Resolution fixture missing: ${spec}`);
      return input(context, packages);
    },
  };
}
const expand = (inputs, read: PlatformResolver) =>
  expandPlatformInputs(inputs, '/unused', 'https://registry.npmjs.org/', [], bundle, read);

test('补齐其它平台 optional 包以及其必需传递依赖，不修改原锁', async () => {
  const read = resolver(
    {
      'a@1.0.0': metadata('a', '1.0.0', { optionalDependencies: { 'b-windows': '^2.0.0' } }),
      'b-windows@2.1.0': metadata('b-windows', '2.1.0', {
        os: ['win32'],
        cpu: ['arm64'],
        dependencies: { c: '1.0.0' },
      }),
      'c@1.0.0': metadata('c'),
    },
    {
      'b-windows@^2.0.0': {
        'node_modules/b-windows': { version: '2.1.0' },
        'node_modules/c': { version: '1.0.0' },
      },
    },
  );
  const before = structuredClone(root);
  const result = await expand([root], read);
  assert.deepEqual(root, before);
  assert.equal(result.inputs.length, 1);
  assert.equal(result.inputs[0].parsed.entries.length, 2);
  assert.deepEqual(read.requested, ['b-windows@^2.0.0']);
  assert.equal(result.report.edges[0].status, 'supplemental');
  assert.deepEqual(result.report.platformMetadata.find((item) => item.name === 'b-windows')?.os, [
    'win32',
  ]);
});

test('保留最近祖先锁选中的多版本，不能按全局包名去重', async () => {
  const project = input('project', {
    'node_modules/a': { version: '1.0.0' },
    'node_modules/a/node_modules/b': { version: '1.2.0' },
    'node_modules/b': { version: '2.0.0' },
  });
  const read = resolver({
    'a@1.0.0': metadata('a', '1.0.0', { optionalDependencies: { b: '^1.0.0' } }),
    'b@1.2.0': metadata('b', '1.2.0'),
    'b@2.0.0': metadata('b', '2.0.0'),
  });
  const result = await expand([project], read);
  assert.equal(result.inputs.length, 0);
  assert.equal(result.report.edges[0].resolved, 'b@1.2.0');
  assert.equal(result.report.platformMetadata.length, 3);
  assert.deepEqual(read.requested, []);
});

test('循环和重复可选规格只解析一次，仍保留每条来源边', async () => {
  const read = resolver(
    {
      'a@1.0.0': metadata('a', '1.0.0', { optionalDependencies: { b: '1.0.0' } }),
      'b@1.0.0': metadata('b', '1.0.0', { optionalDependencies: { a: '1.0.0' } }),
    },
    {
      'b@1.0.0': { 'node_modules/b': { version: '1.0.0' } },
      'a@1.0.0': { 'node_modules/a': { version: '1.0.0' } },
    },
  );
  const result = await expand([root], read);
  assert.deepEqual(read.requested, ['b@1.0.0', 'a@1.0.0']);
  assert.equal(result.inputs.length, 2);
  assert.equal(result.report.edges.length, 3);
});

test('已内嵌的 optional 包不重复补齐', async () => {
  const read = resolver({
    'a@1.0.0': metadata('a', '1.0.0', {
      optionalDependencies: { b: '1.0.0' },
      bundledDependencies: ['b'],
    }),
  });
  const result = await expand([root], read);
  assert.equal(result.report.edges[0].status, 'bundled');
  assert.equal(result.inputs.length, 0);
});

test('拒绝不完整的必需子树以及 npm 静默省略的可选根', async () => {
  const read = resolver(
    {
      'a@1.0.0': metadata('a', '1.0.0', { optionalDependencies: { b: '1.0.0' } }),
      'b@1.0.0': metadata('b', '1.0.0', { dependencies: { missing: '1.0.0' } }),
    },
    { 'b@1.0.0': { 'node_modules/b': { version: '1.0.0' } } },
  );
  await assert.rejects(expand([root], read), /Required dependency missing/);
  const omitted = resolver(
    { 'a@1.0.0': metadata('a', '1.0.0', { optionalDependencies: { b: '1.0.0' } }) },
    { 'b@1.0.0': {} },
  );
  await assert.rejects(expand([root], omitted), /Missing or incompatible supplemental root/);
});

test('拒绝 Git/file/URL/alias 扩展，不向解析器传递危险规格', async () => {
  for (const spec of [
    'git+https://example.test/repo.git',
    'file:../b',
    'https://example.test/b.tgz',
    'npm:c@1.0.0',
  ]) {
    const read = resolver({
      'a@1.0.0': metadata('a', '1.0.0', { optionalDependencies: { b: spec } }),
    });
    await assert.rejects(expand([root], read), /Git\/file\/URL\/alias/);
    assert.deepEqual(read.requested, []);
  }
});

test('锁版本不满足可选范围、元数据身份错配、危险 flags 均阻断', async () => {
  const project = input('project', {
    'node_modules/a': { version: '1.0.0' },
    'node_modules/b': { version: '2.0.0' },
  });
  await assert.rejects(
    expand(
      [project],
      resolver({ 'a@1.0.0': metadata('a', '1.0.0', { optionalDependencies: { b: '^1.0.0' } }) }),
    ),
    /does not satisfy/,
  );
  await assert.rejects(
    expand([root], resolver({ 'a@1.0.0': metadata('different') })),
    /identity mismatch/,
  );
  await assert.rejects(
    expandPlatformInputs(
      [root],
      '/unused',
      'https://registry.npmjs.org/',
      ['--ignore-scripts=false'],
      bundle,
    ),
    /Supported install flags/,
  );
});

test('真实 npm 在本机 registry 补齐其它 OS/CPU 根包及其传递依赖，始终禁脚本', async (t) => {
  const { createServer } = await import('node:http');
  const { mkdtemp, rm, access } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const work = await mkdtemp(path.join(tmpdir(), 'hermes-platform-test-'));
  const marker = path.join(work, 'SHOULD-NOT-EXIST');
  t.onTestFinished(() => rm(work, { recursive: true, force: true }));
  let base = '';
  const records = {
    a: metadata('a', '1.0.0', { optionalDependencies: { 'foreign-b': '1.0.0' } }),
    'foreign-b': metadata('foreign-b', '1.0.0', {
      os: [process.platform === 'win32' ? 'linux' : 'win32'],
      cpu: ['arm64'],
      dependencies: { c: '1.0.0' },
      scripts: { install: `node -e "require('fs').writeFileSync('${marker}', 'ran')"` },
    }),
    c: metadata('c'),
  };
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const name = decodeURIComponent((req.url ?? '').slice(1));
    const item = records[name];
    res.setHeader('content-type', 'application/json');
    if (!item) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const version = {
      ...item,
      dist: {
        tarball: `${base}${name}/-/${name}.tgz`,
        shasum: '0000000000000000000000000000000000000000',
      },
    };
    res.end(
      JSON.stringify({ name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': version } }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}/`;
  const result = await expandPlatformInputs([root], work, base, [], bundle);
  assert.equal(result.inputs.length, 1);
  assert.deepEqual(result.inputs[0].parsed.entries.map((entry) => entry.name).sort(), [
    'c',
    'foreign-b',
  ]);
  assert.equal(result.report.edges[0].resolved, 'foreign-b@1.0.0');
  assert.ok(requests.some((url) => url === '/foreign-b'));
  assert.ok(requests.every((url) => !url.endsWith('.tgz')));
  await assert.rejects(access(marker));
}, 60_000);
