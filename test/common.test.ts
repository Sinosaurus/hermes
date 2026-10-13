// 文件职责：输入、文件与制品边界，以及 CLI 帮助和错误行为的回归测试。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  command,
  readArtifact,
  safePath,
  writeJson,
  fileHash,
  assertIntegrity,
  normalizeRegistry,
  redact,
  verifyBundle,
  validateIdentity,
  validateDistTag,
} from '../src/lib/index.js';
import {
  entriesFromLock,
  registrySpec,
  validateInstallFlags,
  tagPlanFromSnapshots,
} from '../src/core/collect.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-npm-common-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('registry and input boundaries reject credentials and non-registry specs', () => {
  assert.equal(
    normalizeRegistry('https://registry.example/hosted'),
    'https://registry.example/hosted/',
  );
  assert.equal(normalizeRegistry('http://127.0.0.1:1234'), 'http://127.0.0.1:1234/');
  for (const value of [
    'http://registry.example',
    'https://user:secret@registry.example',
    'https://registry.example/?token=secret',
  ])
    assert.throws(() => normalizeRegistry(value));
  assert.equal(registrySpec('@scope/pkg@^1.0.0'), '@scope/pkg');
  assert.equal(registrySpec('pkg@>=1 <2'), 'pkg');
  for (const value of [
    'owner/repo',
    'file:../pkg',
    'https://example/pkg.tgz',
    '--help',
    'alias@npm:pkg@1',
    'pkg@tag/branch',
  ])
    assert.throws(() => registrySpec(value));
  assert.deepEqual(validateInstallFlags(['--legacy-peer-deps', '--legacy-peer-deps']), [
    '--legacy-peer-deps',
  ]);
  assert.throws(() => validateInstallFlags(['--ignore-scripts=false']));
  assert.throws(() => validateInstallFlags(['--legacy-peer-deps', '--strict-peer-deps']));
  assert.match(
    redact('authorization=secret https://user:password@example/a'),
    /authorization=\[redacted\]/,
  );
  assert.doesNotMatch(
    redact('authorization=secret https://user:password@example/a'),
    /secret|password/,
  );
});

test('npm identity and tag validation follows canonical SemVer and npm naming rules', () => {
  for (const version of ['1.0.0', '1.2.3-beta.1+build.42'])
    validateIdentity({ name: '@scope/pkg', version });
  for (const version of [
    '01.0.0',
    '1.0.0-01',
    '1.0.0+a+b',
    'v1.0.0',
    ' 1.0.0 ',
    '^1.0.0',
    'latest',
  ]) {
    assert.throws(() => validateIdentity({ name: 'pkg', version }), /exact version/);
  }
  for (const name of ['UpperCase', '_private', 'node_modules', '@scope', 'pkg/name'])
    assert.throws(() => validateIdentity({ name, version: '1.0.0' }), /package name/);
  for (const tag of ['latest', 'v-next', 'offline-import-123abc']) validateDistTag(tag);
  for (const tag of ['x', 'v1', '1.2', '^1.0.0', '', ' latest ', 'tag/branch'])
    assert.throws(() => validateDistTag(tag), /dist-tag/);
});

test('lock traversal preserves nested identities and blocks links, Git and credential URLs', () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/a': { version: '1.0.0' },
      'node_modules/a/node_modules/@scope/b': { version: '2.0.0' },
      'node_modules/alias': { name: 'real-name', version: '3.0.0' },
      'node_modules/a/node_modules/bundled': { inBundle: true, version: '1.0.0' },
    },
  };
  const parsed = entriesFromLock(lock);
  assert.deepEqual(
    parsed.entries.map((entry) => entry.name),
    ['a', '@scope/b', 'real-name'],
  );
  assert.equal(parsed.skipped[0].reason, 'included-in-parent-tarball');
  for (const entry of [
    { link: true },
    { version: '1.0.0', resolved: 'git+https://example/a' },
    { version: '1.0.0', resolved: 'https://example/a?token=secret' },
  ])
    assert.throws(() =>
      entriesFromLock({ lockfileVersion: 3, packages: { 'node_modules/a': entry } }),
    );
  assert.throws(() => entriesFromLock({ lockfileVersion: 1 }));
  const plans = tagPlanFromSnapshots(new Map([['a', { latest: '2.0.0', stable: '1.0.0' }]]), [
    { name: 'a', version: '1.0.0' },
  ]);
  assert.deepEqual(plans[0].set, { stable: '1.0.0' });
  assert.equal(plans[0].excluded[0].tag, 'latest');
});

test('SRI checks use the strongest available algorithm and fail closed', async (t) => {
  const root = await fixture(t),
    file = path.join(root, 'content');
  await fs.writeFile(file, 'immutable');
  const sha512 = `sha512-${await fileHash(file, 'sha512', 'base64')}`;
  await assertIntegrity(file, `sha1-wrong ${sha512}`);
  await assert.rejects(
    assertIntegrity(file, `sha1-${await fileHash(file, 'sha1', 'base64')} sha512-wrong`),
    /mismatch/,
  );
  await assert.rejects(assertIntegrity(file, ''), /Missing/);
  for (const sri of [`md5-invalid ${sha512}`, `not-sri ${sha512}`])
    await assert.rejects(assertIntegrity(file, sri), /Unsupported/);
});

