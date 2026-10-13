// 文件职责：通过注入适配器验证幂等导入、续跑、验收提升和条件回滚。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { command, fileHash, readArtifact, readJson, writeJson } from '../src/lib/index.js';
import { importBundle, planImport, promoteRun, rollbackRun } from '../src/core/publish.js';

const REGISTRY = 'https://registry.internal/npm/';
const READ_REGISTRY = 'https://registry.internal/group/';
const npmError = (code) =>
  Object.assign(new Error('authorization token=secret-test-token'), { npmCode: code });

async function fixture(
  t,
  { artifactKind = 'registry-original', resourceReview = 'reviewed', versions = ['1.0.0'] } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'offline-npm-publish-test-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle');
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'package'), { recursive: true });
  await mkdir(path.join(bundle, 'packages'), { recursive: true });
  await writeFile(path.join(source, 'package/index.js'), 'export default 42;\n');
  const pkgs = [],
    files = {};
  for (const version of versions) {
    const packageJson = { name: 'demo-package', version, scripts: { prepare: 'exit 99' } };
    await writeJson(path.join(source, 'package/package.json'), packageJson);
    const relative = `packages/demo-${version}.tgz`;
    const file = path.join(bundle, relative);
    await command('tar', ['-czf', file, '-C', source, 'package']);
    const sha256 = await fileHash(file);
    const integrity = `sha512-${await fileHash(file, 'sha512', 'base64')}`;
    pkgs.push({
      ...packageJson,
      id: `demo-${version.replaceAll('.', '-')}`,
      file: relative,
      size: (await stat(file)).size,
      sha256,
      artifactIntegrity: integrity,
      sourceIntegrity: integrity,
      artifactKind,
    });
    files[relative] = sha256;
  }
  const pkg = pkgs[0];
  const manifest = {
    schemaVersion: 1,
    status: 'complete',
    packages: pkgs,
    files,
    tagPlan: [{ name: pkg.name, set: { latest: versions.at(-1) } }],
    resources: [],
    targets: [{ os: 'linux', cpu: 'x64', node: 'v24.21.0', abi: '137', libc: 'glibc' }],
    resourceReview: {
      status: resourceReview,
      evidence: ['Fixture reviewed: no external resources.'],
    },
  };
  await writeJson(path.join(bundle, 'manifest.json'), manifest);
  const manifestDigest = await fileHash(path.join(bundle, 'manifest.json'));
  await writeFile(
    path.join(bundle, 'checksums.sha256'),
    [...Object.keys(files), 'manifest.json']
      .sort()
      .map((file) => `${file === 'manifest.json' ? manifestDigest : files[file]}  ${file}`)
      .join('\n') + '\n',
  );
  return { root, bundle, pkg, pkgs, manifest, manifestDigest, runDir: path.join(root, 'run') };
}

