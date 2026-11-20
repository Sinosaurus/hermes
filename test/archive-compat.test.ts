import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { readArtifact } from '../src/lib/artifacts.js';

function entry(name: string, content = '', type = '0', mode = 0o644, prefix = '') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  const number = (value: number, offset: number, length: number) =>
    header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  number(mode, 100, 8);
  number(0, 108, 8);
  number(0, 116, 8);
  number(Buffer.byteLength(content), 124, 12);
  number(1, 136, 12);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  header.write(prefix, 345, 155);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const body = Buffer.from(content);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
const manifest = JSON.stringify({ name: '@types/example', version: '1.0.0' });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hermes-archive-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  let index = 0;
  return async (entries: Buffer[], trailer = Buffer.alloc(1024)) => {
    const file = path.join(root, `${index++}.tgz`);
    await writeFile(file, gzipSync(Buffer.concat([...entries, trailer])));
    return file;
  };
}

test('single non-package root and byte-identical internal dot alias retain original members', async (t) => {
  const make = await fixture(t);
  const file = await make([
    entry('example/package.json', manifest),
    entry('example/./dist/a.js', 'a'),
    entry('example/dist/a.js', 'a'),
  ]);
  const actual = await readArtifact(file);
  assert.equal(actual.packageJson.name, '@types/example');
  assert.deepEqual(actual.members, [
    'example/package.json',
    'example/./dist/a.js',
    'example/dist/a.js',
  ]);
});

test('reject ambiguous aliases, same-name duplicates and duplicate manifest even with equal bytes', async (t) => {
  const make = await fixture(t);
  for (const pair of [
    [entry('package/./a', 'a'), entry('package/a', 'b')],
    [entry('package/./a', 'a'), entry('package/a', 'a', '0', 0o755)],
    [entry('package/a', 'a'), entry('package/a', 'a')],
    [entry('package/a/', '', '5'), entry('package/a', '')],
    [entry('package/./package.json', manifest)],
  ])
    await assert.rejects(
      readArtifact(await make([entry('package/package.json', manifest), ...pair])),
      /duplicate|collision|exactly one/i,
    );
});

test('reject traversal, absolute, backslash, control, root ambiguity, links and file parents', async (t) => {
  const make = await fixture(t);
  for (const name of [
    'package/../x',
    '/package/x',
    'package\\x',
    'package/\nx',
    'package//x',
    './package/x',
    'other/x',
    'package/C:x',
  ])
    await assert.rejects(
      readArtifact(await make([entry('package/package.json', manifest), entry(name)])),
    );
  for (const type of ['1', '2', '3', '4', '6', 'S'])
    await assert.rejects(
      readArtifact(
        await make([entry('package/package.json', manifest), entry('package/a', '', type)]),
      ),
      /links|special/,
    );
  await assert.rejects(
    readArtifact(
      await make([
        entry('package/package.json', manifest),
        entry('package/a'),
        entry('package/a/b'),
      ]),
    ),
    /collision/,
  );
  await assert.rejects(
    readArtifact(await make([entry('package/package.json', '', '5')])),
    /regular/,
  );
});

test('ustar long prefix works; GNU/PAX extension headers fail closed explicitly', async (t) => {
  const make = await fixture(t);
  const prefix = `package/${'a'.repeat(120)}`;
  const result = await readArtifact(
    await make([entry('package/package.json', manifest), entry('b.js', 'ok', '0', 0o644, prefix)]),
  );
  assert.ok(result.members.includes(`${prefix}/b.js`));
  for (const type of ['x', 'g', 'L', 'K'])
    await assert.rejects(
      readArtifact(
        await make([
          entry('package/package.json', manifest),
          entry('package/extension', 'legitimate-extension', type),
        ]),
      ),
      /extensions/,
    );
});

test('reject corrupt checksum, truncated body/end and hidden trailing archive', async (t) => {
  const make = await fixture(t);
  const bad = entry('package/package.json', manifest);
  bad[10] = 90;
  await assert.rejects(readArtifact(await make([bad])), /checksum/);
  await assert.rejects(
    readArtifact(await make([entry('package/package.json', manifest)], Buffer.alloc(512))),
    /Truncated/,
  );
  await assert.rejects(
    readArtifact(
      await make([entry('package/package.json', manifest).subarray(0, 520)], Buffer.alloc(0)),
    ),
    /Truncated/,
  );
  await assert.rejects(
    readArtifact(
      await make([
        entry('package/package.json', manifest),
        Buffer.alloc(1024),
        entry('package/hidden'),
      ]),
    ),
    /end marker/,
  );
});
