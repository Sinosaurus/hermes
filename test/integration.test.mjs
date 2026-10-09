import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { recover } from '../src/collect.mjs';
import { importBundle, promoteRun, rollbackRun } from '../src/publish.mjs';
import { command, npmCommand, packArtifact, readArtifact, readJson } from '../src/common.mjs';

async function fixture(root, name, version, marker, dependencies = {}) {
  const directory = path.join(root, name.replace(/[^a-z0-9]/gi, '_'), version);
  const packageDirectory = path.join(directory, 'package');
  await mkdir(packageDirectory, { recursive: true });
  const hook = `node -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")'`;
  const packageJson = { name, version, dependencies, scripts: Object.fromEntries(['prepare', 'prepack', 'postpack', 'prepublishOnly', 'publish', 'postpublish', 'preinstall', 'install', 'postinstall'].map(name => [name, hook])) };
  await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify(packageJson));
  await writeFile(path.join(packageDirectory, 'index.js'), 'module.exports = "fixture";\n');
  const tarball = path.join(directory, 'fixture.tgz');
  await command('tar', ['-czf', tarball, '-C', directory, 'package']);
  const bytes = await readFile(tarball);
  return { packageJson, packageDirectory, bytes, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
}

async function registry() {
  const packages = new Map(), writes = [], errors = [], requests = [];
  let base;
  const send = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      requests.push({ method: request.method, path: pathname });
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      const tagMatch = /^\/-\/package\/(.+)\/dist-tags(?:\/([^/]+))?$/.exec(pathname);
      if (tagMatch) {
        const [, name, tag] = tagMatch, entry = packages.get(name);
        if (!entry) return send(response, 404, { error: 'Not found' });
        if (request.method === 'GET') return send(response, 200, entry.tags);
        if (request.method === 'PUT' && tag) {
          assert.ok(entry.versions[body], 'Tag target must exist');
          entry.tags[tag] = body;
        } else if (request.method === 'DELETE' && tag) delete entry.tags[tag];
        else return send(response, 405, { error: 'Unsupported tag method' });
        writes.push({ method: request.method, name, tag });
        return send(response, 200, { ok: true });
      }
      const artifact = /^\/(.+)\/-\/(.+)$/.exec(pathname);
      if (artifact) {
        const entry = packages.get(artifact[1]);
        const bytes = entry?.tarballs[artifact[2]];
        if (!bytes) return send(response, 404, { error: 'Not found' });
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
        return response.end(bytes);
      }
      const name = pathname.slice(1);
      if (request.method === 'PUT') {
        assert.equal(request.headers.authorization, 'Bearer local-fixture-token');
        const entry = packages.get(name) ?? { versions: {}, tags: {}, tarballs: {} };
        for (const [version, metadata] of Object.entries(body.versions)) {
          assert.equal(entry.versions[version], undefined, 'An existing version must never be republished');
          entry.versions[version] = metadata;
        }
        for (const [filename, attachment] of Object.entries(body._attachments)) entry.tarballs[filename] = Buffer.from(attachment.data, 'base64');
        Object.assign(entry.tags, body['dist-tags']);
        packages.set(name, entry);
        writes.push({ method: 'publish', name, tags: { ...body['dist-tags'] } });
        return send(response, 201, { ok: true });
      }
      const entry = packages.get(name);
      if (request.method === 'GET' && entry) return send(response, 200, { _id: name, name, 'dist-tags': entry.tags, versions: entry.versions });
      return send(response, 404, { error: 'Not found' });
    } catch (error) { errors.push(error); send(response, 500, { error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/`;
  return {
    base, packages, writes, errors, requests,
    seed(item, tags = {}) {
      const { name, version } = item.packageJson;
      const filename = `${name.split('/').at(-1)}-${version}.tgz`;
      const entry = packages.get(name) ?? { versions: {}, tags: {}, tarballs: {} };
      entry.versions[version] = { ...item.packageJson, dist: { tarball: `${base}${name}/-/${filename}`, integrity: item.integrity, shasum: createHash('sha1').update(item.bytes).digest('hex') } };
      entry.tarballs[filename] = item.bytes;
      Object.assign(entry.tags, tags);
      packages.set(name, entry);
    },
    close() { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); },
  };
}

test('native npm collects immutable dependency tarballs, imports with staging tags, promotes and rolls back', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'offline-npm-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await registry(), target = await registry();
  t.after(() => Promise.all([source.close(), target.close()]));
  const previous = { NPM_CONFIG_USERCONFIG: process.env.NPM_CONFIG_USERCONFIG, OFFLINE_NPM_CACHE: process.env.OFFLINE_NPM_CACHE };
  const userconfig = path.join(root, 'npmrc');
  await writeFile(userconfig, `//127.0.0.1:${new URL(target.base).port}/:_authToken=local-fixture-token\nfetch-retries=0\nfetch-timeout=10000\n`);
  process.env.NPM_CONFIG_USERCONFIG = userconfig;
  process.env.OFFLINE_NPM_CACHE = path.join(root, 'cache');
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const marker = path.join(root, 'hooks-ran');
  const leaf = await fixture(root, 'native-leaf', '1.0.0', marker);
  const dependency = await fixture(root, '@fixture/native-dependency', '1.0.0', marker, { 'native-leaf': '^1.0.0' });
  const oldRoot = await fixture(root, 'native-root', '1.0.0', marker);
  const newRoot = await fixture(root, 'native-root', '2.0.0', marker, { '@fixture/native-dependency': '^1.0.0' });
  source.seed(leaf, { latest: '1.0.0' });
  source.seed(dependency, { latest: '1.0.0' });
  source.seed(newRoot, { latest: '2.0.0', beta: '2.0.0' });
  target.seed(oldRoot, { latest: '1.0.0' });
  const resourcesFile = path.join(root, 'resources.json');
  await writeFile(resourcesFile, JSON.stringify({ resources: [], review: { status: 'reviewed', evidence: ['Local fixture has no additional resources'] } }));
  const bundle = path.join(root, 'bundle'), runDir = path.join(root, 'run');
  const packagesFile = path.join(root, 'packages.json');
  await writeFile(packagesFile, JSON.stringify(['native-root@2.0.0', 'native-root@2.0.0']));
  const collected = JSON.parse(await command(process.execPath, ['src/cli.mjs', 'collect', '--packages-file', packagesFile, '--package', 'native-leaf@1.0.0', '--out', bundle, '--registry', source.base, '--resources', resourcesFile, '--progress', 'none']));
  const manifest = await readJson(path.join(bundle, 'manifest.json'));
  const { manifestDigest } = collected;
  assert.equal(manifest.roots.length, 2);
  assert.equal(collected.stats.total, 3);
  assert.equal(collected.stats.downloaded, 3);
  assert.equal(collected.stats.reused, 1);
  assert.equal(collected.stats.downloadBytes, leaf.bytes.length + dependency.bytes.length + newRoot.bytes.length);
  assert.deepEqual(manifest.packages.map(pkg => pkg.name).sort(), ['@fixture/native-dependency', 'native-leaf', 'native-root']);
  const expected = new Map([leaf, dependency, newRoot].map(item => [item.packageJson.name, item]));
  for (const pkg of manifest.packages) {
    assert.deepEqual(await readFile(path.join(bundle, pkg.file)), expected.get(pkg.name).bytes, 'Collection must preserve exact original tarball bytes');
    assert.equal(pkg.sourceIntegrity, expected.get(pkg.name).integrity);
    assert.ok((await readArtifact(path.join(bundle, pkg.file))).packageJson.scripts.prepare);
  }
  await assert.rejects(access(marker), { code: 'ENOENT' });
  const imported = await importBundle(bundle, { registry: target.base, runDir });
  assert.equal(imported.phase, 'versions-ready');
  assert.equal(target.packages.get('native-root').tags.latest, '1.0.0');
  assert.equal(target.packages.get('native-root').tags[imported.temporaryTag], '2.0.0');
  assert.equal(target.writes.filter(write => write.method === 'publish').length, 3);
  assert.deepEqual(await importBundle(bundle, { registry: target.base, runDir }).then(result => result.versions), imported.versions);
  assert.equal(target.writes.filter(write => write.method === 'publish').length, 3, 'Repeated import must reuse existing versions');
  const consumer = path.join(root, 'consumer');
  await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'native-consumer', version: '1.0.0', private: true }));
  const priorCache = process.env.OFFLINE_NPM_CACHE;
  process.env.OFFLINE_NPM_CACHE = path.join(root, 'consumer-cache');
  try {
    await npmCommand(['install', 'native-root@2.0.0', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumer, registry: target.base });
  } finally { process.env.OFFLINE_NPM_CACHE = priorCache; }
  for (const pkg of manifest.packages) {
    assert.equal((await readJson(path.join(consumer, 'node_modules', pkg.name, 'package.json'))).version, pkg.version);
  }
  await assert.rejects(access(marker), { code: 'ENOENT' });
  const identity = await readJson(path.join(runDir, 'identity.json'));
  const acceptanceFile = path.join(root, 'acceptance.json');
  await writeFile(acceptanceFile, JSON.stringify({ status: 'passed', manifestDigest, writeRegistry: target.base, readRegistry: identity.readRegistry ?? target.base, targets: manifest.targets, resourceReview: 'reviewed', evidence: ['Fresh-cache npm install from target succeeds with scripts disabled; fixture requires no external resources'] }));
  const promoted = await promoteRun(runDir, { acceptanceFile, overwriteTags: true });
  assert.equal(promoted.phase, 'promoted');
  assert.deepEqual(promoted.cleanupPending, []);
  assert.deepEqual(target.packages.get('native-root').tags, { latest: '2.0.0', beta: '2.0.0' });
  for (const pkg of manifest.packages) {
    const remote = target.packages.get(pkg.name);
    assert.equal(remote.tags[imported.temporaryTag], undefined);
    const filename = decodeURIComponent(new URL(remote.versions[pkg.version].dist.tarball).pathname.split('/-/').at(-1));
    assert.deepEqual(remote.tarballs[filename], expected.get(pkg.name).bytes, 'Publishing must preserve collected tarball bytes');
  }
  const rolledBack = await rollbackRun(runDir);
  assert.equal(rolledBack.phase, 'rolled-back');
  assert.deepEqual(target.packages.get('native-root').tags, { latest: '1.0.0' });
  assert.deepEqual(target.packages.get('@fixture/native-dependency').tags, {});
  assert.ok(target.packages.get('native-root').versions['2.0.0'], 'Rollback retains immutable versions');
  assert.equal((await rollbackRun(runDir)).phase, 'rolled-back');
  await assert.rejects(access(marker), { code: 'ENOENT' });
  assert.deepEqual(source.errors, []);
  assert.deepEqual(target.errors, []);
  assert.equal([...source.requests, ...target.requests].filter(request => request.path === '/npm').length, 0, 'npm must not issue unrelated update-notifier requests');
});