function registryAdapter() {
  const packages = new Map();
  const calls = { publish: [], pack: [], tag: [] };
  const hooks = {};
  const get = (name) => {
    if (!packages.has(name)) packages.set(name, { versions: new Map(), tags: {} });
    return packages.get(name);
  };
  const seed = (pkg, tags = {}) => {
    const item = get(pkg.name);
    const tarball = new URL(`${encodeURIComponent(pkg.name)}/-/${pkg.version}.tgz`, REGISTRY).href;
    item.versions.set(pkg.version, {
      packageJson: { name: pkg.name, version: pkg.version },
      sha256: pkg.sha256 ?? 'old-version',
      size: pkg.size ?? 0,
      tarball,
    });
    Object.assign(item.tags, tags);
    return item;
  };
  const split = (spec) => ({
    name: spec.slice(0, spec.lastIndexOf('@')),
    version: spec.slice(spec.lastIndexOf('@') + 1),
  });
  const adapter = {
    async npmJson(args, options) {
      assert.equal(options.registry, REGISTRY);
      hooks.query?.(args);
      assert.equal(args[0], 'view');
      const { name, version } = split(args[1]);
      const item = packages.get(name);
      if (!item || !item.versions.size || (version !== '*' && !item.versions.has(version)))
        throw npmError('E404');
      if (args[2] === 'version') return [...item.versions.keys()];
      if (args[2] === 'dist-tags') return { ...item.tags };
      assert.equal(args[2], 'dist');
      return { tarball: item.versions.get(version).tarball };
    },
    async packArtifact(url, destination, options) {
      assert.equal(options.registry, REGISTRY);
      calls.pack.push(url);
      hooks.pack?.(url);
      for (const item of packages.values()) {
        for (const artifact of item.versions.values())
          if (artifact.tarball === url) return artifact;
      }
      throw npmError('E404');
    },
    async npmCommand(args, options) {
      assert.equal(options.registry, REGISTRY);
      if (args[0] === 'publish') {
        assert.ok(args.includes('--ignore-scripts'));
        assert.ok(args.includes('--provenance=false'));
        const pkg = (await readArtifact(args[1])).packageJson;
        calls.publish.push(`${pkg.name}@${pkg.version}`);
        hooks.beforePublish?.(pkg);
        assert.ok(
          !get(pkg.name).versions.has(pkg.version),
          'must not publish an existing immutable version',
        );
        seed(
          { ...pkg, sha256: await fileHash(args[1]), size: (await stat(args[1])).size },
          { [args[args.indexOf('--tag') + 1]]: pkg.version },
        );
        hooks.afterPublish?.(pkg);
        return '{}';
      }
      assert.equal(args[0], 'dist-tag');
      const { name, version } =
        args[1] === 'add' ? split(args[2]) : { name: args[2], version: null };
      const tag = args[3];
      calls.tag.push({ name, version, tag });
      hooks.beforeTag?.({ name, version, tag });
      if (version === null) delete get(name).tags[tag];
      else {
        assert.ok(get(name).versions.has(version));
        get(name).tags[tag] = version;
      }
      hooks.afterTag?.({ name, version, tag });
      return '{}';
    },
  };
  return { adapter, packages, get, seed, calls, hooks };
}

async function acceptanceFile(f, overrides = {}) {
  const file = path.join(f.root, 'acceptance.json');
  await writeJson(file, {
    status: 'passed',
    manifestDigest: f.manifestDigest,
    writeRegistry: REGISTRY,
    readRegistry: READ_REGISTRY,
    targets: f.manifest.targets,
    resourceReview: 'reviewed',
    evidence: ['Isolated client install and application smoke test passed.'],
    ...overrides,
  });
  return file;
}

const options = (f, remote, extra = {}) => ({
  registry: REGISTRY,
  readRegistry: READ_REGISTRY,
  runDir: f.runDir,
  adapter: remote.adapter,
  ...extra,
});

test('import freezes original tags, uses a temporary tag and retries without republishing identical bytes', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  remote.seed({ name: f.pkg.name, version: '0.9.0' }, { latest: '0.9.0' });
  const plan = await planImport(f.bundle, options(f, remote));
  assert.equal(plan.packages[0].action, 'publish');
  assert.equal(plan.readRegistry, READ_REGISTRY);
  const first = await importBundle(f.bundle, options(f, remote));
  const identityBytes = await readFile(path.join(f.runDir, 'identity.json'));
  assert.equal(first.phase, 'versions-ready');
  assert.equal(remote.get(f.pkg.name).tags.latest, '0.9.0');
  assert.equal(remote.get(f.pkg.name).tags[first.temporaryTag], '1.0.0');
  const repeated = await importBundle(f.bundle, options(f, remote));
  assert.equal(repeated.phase, 'versions-ready');
  assert.equal(remote.calls.publish.length, 1);
  assert.deepEqual(await readFile(path.join(f.runDir, 'identity.json')), identityBytes);
  assert.equal((await planImport(f.bundle, options(f, remote))).packages[0].action, 'reuse');
  await assert.rejects(
    importBundle(f.bundle, options(f, remote, { readRegistry: REGISTRY })),
    /same bundle, write\/read registry/,
  );
});

