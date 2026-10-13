// 文件职责：安装树布局、链接/内容冲突和 staging 完整性的回归测试。
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { inventoryModules, stageInstance, findModulesDirectory } from '../src/core/recovery.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'npm-recovery-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const modules = path.join(root, 'node_modules');
  await fs.mkdir(modules);
  return { root, modules };
}

async function pkg(directory, name, version = '1.0.0', extra = {}, text = 'original') {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ name, version, ...extra }),
  );
  await fs.writeFile(path.join(directory, 'index.js'), text);
  return directory;
}

test('inventory keeps nested and scoped instances, aliases, and ignores fixture package.json', async (t) => {
  const { modules } = await fixture(t);
  const first = await pkg(path.join(modules, 'first'), 'first');
  await pkg(path.join(first, 'node_modules', '@scope', 'child'), '@scope/child', '2.0.0');
  await pkg(path.join(first, 'examples', 'fixture'), 'fake');
  await fs.symlink(first, path.join(modules, 'alias'));
  const result = await inventoryModules(modules);
  assert.equal(result.layout, 'node-modules');
  assert.deepEqual(result.instances.map((value) => value.name).sort(), ['@scope/child', 'first']);
  assert.equal(result.instances.find((value) => value.name === 'first').locations.length, 2);
  assert.deepEqual(result.issues, []);
});

test('pnpm and Yarn store realpaths retain top-level links and store context without cycles', async (t) => {
  const { modules } = await fixture(t);
  const original = await pkg(
    path.join(modules, '.pnpm', 'first@1.0.0_peer@2.0.0', 'node_modules', 'first'),
    'first',
  );
  await fs.symlink(original, path.join(modules, 'first'));
  await fs.mkdir(path.join(original, 'node_modules'));
  await fs.symlink(original, path.join(original, 'node_modules', 'first'));
  await fs.writeFile(path.join(modules, '.pnpm', 'lock.yaml'), 'lockfileVersion: 9.0');
  await pkg(
    path.join(modules, '.store', 'second-npm-2.0.0-abcd', 'node_modules', 'second'),
    'second',
    '2.0.0',
  );
  const result = await inventoryModules(modules);
  assert.equal(result.layout, 'mixed');
  assert.equal(result.instances.length, 2);
  const instance = result.instances.find((value) => value.name === 'first');
  assert.equal(instance.locations.length, 3);
  assert.equal(instance.peerContext, 'pnpm:first@1.0.0_peer@2.0.0');
  assert.deepEqual(result.issues, []);
});

test('broken links and outside packages block; only node_modules link roots can be allowed', async (t) => {
  const { root, modules } = await fixture(t);
  const external = await pkg(path.join(root, 'workspace'), 'workspace');
  await fs.symlink(external, path.join(modules, 'workspace'));
  await fs.symlink(path.join(root, 'missing'), path.join(modules, 'missing'));
  let result = await inventoryModules(modules);
  assert.deepEqual(result.issues.map((value) => value.code).sort(), [
    'broken-link',
    'external-link',
  ]);
  assert.equal(result.instances.length, 0);
  await assert.rejects(
    inventoryModules(modules, { allowLinkRoots: [external] }),
    /inside node_modules/,
  );
  const linked = await pkg(path.join(root, 'other', 'node_modules', 'linked'), 'linked');
  await fs.unlink(path.join(modules, 'workspace'));
  await fs.symlink(linked, path.join(modules, 'linked'));
  result = await inventoryModules(modules, { allowLinkRoots: [linked] });
  assert.equal(result.instances[0].path, await fs.realpath(linked));
  assert.deepEqual(
    result.issues.map((value) => value.code),
    ['broken-link'],
  );
});

test('same name and version with different installed content is a conflict', async (t) => {
  const { modules } = await fixture(t);
  const a = await pkg(path.join(modules, 'first'), 'same');
  await pkg(path.join(a, 'node_modules', 'same'), 'same', '1.0.0', {}, 'patched');
  const result = await inventoryModules(modules);
  assert.equal(result.instances.length, 2);
  assert.deepEqual(
    result.issues.map((value) => value.code),
    ['content-conflict'],
  );
});

