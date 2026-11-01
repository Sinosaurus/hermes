import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { exportResources } from '../src/core/resource-export.js';
import { command, writeJson, fileHash } from '../src/lib/index.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hermes-export-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle');
  await mkdir(path.join(root, 'source/package'), { recursive: true });
  await writeJson(path.join(root, 'source/package/package.json'), {
    name: 'example',
    version: '1.0.0',
  });
  await mkdir(path.join(bundle, 'packages'), { recursive: true });
  await mkdir(path.join(bundle, 'resources/tool'), { recursive: true });
  await command('tar', [
    '-czf',
    path.join(bundle, 'packages/one.tgz'),
    '-C',
    path.join(root, 'source'),
    'package',
  ]);
  await writeFile(path.join(bundle, 'resources/tool/data.bin'), 'verified binary');
  const hashes = Object.fromEntries(
    await Promise.all(
      ['packages/one.tgz', 'resources/tool/data.bin'].map(async (file) => [
        file,
        await fileHash(path.join(bundle, file)),
      ]),
    ),
  );
  const integrity = `sha512-${await fileHash(path.join(bundle, 'packages/one.tgz'), 'sha512', 'base64')}`;
  const manifest = {
    schemaVersion: 1,
    status: 'complete',
    batchId: 'fixture',
    packages: [
      {
        id: 'one',
        name: 'example',
        version: '1.0.0',
        file: 'packages/one.tgz',
        sha256: hashes['packages/one.tgz'],
        artifactIntegrity: integrity,
        sourceIntegrity: integrity,
        artifactKind: 'registry-original',
      },
    ],
    files: hashes,
    tagPlan: [],
    targets: [{ os: 'linux', cpu: 'x64' }],
    resources: [
      {
        id: 'tool',
        targets: [{ os: 'win32', cpu: 'x64' }],
        instructions: 'Map the URL explicitly.',
        files: ['resources/tool/data.bin'],
        environment: { TOOL_URL: '{{baseUrl}}/resources/tool/data.bin' },
      },
    ],
    resourceReview: { status: 'pending' },
  };
  await writeJson(path.join(bundle, 'manifest.json'), manifest);
  hashes['manifest.json'] = await fileHash(path.join(bundle, 'manifest.json'));
  await writeFile(
    path.join(bundle, 'checksums.sha256'),
    Object.keys(hashes)
      .sort()
      .map((file) => `${hashes[file]}  ${file}`)
      .join('\n') + '\n',
  );
  return { root, bundle };
}

test('offline resource export verifies, copies and maps without changing the bundle', async (t) => {
  const { root, bundle } = await fixture(t);
  const before = await readFile(path.join(bundle, 'manifest.json'));
  const out = path.join(root, 'export');
  const result = await exportResources(bundle, out, 'http://intranet/assets');
  assert.equal(result.files, 1);
  assert.equal(
    await readFile(path.join(out, 'resources/tool/data.bin'), 'utf8'),
    'verified binary',
  );
  const map = JSON.parse(await readFile(path.join(out, 'resource-map.json'), 'utf8'));
  assert.equal(map.resources[0].urls[0].url, 'http://intranet/assets/resources/tool/data.bin');
  assert.equal(
    map.resources[0].environment.TOOL_URL,
    'http://intranet/assets/resources/tool/data.bin',
  );
  assert.deepEqual(await readFile(path.join(bundle, 'manifest.json')), before);
  await assert.rejects(exportResources(bundle, out, 'http://intranet'), /EEXIST/);
  await assert.rejects(
    exportResources(bundle, path.join(bundle, 'nested'), 'http://intranet'),
    /outside/,
  );
});

test('resource export rejects invalid base URLs and tampered inputs before output', async (t) => {
  const { root, bundle } = await fixture(t);
  await assert.rejects(
    exportResources(bundle, path.join(root, 'export'), 'https://user:secret@host'),
    /credentials/,
  );
  await writeFile(path.join(bundle, 'resources/tool/data.bin'), 'tampered');
  await assert.rejects(
    exportResources(bundle, path.join(root, 'export'), 'http://intranet'),
    /checksum/,
  );
});

test('frozen resource declarations reject invalid provenance and target shapes', async (t) => {
  const { root, bundle } = await fixture(t);
  const original = JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
  const goodDownload = {
    url: 'https://vendor.example/tool',
    filename: 'data.bin',
    size: 15,
    sha256: original.files['resources/tool/data.bin'],
  };
  const cases = [
    { download: null },
    { download: { ...goodDownload, url: 'http://vendor.example/tool' } },
    { download: { ...goodDownload, size: 999 } },
    { targets: [{}] },
  ];
  for (const changes of cases) {
    const manifest = structuredClone(original);
    Object.assign(manifest.resources[0], changes);
    await writeJson(path.join(bundle, 'manifest.json'), manifest);
    const hashes = {
      ...manifest.files,
      'manifest.json': await fileHash(path.join(bundle, 'manifest.json')),
    };
    await writeFile(
      path.join(bundle, 'checksums.sha256'),
      Object.keys(hashes)
        .sort()
        .map((file) => `${hashes[file]}  ${file}`)
        .join('\n') + '\n',
    );
    await assert.rejects(
      exportResources(bundle, path.join(root, 'export'), 'https://static.intranet'),
      /resource|Resource/,
    );
  }
});