test('read endpoint defaults to normalized write endpoint', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  const plan = await planImport(f.bundle, {
    registry: REGISTRY.slice(0, -1),
    adapter: remote.adapter,
  });
  assert.equal(plan.readRegistry, REGISTRY);
});

test('existing immutable version with different bytes is rejected before publishing', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  remote.seed({ ...f.pkg, sha256: 'different-bytes' });
  await assert.rejects(importBundle(f.bundle, options(f, remote)), /Artifact conflict/);
  assert.equal(remote.calls.publish.length, 0);
});

test('only E404 means missing; authentication failure does not publish or expose credentials', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  remote.hooks.query = () => {
    throw npmError('E401');
  };
  await assert.rejects(
    planImport(f.bundle, options(f, remote)),
    (error) =>
      /Registry query failed.*E401/.test(error.message) &&
      !error.message.includes('secret-test-token'),
  );
  assert.equal(remote.calls.publish.length, 0);
});

test('预检失败后可使用同一空 run 目录重新导入', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  remote.hooks.query = () => {
    throw npmError('E401');
  };
  await assert.rejects(importBundle(f.bundle, options(f, remote)), /Registry query failed.*E401/);
  assert.deepEqual(await readdir(f.runDir), []);
  assert.equal(remote.calls.publish.length, 0);
  delete remote.hooks.query;
  assert.equal((await importBundle(f.bundle, options(f, remote))).phase, 'versions-ready');
  assert.equal(remote.calls.publish.length, 1);
});

test('非空且状态不完整的 run 目录不能被重新初始化', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  for (const name of ['identity.json', 'state.json', 'notes.txt']) {
    const runDir = path.join(f.root, name.replace('.', '-'));
    await mkdir(runDir);
    const file = path.join(runDir, name);
    await writeFile(file, '{}');
    await assert.rejects(
      importBundle(f.bundle, options(f, remote, { runDir })),
      /no complete original identity\/state/,
    );
    assert.equal(await readFile(file, 'utf8'), '{}');
    assert.deepEqual(await readdir(runDir), [name]);
  }
  assert.equal(remote.calls.publish.length, 0);
});

test('target artifact metadata cannot fetch from an external origin', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  const item = remote.seed(f.pkg);
  item.versions.get(f.pkg.version).tarball = 'https://external.example/demo.tgz';
  await assert.rejects(planImport(f.bundle, options(f, remote)), /target registry origin/);
  assert.equal(remote.calls.pack.length, 0);
});

test('publish success with a lost response is reconciled through remote byte verification', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  remote.hooks.afterPublish = () => {
    throw npmError('ETIMEDOUT');
  };
  assert.equal((await importBundle(f.bundle, options(f, remote))).phase, 'versions-ready');
  assert.equal(remote.calls.publish.length, 1);
});

test('multiple versions share an owned temporary tag without requiring latest to exist', async (t) => {
  const f = await fixture(t, { versions: ['1.0.0', '2.0.0'] });
  const remote = registryAdapter();
  remote.seed({ name: f.pkg.name, version: '0.9.0' }, { stable: '0.9.0' });
  const imported = await importBundle(f.bundle, options(f, remote));
  assert.deepEqual(imported.temporaryTags[f.pkg.name].versions, ['1.0.0', '2.0.0']);
  assert.equal(remote.get(f.pkg.name).tags[imported.temporaryTag], '2.0.0');
  assert.ok(!Object.hasOwn(remote.get(f.pkg.name).tags, 'latest'));
  assert.deepEqual((await readJson(path.join(f.runDir, 'identity.json'))).tagSnapshot[f.pkg.name], {
    stable: '0.9.0',
  });
  await importBundle(f.bundle, options(f, remote));
  assert.equal(remote.calls.publish.length, 2);
  await promoteRun(f.runDir, { adapter: remote.adapter, acceptanceFile: await acceptanceFile(f) });
  assert.deepEqual(remote.get(f.pkg.name).tags, { stable: '0.9.0', latest: '2.0.0' });
  await rollbackRun(f.runDir, { adapter: remote.adapter });
  assert.deepEqual(remote.get(f.pkg.name).tags, { stable: '0.9.0' });
  assert.ok(f.pkgs.every((pkg) => remote.get(pkg.name).versions.has(pkg.version)));
});

