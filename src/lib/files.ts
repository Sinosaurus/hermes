// 文件职责：文件基础能力：原子 JSON 写入、摘要/SRI 和路径边界校验。
import type { BinaryToTextEncoding } from 'node:crypto';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  link,
  stat,
  readdir,
  lstat,
} from 'node:fs/promises';
import path from 'node:path';
import { OUTPUT_LIMIT } from '../config.js';
import ssri from 'ssri';

export async function readJson<T = unknown>(file: string): Promise<T> {
  if ((await stat(file)).size > OUTPUT_LIMIT) throw new Error('JSON exceeds 16 MiB');
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeJson(file: string, data: unknown, { exclusive = false } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (exclusive) {
      await link(temporary, file);
      await unlink(temporary);
    } else await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function fileHash(
  file: string,
  algorithm = 'sha256',
  encoding: BinaryToTextEncoding = 'hex',
) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

/** 使用 ssri 的流式校验及最强算法选择，SHA-1 仅兼容上游旧 shasum。 */
export async function assertIntegrity(file: string, integrity: unknown) {
  if (typeof integrity !== 'string' || !integrity.trim())
    throw new Error('Missing artifact integrity');
  const supported = new Set(['sha512', 'sha384', 'sha256', 'sha1']);
  // ssri 会忽略不认识的项；交付校验要求每项都合法，避免静默降级。
  for (const token of integrity.trim().split(/\s+/)) {
    const parsed = ssri.parse(token);
    if (!parsed || Object.keys(parsed).some((algorithm) => !supported.has(algorithm)))
      throw new Error('Unsupported or invalid SRI');
  }
  try {
    await ssri.checkStream(createReadStream(file), integrity);
  } catch (error) {
    if (error.code === 'EINTEGRITY')
      throw new Error('Artifact integrity mismatch', { cause: error });
    throw error;
  }
}

export async function safePath(root: string, relative: string) {
  if (
    typeof relative !== 'string' ||
    !relative ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    path.isAbsolute(relative) ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Unsafe bundle path');
  }
  const base = await realpath(root);
  const file = path.resolve(base, relative);
  const actual = await realpath(file);
  if (!actual.startsWith(`${base}${path.sep}`)) throw new Error('Bundle path escapes root');
  if ((await lstat(file)).isSymbolicLink() || !(await stat(file)).isFile())
    throw new Error('Bundle entries must be regular files');
  return actual;
}

export async function canonicalPath(value: string) {
  let ancestor = path.resolve(value);
  const tail: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(ancestor), ...tail);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      tail.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}

export async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Unregistered symlink in bundle: ${relative}`);
    if (entry.isDirectory()) files.push(...(await listFiles(root, relative)));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported bundle entry: ${relative}`);
  }
  return files.sort();
}