test('staging materializes internal files, preserves scripts and mode, and never links or changes source', async (t) => {
  const { root, modules } = await fixture(t);
  const source = await pkg(path.join(modules, 'first'), 'first', '1.0.0', {
    scripts: { prepare: 'touch source-mutated' },
  });
  await fs.chmod(path.join(source, 'index.js'), 0o755);
  await fs.symlink('index.js', path.join(source, 'alias.js'));
  await pkg(path.join(source, 'node_modules', 'dependency'), 'dependency');
  const result = await inventoryModules(modules);
  assert.deepEqual(result.issues, []);
  const instance = result.instances.find((value) => value.name === 'first');
  const destination = await stageInstance(instance, path.join(root, 'staging', 'first'));
  assert.equal((await fs.lstat(path.join(destination, 'alias.js'))).isSymbolicLink(), false);
  assert.equal((await fs.stat(path.join(destination, 'index.js'))).mode & 0o111, 0o111);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(destination, 'package.json'), 'utf8')).scripts.prepare,
    'touch source-mutated',
  );
  await assert.rejects(fs.stat(path.join(destination, 'node_modules')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(source, 'source-mutated')), { code: 'ENOENT' });
  await fs.writeFile(path.join(destination, 'index.js'), 'changed staging');
  assert.equal(await fs.readFile(path.join(source, 'index.js'), 'utf8'), 'original');
  await assert.rejects(stageInstance(instance, destination), { code: 'EEXIST' });
  await assert.rejects(stageInstance(instance, path.join(source, 'staging')), {
    code: 'unsafe-staging-path',
  });
  await assert.rejects(stageInstance(instance, path.join(modules, 'staging')), {
    code: 'unsafe-staging-path',
  });
});

test('staging rejects bundles, changed content, outside file links and internal link cycles', async (t) => {
  const { root, modules } = await fixture(t);
  const source = await pkg(path.join(modules, 'first'), 'first', '1.0.0', {
    bundledDependencies: ['child'],
  });
  let instance = (await inventoryModules(modules)).instances[0];
  await assert.rejects(stageInstance(instance, path.join(root, 'bundle')), {
    code: 'unsupported-bundled-repack',
  });
  await pkg(source, 'first');
  instance = (await inventoryModules(modules)).instances[0];
  await fs.writeFile(path.join(source, 'index.js'), 'changed');
  await assert.rejects(stageInstance(instance, path.join(root, 'changed')), {
    code: 'changed-package-content',
  });
  await assert.rejects(fs.stat(path.join(root, 'changed')), { code: 'ENOENT' });
  await fs.writeFile(path.join(root, 'outside'), 'outside');
  await fs.symlink(path.join(root, 'outside'), path.join(source, 'external'));
  assert.equal((await inventoryModules(modules)).issues[0].code, 'external-content-link');
  await fs.unlink(path.join(source, 'external'));
  await fs.symlink('.', path.join(source, 'cycle'));
  assert.equal((await inventoryModules(modules)).issues[0].code, 'content-link-cycle');
});

test('node_modules discovery selects the nearest tree and rejects arbitrary directories and escaped roots', async (t) => {
  const { root, modules } = await fixture(t);
  const child = path.join(root, 'src', 'deep');
  await fs.mkdir(child, { recursive: true });
  assert.equal(await findModulesDirectory(undefined, child), await fs.realpath(modules));
  assert.equal(await findModulesDirectory(undefined, modules), await fs.realpath(modules));
  await assert.rejects(inventoryModules(root), /node_modules directory/);
  const nested = path.join(child, 'node_modules');
  await fs.mkdir(nested);
  assert.equal(await findModulesDirectory(undefined, child), await fs.realpath(nested));
  await fs.rmdir(nested);
  await fs.symlink(path.join(root, 'missing-tree'), nested);
  await assert.rejects(findModulesDirectory(undefined, child), { code: 'ENOENT' });
  const other = path.join(root, 'other');
  await fs.mkdir(other);
  await fs.symlink(other, path.join(root, 'src', 'node_modules'));
  await assert.rejects(inventoryModules(path.join(root, 'src', 'node_modules')), /Resolved input/);
});

test('staging rejects package directories replaced by outside links after inventory', async (t) => {
  const { root, modules } = await fixture(t);
  const original = await pkg(path.join(modules, 'first'), 'first');
  const instance = (await inventoryModules(modules)).instances[0];
  const outside = path.join(root, 'outside-package');
  await fs.rename(original, outside);
  await fs.symlink(outside, original);
  const destination = path.join(root, 'staging');
  await assert.rejects(stageInstance(instance, destination), { code: 'changed-package-path' });
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});