test('failed import resumes using its original snapshot, including tags changed afterwards', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  remote.seed({ name: f.pkg.name, version: '0.9.0' }, { latest: '0.9.0' });
  remote.hooks.beforePublish = () => {
    throw npmError('E403');
  };
  await assert.rejects(importBundle(f.bundle, options(f, remote)), /Publishing failed.*E403/);
  const identityBytes = await readFile(path.join(f.runDir, 'identity.json'));
  remote.seed({ name: f.pkg.name, version: '0.8.0' }, { latest: '0.8.0' });
  delete remote.hooks.beforePublish;
  await importBundle(f.bundle, options(f, remote));
  assert.deepEqual(await readFile(path.join(f.runDir, 'identity.json')), identityBytes);
  await assert.rejects(
    promoteRun(f.runDir, {
      adapter: remote.adapter,
      acceptanceFile: await acceptanceFile(f),
      overwriteTags: true,
    }),
    /Tag changed outside this run/,
  );
  assert.equal(remote.get(f.pkg.name).tags.latest, '0.8.0');
});

test('promotion binds acceptance to both endpoints, targets, digest and resource review', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  await importBundle(f.bundle, options(f, remote));
  for (const override of [
    { readRegistry: REGISTRY },
    { writeRegistry: READ_REGISTRY },
    { manifestDigest: 'wrong' },
    { targets: [{ os: 'darwin' }] },
    { evidence: [] },
    { resourceReview: 'pending' },
  ]) {
    await assert.rejects(
      promoteRun(f.runDir, {
        adapter: remote.adapter,
        acceptanceFile: await acceptanceFile(f, override),
      }),
      /Acceptance record must match/,
    );
  }
  assert.equal(remote.calls.tag.length, 0);
});

test('formal tag overwrite requires a gate; successful promotion cleans its temporary tag and rollback retains versions', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  remote.seed({ name: f.pkg.name, version: '0.9.0' }, { latest: '0.9.0' });
  const imported = await importBundle(f.bundle, options(f, remote));
  const accepted = await acceptanceFile(f);
  await assert.rejects(
    promoteRun(f.runDir, { adapter: remote.adapter, acceptanceFile: accepted }),
    /requires --overwrite-tags/,
  );
  assert.equal(remote.get(f.pkg.name).tags.latest, '0.9.0');
  const promoted = await promoteRun(f.runDir, {
    adapter: remote.adapter,
    acceptanceFile: accepted,
    overwriteTags: true,
  });
  assert.equal(promoted.phase, 'promoted');
  assert.equal(remote.get(f.pkg.name).tags.latest, '1.0.0');
  assert.ok(!Object.hasOwn(remote.get(f.pkg.name).tags, imported.temporaryTag));
  const rolledBack = await rollbackRun(f.runDir, { adapter: remote.adapter });
  assert.equal(rolledBack.phase, 'rolled-back');
  assert.equal(remote.get(f.pkg.name).tags.latest, '0.9.0');
  assert.ok(remote.get(f.pkg.name).versions.has('1.0.0'));
  await assert.rejects(importBundle(f.bundle, options(f, remote)), /Rollback run is closed/);
  assert.equal((await rollbackRun(f.runDir, { adapter: remote.adapter })).phase, 'rolled-back');
});

