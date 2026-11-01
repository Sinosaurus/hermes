// 文件职责：按显式 URL 和预期 SHA-256 下载外部资源，不执行安装脚本或自动探测地址。
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ResourceDownload } from '../types.js';

const DEFAULT_MAX_BYTES = 1024 ** 3;
const DEFAULT_TIMEOUT_MS = 300_000;

function sourceUrl(value: unknown, signedRedirect = false) {
  if (typeof value !== 'string') throw new Error('Resource download requires a URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid resource download URL');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (!signedRedirect && url.search) ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
  )
    throw new Error(
      'Resource URL requires HTTPS without credentials, query or fragment (localhost HTTP allowed)',
    );
  return url;
}

function positiveLimit(value: unknown, fallback: number, maximum: number, label: string) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum)
    throw new Error(`Invalid resource download ${label}`);
  return value as number;
}

export function validateDownload(config: ResourceDownload) {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Invalid resource download declaration');
  const url = sourceUrl(config.url);
  if (typeof config.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(config.sha256))
    throw new Error('Resource download requires an expected SHA-256');
  // 禁止目录穿越、Windows 保留名和路径字符，让同一份资源可在 Windows/Linux 搬运。
  if (
    typeof config.filename !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(config.filename) ||
    config.filename.endsWith('.') ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(config.filename)
  )
    throw new Error('Resource filename must be a portable plain filename');
  if (
    config.allowHosts !== undefined &&
    (!Array.isArray(config.allowHosts) ||
      config.allowHosts.some((host) => {
        if (typeof host !== 'string' || !host) return true;
        try {
          const parsed = new URL(`https://${host}`);
          return (
            parsed.host !== host ||
            parsed.pathname !== '/' ||
            !!(parsed.username || parsed.password || parsed.search || parsed.hash)
          );
        } catch {
          return true;
        }
      }))
  )
    throw new Error('Invalid resource redirect allowHosts');
  const maxBytes = positiveLimit(config.maxBytes, DEFAULT_MAX_BYTES, 16 * 1024 ** 3, 'maxBytes');
  const timeoutMs = positiveLimit(config.timeoutMs, DEFAULT_TIMEOUT_MS, 3_600_000, 'timeoutMs');
  return { url, maxBytes, timeoutMs, allowed: new Set([url.host, ...(config.allowHosts || [])]) };
}

export async function downloadResource(config: ResourceDownload, destination: string) {
  const { url: initialUrl, allowed, maxBytes, timeoutMs } = validateDownload(config);
  await mkdir(destination, { recursive: true });
  const temporary = path.join(destination, `.${randomUUID()}.part`);
  const file = path.join(destination, config.filename);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const hash = createHash('sha256');
  let size = 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let response: Response | undefined;
  try {
    let url = initialUrl;
    for (let redirects = 0; ; redirects++) {
      response = await fetch(url, { redirect: 'manual', signal: controller.signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      if (redirects >= 5) throw new Error('Too many resource redirects');
      const location = response.headers.get('location');
      if (!location) throw new Error('Resource redirect is missing location');
      // GitHub 等允许在明确许可的重定向主机携带短期签名查询；不记录最终 URL。
      url = sourceUrl(new URL(location, url).href, true);
      if (!allowed.has(url.host))
        throw new Error('Resource redirect host is not explicitly allowed');
      if (initialUrl.protocol === 'https:' && url.protocol !== 'https:')
        throw new Error('Resource redirect cannot downgrade HTTPS');
    }
    if (!response.ok || !response.body)
      throw new Error(`Resource download HTTP ${response.status}`);
    const length = response.headers.get('content-length');
    if (length && /^\d+$/.test(length) && Number(length) > maxBytes)
      throw new Error('Resource download exceeds maxBytes');
    handle = await open(temporary, 'wx', 0o600);
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error('Resource download exceeds maxBytes');
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
    const sha256 = hash.digest('hex');
    if (sha256 !== config.sha256.toLowerCase()) throw new Error('Resource SHA-256 mismatch');
    await handle.sync();
    await handle.close();
    handle = undefined;
    // 硬链接实现独占落盘：绝不覆盖既有目标，即便发生并发冲突。
    await link(temporary, file);
    await unlink(temporary);
    return { url: initialUrl.href, sha256, filename: config.filename, size };
  } catch (error) {
    controller.abort();
    // 受控错误保留；网络错误不附带可能含远端输入的 cause 或 URL。
    if (
      error instanceof Error &&
      /^(Resource |Invalid resource |Too many resource )/.test(error.message)
    )
      throw error;
    if (error?.code === 'EEXIST') throw new Error('Resource destination already exists');
    throw new Error('Resource download failed or timed out');
  } finally {
    clearTimeout(timeout);
    await handle?.close().catch(() => {});
    await response?.body?.cancel().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}
