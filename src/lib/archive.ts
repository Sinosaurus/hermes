// 文件职责：流式验证原始 tar 字节；不解压、不执行脚本、不重打包。
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';

function octal(field: Buffer) {
  const text = field.toString('ascii').replace(/\0.*$/s, '').trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('Malformed tar numeric field');
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error('Oversized tar numeric field');
  return value;
}
function string(field: Buffer) {
  const end = field.indexOf(0);
  return new TextDecoder('utf-8', { fatal: true }).decode(end < 0 ? field : field.subarray(0, end));
}

/** 支持普通 ustar；扩展/稀疏格式必须另行实现，不允许静默绕过路径检查。 */
export async function inspectArchive(file: string) {
  const source = createReadStream(file);
  const stream = source.pipe(createGunzip());
  source.on('error', (error) => stream.destroy(error));
  let buffer: Buffer = Buffer.alloc(0),
    total = 0,
    zeros = 0,
    root = '';
  let current:
    | {
        raw: string;
        normalized: string;
        metadata: string;
        size: number;
        remaining: number;
        padding: number;
        type: string;
        hash: ReturnType<typeof createHash>;
        json: Buffer[];
      }
    | undefined;
  const seen = new Map<string, { raw: string; metadata: string; digest: string; type: string }>();
  const members: string[] = [];
  const rawNames = new Set<string>();
  let packageJson: string | undefined;
  const timer = setTimeout(() => stream.destroy(new Error('Tar inspection timed out')), 300_000);
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > 2 * 1024 ** 3) throw new Error('Tar expanded size exceeds 2 GiB');
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (current) {
          if (current.remaining) {
            const count = Math.min(current.remaining, buffer.length);
            if (!count) break;
            const bytes = buffer.subarray(0, count);
            current.hash.update(bytes);
            if (current.normalized === `${root}/package.json`)
              current.json.push(Buffer.from(bytes));
            current.remaining -= count;
            buffer = buffer.subarray(count);
            if (current.remaining) break;
          }
          if (buffer.length < current.padding) break;
          if (buffer.subarray(0, current.padding).some((byte) => byte !== 0))
            throw new Error('Malformed tar padding');
          buffer = buffer.subarray(current.padding);
          const digest = current.hash.digest('hex');
          const previous = seen.get(current.normalized);
          if (
            previous &&
            (previous.raw === current.raw ||
              previous.type !== '0' ||
              current.type !== '0' ||
              previous.metadata !== current.metadata ||
              previous.digest !== digest)
          )
            throw new Error('Ambiguous duplicate tarball member');
          if (current.normalized === `${root}/package.json`) {
            if (packageJson !== undefined || current.type !== '0')
              throw new Error('Tarball needs exactly one regular package.json');
            packageJson = new TextDecoder('utf-8', { fatal: true }).decode(
              Buffer.concat(current.json),
            );
          }
          seen.set(current.normalized, {
            raw: current.raw,
            metadata: current.metadata,
            digest,
            type: current.type,
          });
          current = undefined;
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        if (header.every((byte) => byte === 0)) {
          zeros++;
          continue;
        }
        if (zeros) throw new Error('Tar content after end marker');
        const checksum = octal(header.subarray(148, 156));
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
        if (sum !== checksum) throw new Error('Malformed tar header checksum');
        const magic = string(header.subarray(257, 263));
        if (!['ustar', 'ustar '].includes(magic)) throw new Error('Unsupported tar header format');
        const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]!);
        if (!['0', '5'].includes(type))
          throw new Error('Tarball links and special files/extensions are not supported');
        const prefix = magic === 'ustar ' ? '' : string(header.subarray(345, 500));
        for (const [offset, length] of [
          [100, 8],
          [108, 8],
          [116, 8],
          [136, 12],
        ]) {
          const field = header.subarray(offset, offset! + length!);
          if (!field.every((byte) => byte === 0 || byte === 32)) octal(field);
        }
        const raw = `${prefix ? `${prefix}/` : ''}${string(header.subarray(0, 100))}`;
        // oxlint-disable-next-line no-control-regex -- 显式拒绝归档路径中的控制字符。
        if (/^[/]|[\\\x00-\x1f\x7f:]/.test(raw)) throw new Error('Unsafe tarball member');
        if (type === '0' && raw.endsWith('/')) throw new Error('Malformed regular tar path');
        const parts = raw.replace(/\/$/, '').split('/');
        if (!parts[0] || parts[0] === '.' || parts.some((part) => part === '..' || !part))
          throw new Error('Unsafe tarball member');
        const normalized = parts.filter((part) => part !== '.').join('/');
        root ||= parts[0]!;
        if (root !== parts[0] || (normalized === root && type !== '5'))
          throw new Error('Tarball must have a single directory root');
        const size = octal(header.subarray(124, 136));
        if (type === '5' && size) throw new Error('Malformed tar directory');
        if (normalized === `${root}/package.json` && size > 16 * 1024 ** 2)
          throw new Error('Tar package.json exceeds 16 MiB');
        if (members.length >= 100_000) throw new Error('Too many tar members');
        if (rawNames.has(raw)) throw new Error('Ambiguous duplicate tarball member');
        rawNames.add(raw);
        members.push(raw);
        const metadata = Buffer.from(header);
        metadata.fill(0, 0, 100);
        metadata.fill(0, 148, 156);
        // 仅去掉真实路径 prefix，其余头元数据必须逐字节一致。
        if (prefix) metadata.fill(0, 345, 345 + Buffer.byteLength(prefix));
        current = {
          raw,
          normalized,
          metadata: metadata.toString('hex'),
          size,
          remaining: size,
          padding: (512 - (size % 512)) % 512,
          type,
          hash: createHash('sha256'),
          json: [],
        };
      }
    }
    if (current || buffer.length || zeros < 2) throw new Error('Truncated or malformed tarball');
    // 文件不可同时充当另一个条目的父目录。
    for (const name of seen.keys()) {
      const parts = name.split('/');
      while (parts.length > 1) {
        parts.pop();
        if (seen.get(parts.join('/'))?.type === '0')
          throw new Error('Tar file/directory collision');
      }
    }
    if (packageJson === undefined)
      throw new Error('Tarball needs exactly one regular package.json');
    return { packageJson, members };
  } finally {
    clearTimeout(timer);
    stream.destroy();
    source.destroy();
  }
}