test('rollback refuses to overwrite external changes and blocks re-import until rollback finishes', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  await importBundle(f.bundle, options(f, remote));
  await promoteRun(f.runDir, { adapter: remote.adapter, acceptanceFile: await acceptanceFile(f) });
  remote.seed({ name: f.pkg.name, version: '2.0.0' }, { latest: '2.0.0' });
  const result = await rollbackRun(f.runDir, { adapter: remote.adapter });
  assert.equal(result.phase, 'rollback-pending');
  assert.deepEqual(result.rollbackPending, [`${f.pkg.name}:latest`]);
  assert.equal(remote.get(f.pkg.name).tags.latest, '2.0.0');
  await assert.rejects(importBundle(f.bundle, options(f, remote)), /Rollback run is closed/);
  remote.get(f.pkg.name).tags.latest = '1.0.0';
  assert.equal((await rollbackRun(f.runDir, { adapter: remote.adapter })).phase, 'rolled-back');
  assert.ok(!Object.hasOwn(remote.get(f.pkg.name).tags, 'latest'));
});

test('interrupted promotion reconciles a persisted intent and preserves the original snapshot', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  remote.seed({ name: f.pkg.name, version: '0.9.0' }, { latest: '0.9.0' });
  await importBundle(f.bundle, options(f, remote));
  const identityBytes = await readFile(path.join(f.runDir, 'identity.json'));
  const state = await readJson(path.join(f.runDir, 'state.json'));
  state.phase = 'promoting';
  state.tagIntents = [
    { name: f.pkg.name, tag: 'latest', before: '0.9.0', after: '1.0.0', status: 'pending' },
  ];
  await writeJson(path.join(f.runDir, 'state.json'), state);
  remote.get(f.pkg.name).tags.latest = '1.0.0';
  await assert.rejects(importBundle(f.bundle, options(f, remote)), /Promotion was interrupted/);
  assert.equal(
    (
      await promoteRun(f.runDir, {
        adapter: remote.adapter,
        acceptanceFile: await acceptanceFile(f),
        overwriteTags: true,
      })
    ).phase,
    'promoted',
  );
  assert.deepEqual(await readFile(path.join(f.runDir, 'identity.json')), identityBytes);
  await rollbackRun(f.runDir, { adapter: remote.adapter });
  assert.equal(remote.get(f.pkg.name).tags.latest, '0.9.0');
});

test('a lost tag-write response rolls back only this run and can be retried', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  const imported = await importBundle(f.bundle, options(f, remote));
  const accepted = await acceptanceFile(f);
  remote.hooks.afterTag = ({ tag, version }) => {
    if (tag === 'latest' && version !== null) {
      delete remote.hooks.afterTag;
      throw npmError('ETIMEDOUT');
    }
  };
  await assert.rejects(
    promoteRun(f.runDir, { adapter: remote.adapter, acceptanceFile: accepted }),
    /Tag write failed.*ETIMEDOUT/,
  );
  const failed = await readJson(path.join(f.runDir, 'state.json'));
  assert.equal(failed.phase, 'promotion-failed');
  assert.equal(failed.tagIntents[0].status, 'reverted');
  assert.ok(!Object.hasOwn(remote.get(f.pkg.name).tags, 'latest'));
  assert.equal(remote.get(f.pkg.name).tags[imported.temporaryTag], '1.0.0');
  assert.equal(
    (await promoteRun(f.runDir, { adapter: remote.adapter, acceptanceFile: accepted })).phase,
    'promoted',
  );
  assert.equal(remote.get(f.pkg.name).tags.latest, '1.0.0');
});

