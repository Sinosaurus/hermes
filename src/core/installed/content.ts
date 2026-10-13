// 文件职责：读取包身份；盘点与 staging 共用内容遍历、链接检查和摘要规则。
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { PackageJson } from '../types.js';
import { readJson, validateIdentity } from '../../lib/index.js';
import { inside, failure } from './paths.js';

export async function readIdentity(directory: string) {
  const filename = path.join(directory, 'package.json');
  const realFilename = await fs.realpath(filename);
  if (!inside(directory, realFilename))
    throw failure('external-content-link', `${filename} points outside the package`);
  const value = await readJson<PackageJson>(realFilename);
  try {
    validateIdentity(value);
  } catch (error) {
    throw failure('invalid-package-identity', `${filename}: ${error.message}`);
  }
  return value;
}

async function copyAndHashFile(actual: string, target: string | undefined, mode: number) {
  const fileHash = createHash('sha256');
  if (target) {
    const digest = new Transform({
      transform(chunk, encoding, callback) {
        fileHash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      createReadStream(actual),
      digest,
      createWriteStream(target, { flags: 'wx', mode: mode & 0o777 }),
    );
    await fs.chmod(target, mode & 0o777);
  } else {
    for await (const chunk of createReadStream(actual)) fileHash.update(chunk);
  }
  return fileHash.digest('hex');
}

// 盘点摘要和 staging 复制共用遍历规则，保证允许的链接内容在打包前被实体化。
export async function packageContent(root: string, destination?: string) {
  const hash = createHash('sha256');
  const add = (value: unknown) => hash.update(JSON.stringify(value) + '\n');

  async function visit(source: string, relative: string, ancestors: Set<string>): Promise<void> {
    const link = await fs.lstat(source);
    let actual = source;
    if (link.isSymbolicLink()) {
      try {
        actual = await fs.realpath(source);
      } catch (error) {
        throw failure('broken-content-link', `${source}: ${error.message}`);
      }
      if (!inside(root, actual))
        throw failure('external-content-link', `${source} points outside the package`);
      if (path.relative(root, actual).split(path.sep).includes('node_modules')) {
        throw failure('dependency-content-link', `${source} points into excluded node_modules`);
      }
    }
    const stat = link.isSymbolicLink() ? await fs.stat(actual) : link;
    const target = destination && path.join(destination, relative);
    if (stat.isDirectory()) {
      if (ancestors.has(actual))
        throw failure('content-link-cycle', `Directory link cycle at ${source}`);
      if (relative) add([relative, 'directory']);
      if (target && relative) await fs.mkdir(target);
      const next = new Set([...ancestors, actual]);
      for (const entry of (await fs.readdir(actual)).sort()) {
        if (entry !== 'node_modules')
          await visit(path.join(actual, entry), path.join(relative, entry), next);
      }
    } else if (stat.isFile()) {
      const digest = await copyAndHashFile(actual, target, stat.mode);
      add([relative, 'file', stat.mode & 0o111, digest]);
    } else {
      throw failure('unsupported-content-file', `Unsupported file type at ${source}`);
    }
  }

  await visit(root, '', new Set());
  return hash.digest('hex');
}