test('safe paths and exclusive JSON writes protect existing data', async (t) => {
  const root = await fixture(t),
    file = path.join(root, 'record.json');
  await writeJson(file, { original: true }, { exclusive: true });
  await assert.rejects(writeJson(file, { original: false }, { exclusive: true }), {
    code: 'EEXIST',
  });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { original: true });
  for (const relative of ['../record.json', '/record.json', 'a/../record.json', 'a\\record.json'])
    await assert.rejects(safePath(root, relative), /Unsafe/);
  await fs.symlink(file, path.join(root, 'link.json'));
  await assert.rejects(safePath(root, 'link.json'), /regular/);
  assert.deepEqual((await fs.readdir(root)).sort(), ['link.json', 'record.json']);
});

test('archive and bundle checks verify exact identity, file set and unchanged bytes', async (t) => {
  const root = await fixture(t),
    source = path.join(root, 'source'),
    bundle = path.join(root, 'bundle');
  await fs.mkdir(path.join(source, 'package'), { recursive: true });
  await writeJson(path.join(source, 'package/package.json'), {
    name: 'fixture',
    version: '1.0.0',
    scripts: { prepare: 'exit 99' },
  });
  await fs.mkdir(path.join(bundle, 'packages'), { recursive: true });
  const archive = path.join(bundle, 'packages/one.tgz');
  await command('tar', ['-czf', archive, '-C', source, 'package']);
  const { packageJson } = await readArtifact(archive);
  assert.equal(packageJson.scripts.prepare, 'exit 99');
  const hash = await fileHash(archive),
    integrity = `sha512-${await fileHash(archive, 'sha512', 'base64')}`;
  const manifest = {
    schemaVersion: 1,
    status: 'complete',
    packages: [
      {
        id: 'one',
        name: 'fixture',
        version: '1.0.0',
        file: 'packages/one.tgz',
        sha256: hash,
        artifactIntegrity: integrity,
        sourceIntegrity: integrity,
        artifactKind: 'registry-original',
      },
    ],
    files: { 'packages/one.tgz': hash },
    tagPlan: [],
    resources: [],
    resourceReview: { status: 'pending' },
    targets: [{ os: process.platform, cpu: process.arch }],
  };
  await writeJson(path.join(bundle, 'manifest.json'), manifest);
  const manifestDigest = await fileHash(path.join(bundle, 'manifest.json'));
  await fs.writeFile(
    path.join(bundle, 'checksums.sha256'),
    `${manifestDigest}  manifest.json\n${hash}  packages/one.tgz\n`,
  );
  assert.equal((await verifyBundle(bundle)).manifestDigest, manifestDigest);
  await fs.writeFile(path.join(bundle, 'unregistered'), 'extra');
  await assert.rejects(verifyBundle(bundle), /file set/);
  await fs.unlink(path.join(bundle, 'unregistered'));
  await fs.appendFile(archive, 'changed');
  await assert.rejects(verifyBundle(bundle), /checksum/);
  await fs.symlink('/etc/passwd', path.join(source, 'package/external'));
  await command('tar', ['-czf', path.join(root, 'linked.tgz'), '-C', source, 'package']);
  await assert.rejects(readArtifact(path.join(root, 'linked.tgz')), /links/);
});

test('CLI reports invalid inputs as nonzero JSON failures', async () => {
  const output = await command(process.execPath, ['dist/cli/index.js', '--help']);
  assert.match(output, /promote/);
  assert.match(output, /nova-hm/);
  assert.match(await command(process.execPath, ['dist/cli/index.js']), /promote/);
  assert.match(
    (await command(process.execPath, ['dist/cli/index.js', '--version'])).trim(),
    /^nova-hm\/0\.1\.0 /,
  );
  const collectHelp = await command(process.execPath, ['dist/cli/index.js', 'collect', '--help']);
  assert.match(collectHelp, /nova-hm collect/);
  assert.match(collectHelp, /--packages-file/);
  assert.match(collectHelp, /--progress/);
  await assert.rejects(
    command(process.execPath, ['dist/cli/index.js', 'verify', '--bundle', '/missing', 'extra']),
    /(?:too many arguments|unused args)/i,
  );
  await assert.rejects(
    command(process.execPath, [
      'dist/cli/index.js',
      'import',
      '--bundle',
      '/missing',
      '--registry',
      'http://invalid.example',
    ]),
    (error) => error.exitCode === 1 && /Registry must be HTTPS/.test(error.message),
  );
  await assert.rejects(
    command(process.execPath, [
      'dist/cli/index.js',
      'verify',
      '--bundle',
      '/missing',
      '--unexpected',
    ]),
    (error) => error.exitCode === 1 && /unknown option/i.test(error.message),
  );
});

test('cac rejects missing values and unknown commands; scalar duplicates use the last value', async () => {
  const cases: [string[], RegExp][] = [
    [['collect', '--package'], /requires a nonempty value/],
    [['inventory', '--allow-link-root'], /requires a nonempty value/],
    [['--unexpected'], /Unknown option/],
    [['collect', '--package', 'one', '--package', ''], /requires a nonempty value/],
    [
      ['verify', '--bundle', '/one', '--bundle', '/offline-npm-missing-last-bundle'],
      /offline-npm-missing-last-bundle/,
    ],
    [['verify', '--bundle', '   '], /nonempty string/],
    [['recover', '--repack', '--registry', 'https://example.org'], /cannot be used/],
    [['verify', '--', 'extra'], /Unused args/],
    [['unknown-command'], /Unknown command/],
  ];
  for (const [args, message] of cases) {
    await assert.rejects(command(process.execPath, ['dist/cli/index.js', ...args]), message);
  }
});