test('temporary tag cleanup checks version ownership before deletion', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  const imported = await importBundle(f.bundle, options(f, remote));
  remote.seed({ name: f.pkg.name, version: '2.0.0' }, { [imported.temporaryTag]: '2.0.0' });
  const result = await rollbackRun(f.runDir, { adapter: remote.adapter });
  assert.equal(result.phase, 'rollback-pending');
  assert.deepEqual(result.cleanupPending, [f.pkg.name]);
  assert.equal(remote.get(f.pkg.name).tags[imported.temporaryTag], '2.0.0');
  assert.equal(remote.calls.tag.length, 0);
  remote.get(f.pkg.name).tags[imported.temporaryTag] = '1.0.0';
  assert.equal((await rollbackRun(f.runDir, { adapter: remote.adapter })).phase, 'rolled-back');
});

test('modified identity or original snapshot is rejected before any remote write', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  await importBundle(f.bundle, options(f, remote));
  const file = path.join(f.runDir, 'identity.json');
  const identity = await readJson(file);
  identity.tagSnapshot[f.pkg.name].latest = '2.0.0';
  await writeJson(file, identity);
  await assert.rejects(
    rollbackRun(f.runDir, { adapter: remote.adapter }),
    /original tag snapshot changed/,
  );
  assert.equal(remote.calls.tag.length, 0);
});

test('promoted runs validate existing bytes and never recreate a deleted version or undo externally changed tags', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  await importBundle(f.bundle, options(f, remote));
  const accepted = await acceptanceFile(f);
  await promoteRun(f.runDir, { adapter: remote.adapter, acceptanceFile: accepted });
  assert.equal((await importBundle(f.bundle, options(f, remote))).phase, 'promoted');
  assert.equal(
    (await promoteRun(f.runDir, { adapter: remote.adapter, acceptanceFile: accepted })).phase,
    'promoted',
  );
  remote.seed({ name: f.pkg.name, version: '2.0.0' }, { latest: '2.0.0' });
  await assert.rejects(
    promoteRun(f.runDir, { adapter: remote.adapter, acceptanceFile: accepted }),
    /Promoted tags changed outside this run/,
  );
  assert.equal(remote.get(f.pkg.name).tags.latest, '2.0.0');
  remote.get(f.pkg.name).versions.delete('1.0.0');
  await assert.rejects(importBundle(f.bundle, options(f, remote)), /Required version is missing/);
  assert.equal(remote.calls.publish.length, 1);
  assert.equal((await readJson(path.join(f.runDir, 'state.json'))).phase, 'promoted');
});

test('repacked artifacts require explicit recovery mode and run paths cannot be inside the bundle', async (t) => {
  const f = await fixture(t, { artifactKind: 'installed-repack' });
  const remote = registryAdapter();
  await assert.rejects(planImport(f.bundle, options(f, remote)), /require --recovery/);
  await assert.rejects(
    importBundle(
      f.bundle,
      options(f, remote, { recovery: true, runDir: path.join(f.bundle, '..run') }),
    ),
    /outside the frozen bundle/,
  );
  const alias = path.join(f.root, 'bundle-alias');
  await symlink(f.bundle, alias);
  await assert.rejects(
    importBundle(
      f.bundle,
      options(f, remote, { recovery: true, runDir: path.join(alias, 'nested', 'run') }),
    ),
    /outside the frozen bundle/,
  );
  assert.equal(
    (await importBundle(f.bundle, options(f, remote, { recovery: true }))).phase,
    'versions-ready',
  );
});

test('promotion rejects a bundle whose resource audit is still pending', async (t) => {
  const f = await fixture(t, { resourceReview: 'pending' });
  const remote = registryAdapter();
  await importBundle(f.bundle, options(f, remote));
  await assert.rejects(
    promoteRun(f.runDir, { adapter: remote.adapter, acceptanceFile: await acceptanceFile(f) }),
    /completed resource review/,
  );
});