test('verified native npm pack --ignore-scripts skips prepare without deleting package scripts', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'offline-npm-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'hooks-ran');
  const item = await fixture(root, 'native-hooks', '1.0.0', marker);
  const packed = await packArtifact(item.packageDirectory, path.join(root, 'packed'), { cwd: root });
  await assert.rejects(access(marker), { code: 'ENOENT' });
  assert.deepEqual(packed.packageJson.scripts, item.packageJson.scripts);
  assert.ok((await readArtifact(packed.file)).packageJson.scripts.prepare);
});


test('native recovery packs nested pnpm instances with progress, without executing scripts', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'offline-npm-recovery-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = path.join(root, 'node_modules');
  const marker = path.join(root, 'hooks-ran');
  const first = await fixture(root, 'recovery-root', '1.0.0', marker);
  const second = await fixture(root, '@fixture/recovery-leaf', '2.0.0', marker);
  const fs = await import('node:fs/promises');
  await fs.cp(first.packageDirectory, path.join(modules, 'recovery-root'), { recursive: true });
  const leaf = path.join(modules, '.pnpm', 'leaf@2.0.0', 'node_modules', '@fixture', 'recovery-leaf');
  await fs.mkdir(path.dirname(leaf), { recursive: true });
  await fs.cp(second.packageDirectory, leaf, { recursive: true });
  const nested = path.join(modules, 'recovery-root', 'node_modules', '@fixture');
  await fs.mkdir(nested, { recursive: true });
  await fs.symlink(leaf, path.join(nested, 'recovery-leaf'));
  const events = [];
  const recovered = await recover({ modules, out: path.join(root, 'bundle'), repack: true, onProgress: event => events.push(event) });
  assert.equal(recovered.manifest.packages.length, 2);
  assert.equal(recovered.stats.repacked, 2);
  assert.equal(recovered.stats.downloaded, 0);
  assert.ok(recovered.stats.packedBytes > 0);
  assert.equal(events.filter(event => event.phase === 'repack').at(-1).completed, 2);
  for (const pkg of recovered.manifest.packages) assert.ok((await readArtifact(path.join(root, 'bundle', pkg.file))).packageJson.scripts.prepare);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});
