import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { entriesFromLock } from '../src/core/collection/resolution.js';
import { stageLocalInputs } from '../src/core/collection/local-inputs.js';
import type { NpmLock, PackageJson } from '../src/core/types.js';
import { command, fileHash, readJson, writeJson } from '../src/lib/index.js';

const lockedEntry = (version: string, rest: Record<string, unknown> = {}) => ({ version, ...rest });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-local-lock-'));
  const project = path.join(root, 'project');
  const work = path.join(root, 'work');
  const workspace = {
    name: '@sample/internal',
    version: '1.0.1',
    private: true,
    dependencies: { transitive: '1.2.3' },
  };
  const vendor = {
    name: 'vendored',
    version: '2.0.0',
    private: true,
    dependencies: { publicpkg: '^3.0.0' },
  };
  await mkdir(path.join(project, 'vendor'), { recursive: true });
  await writeJson(path.join(project, 'packages/weird-name/package.json'), workspace);
  await writeJson(path.join(root, 'pack/package/package.json'), vendor);
  await mkdir(work);
  const tgz = path.join(project, 'vendor/exact.tgz');
  await command('tar', ['-czf', tgz, '-C', path.join(root, 'pack'), 'package']);
  const integrity = 'sha512-' + (await fileHash(tgz, 'sha512', 'base64'));
  const packageJson: PackageJson = {
    name: 'capture-root',
    version: '1.0.0',
    workspaces: ['packages/*'],
    dependencies: {
      '@sample/internal': 'file:./packages/weird-name',
      vendored: 'file:./vendor/exact.tgz',
    },
  };
  const lock: NpmLock = {
    lockfileVersion: 3,
    packages: {
      '': { version: packageJson.version, dependencies: packageJson.dependencies },
      'packages/weird-name': workspace,
      'node_modules/@sample/internal': lockedEntry('', {
        link: true,
        resolved: 'packages/weird-name',
      }),
      'node_modules/vendored': lockedEntry(vendor.version, {
        resolved: 'file:vendor/exact.tgz',
        integrity,
      }),
      'node_modules/transitive': lockedEntry('1.2.3'),
      'node_modules/publicpkg': lockedEntry('3.0.0'),
    },
  };
  const cleanup = () => rm(root, { force: true, recursive: true });
  const stage = () =>
    stageLocalInputs(
      project,
      work,
      packageJson,
      lock,
      entriesFromLock(lock, { project: true }).local,
    );
  return {
    root,
    project,
    work,
    workspace,
    vendor,
    tgz,
    integrity,
    packageJson,
    lock,
    stage,
    cleanup,
  };
}

test('project lock keeps workspace source/local TGZ identities; registry deps are collected normally', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.cleanup);
  const parsed = entriesFromLock(f.lock, { project: true });
  assert.deepEqual(
    parsed.entries.map((entry) => entry.name),
    ['transitive', 'publicpkg'],
  );
  assert.throws(() => entriesFromLock(f.lock), /explicit migration/);
  const inputs = await f.stage();
  assert.deepEqual(
    inputs.map(({ kind, path }) => [kind, path]),
    [
      ['workspace', 'packages/weird-name'],
      ['file-tarball', 'vendor/exact.tgz'],
    ],
  );
  assert.equal(inputs[1].version, f.vendor.version);
  assert.deepEqual(
    await readJson(path.join(f.work, 'packages/weird-name/package.json')),
    f.workspace,
  );
  assert.deepEqual(await readFile(path.join(f.work, 'vendor/exact.tgz')), await readFile(f.tgz));
  assert.equal(f.lock.packages['node_modules/vendored'].resolved, 'file:vendor/exact.tgz');
});

test('rejects path traversal, external protocols, URL encoding and absolute link declarations', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.cleanup);
  for (const malicious of [
    'file:../secret.tgz',
    'file:%2e%2e/secret.tgz',
    'file:/etc/secret.tgz',
    'file://host/secret.tgz',
    'file:vendor/../exact.tgz',
    'git+https://main.invalid/dep',
    'file:C:/example.tgz',
    'file:node_modules/vendor.tgz',
  ]) {
    f.lock.packages['node_modules/vendored'].resolved = malicious;
    assert.throws(
      () => entriesFromLock(f.lock, { project: true }),
      /Unsafe project local|requires explicit migration/,
    );
  }
  const local = f.lock.packages['node_modules/vendored'];
  delete f.lock.packages['node_modules/vendored'];
  f.lock.packages['../node_modules/vendored'] = local;
  assert.throws(
    () => entriesFromLock(f.lock, { project: true }),
    /Unsafe lockfile package location/,
  );
  delete f.lock.packages['../node_modules/vendored'];
  f.lock.packages['node_modules/@sample/internal'].resolved = '../workspace';
  assert.throws(
    () => entriesFromLock(f.lock, { project: true }),
    /Unsafe project local workspace path/,
  );
});

test('requires locked tarball integrity and confirms identity even with matching SRI', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.cleanup);
  const entry = f.lock.packages['node_modules/vendored'];
  delete entry.integrity;
  assert.throws(() => entriesFromLock(f.lock, { project: true }), /locked integrity/);
  entry.integrity = f.integrity;
  entry.version = '2.0.1';
  await assert.rejects(f.stage, /identity differs from lock/);
});

test('rejects modified local archive without following unsafe dependency paths', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.cleanup);
  await writeFile(f.tgz, 'changed');
  await assert.rejects(f.stage, /Artifact integrity mismatch/);
});

test('rejects symlink workspace and out-of-checkout vendored link', async ({ onTestFinished }) => {
  const f = await fixture();
  onTestFinished(f.cleanup);
  await rm(path.join(f.project, 'packages'), { recursive: true });
  await symlink(path.join(f.root, 'pack'), path.join(f.project, 'packages'), 'dir');
  await assert.rejects(f.stage, /confined regular directory/);
  await rm(path.join(f.project, 'packages'));
  await writeJson(path.join(f.project, 'packages/weird-name/package.json'), f.workspace);
  const target = path.join(f.root, 'external.tgz');
  await writeFile(target, await readFile(f.tgz));
  await rm(f.tgz);
  await symlink(target, f.tgz);
  await assert.rejects(f.stage, /confined regular file/);
});

test('validates declared workspace set and root dependency specs against lock counterparts', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.cleanup);
  await writeJson(path.join(f.project, 'packages/missing-from-lock/package.json'), {
    name: 'unexpected',
    version: '1.0.0',
  });
  await assert.rejects(f.stage, /declarations differ from the lock/);
  await rm(path.join(f.project, 'packages/missing-from-lock'), { recursive: true });
  f.packageJson.dependencies!.vendored = 'file:./vendor/other.tgz';
  await assert.rejects(f.stage, /not a validated project-local input/);
});

test('blocks npm Git/remote fallback through workspace manifest and local override declarations', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.cleanup);
  await writeJson(path.join(f.project, 'packages/weird-name/package.json'), {
    ...f.workspace,
    dependencies: { unlocked: 'git+ssh://host/path' },
  });
  await assert.rejects(f.stage, /Unsupported non-registry dependency unlocked/);
  // Test an override without the existing staging tree from first failure.
  await rm(f.work, { recursive: true });
  await mkdir(f.work);
  Object.assign(f.packageJson, { overrides: { foo: { bar: 'https://host/tar.tgz' } } });
  await assert.rejects(f.stage, /Non-registry override/);
});