test('plan and import report progress and per-call upload/reuse/download byte statistics', async (t) => {
  const f = await fixture(t, { versions: ['1.0.0', '2.0.0'] });
  const remote = registryAdapter();
  remote.seed(f.pkgs[1]);
  const events = [];
  const tracked = options(f, remote, { onProgress: (event) => events.push(event) });
  const plan = await planImport(f.bundle, tracked);
  assert.deepEqual(plan.stats, {
    total: 2,
    uploaded: 0,
    reused: 1,
    downloaded: 1,
    downloadBytes: f.pkgs[1].size,
    uploadBytes: 0,
  });
  assert.equal(events[0].completed, 0);
  assert.equal(events.at(-1).completed, 2);
  events.length = 0;
  remote.hooks.pack = () => {
    const event = events.at(-1);
    assert.equal(event.name, f.pkg.name);
    assert.ok(['1.0.0', '2.0.0'].includes(event.version));
    assert.ok(event.completed < event.total);
  };
  remote.hooks.beforePublish = () => assert.equal(events.at(-1).completed, 0);
  remote.hooks.afterPublish = () => {
    throw npmError('ETIMEDOUT');
  };
  const imported = await importBundle(f.bundle, tracked);
  assert.deepEqual(imported.stats, {
    total: 2,
    uploaded: 1,
    reused: 1,
    downloaded: 3,
    downloadBytes: f.pkgs[0].size + f.pkgs[1].size * 2,
    uploadBytes: f.pkgs[0].size,
  });
  assert.deepEqual(
    events
      .filter((event) => event.phase === 'import' && event.completed > 0)
      .map((event) => event.completed)
      .filter((value, index, values) => !index || value !== values[index - 1]),
    [1, 2],
  );
  assert.equal(events.at(-1).completed, 2);
  assert.equal(events.at(-1).uploaded, 1);
  assert.ok(
    events.every(
      (event) =>
        !JSON.stringify(event).includes('https://') &&
        !JSON.stringify(event).includes('secret-test-token'),
    ),
  );
  assert.equal((await readJson(path.join(f.runDir, 'state.json'))).stats, undefined);
  const repeated = await importBundle(f.bundle, tracked);
  assert.deepEqual(repeated.stats, {
    total: 2,
    uploaded: 0,
    reused: 2,
    downloaded: 2,
    downloadBytes: f.pkgs[0].size + f.pkgs[1].size,
    uploadBytes: 0,
  });
});

test('promote and rollback report verification and tag progress without counting tag writes as package uploads', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  await importBundle(f.bundle, options(f, remote));
  const events = [];
  const tracked = { adapter: remote.adapter, onProgress: (event) => events.push(event) };
  const promoted = await promoteRun(f.runDir, {
    ...tracked,
    acceptanceFile: await acceptanceFile(f),
  });
  assert.deepEqual(promoted.stats, {
    total: 1,
    uploaded: 0,
    reused: 1,
    downloaded: 1,
    downloadBytes: f.pkg.size,
    uploadBytes: 0,
  });
  for (const phase of ['promote', 'promote-tags', 'cleanup']) {
    assert.ok(events.some((event) => event.phase === phase && event.completed === 0));
    assert.ok(events.some((event) => event.phase === phase && event.completed === 1));
  }
  events.length = 0;
  const rolledBack = await rollbackRun(f.runDir, tracked);
  assert.deepEqual(rolledBack.stats, {
    total: 1,
    uploaded: 0,
    reused: 0,
    downloaded: 0,
    downloadBytes: 0,
    uploadBytes: 0,
  });
  assert.ok(events.some((event) => event.phase === 'rollback' && event.completed === 1));
  assert.ok(events.some((event) => event.phase === 'cleanup' && event.completed === 1));
});

test('remote artifact byte accounting falls back to file size when an adapter omits size', async (t) => {
  const f = await fixture(t);
  const remote = registryAdapter();
  const artifact = remote.seed(f.pkg).versions.get(f.pkg.version);
  delete artifact.size;
  artifact.file = path.join(f.bundle, f.pkg.file);
  const planned = await planImport(f.bundle, options(f, remote));
  assert.equal(planned.stats.downloadBytes, f.pkg.size);
});
