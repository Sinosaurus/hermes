// 文件职责：端点与日志安全：规范 registry URL、移除来源凭证并脱敏错误。
// registry、来源 URL 和日志脱敏属于本项目的安全策略，不改写包内容。
import { AsyncLocalStorage } from 'node:async_hooks';

// 授权仅在当前异步操作内有效，不写入环境变量或持久化 run。
const httpRegistries = new AsyncLocalStorage<readonly string[]>();
export function withHttpRegistries<T>(values: string[], action: () => T): T {
  const registries = values.map((value) => {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash)
      throw new Error(
        '--allow-http-registry requires an HTTP URL without credentials/query/fragment',
      );
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    return url.href;
  });
  return httpRegistries.run(registries, action);
}
export function anonymousHttpMode() {
  return Boolean(httpRegistries.getStore()?.length);
}
export function allowedHttpUrl(url: URL, exact = false) {
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash)
    return false;
  return Boolean(
    httpRegistries.getStore()?.some((base) => {
      const endpoint = new URL(base);
      const pathname = exact ? `${url.pathname.replace(/\/+$/, '')}/` : url.pathname;
      return (
        url.origin === endpoint.origin &&
        (exact ? pathname === endpoint.pathname : pathname.startsWith(endpoint.pathname))
      );
    }),
  );
}

export function normalizeRegistry(value: string) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && (local || allowedHttpUrl(url, true)))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Registry must be HTTPS (localhost HTTP or explicit --allow-http-registry is allowed), without embedded credentials/query/fragment',
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.href;
}

export function publicUrl(value: string) {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

export function redact(value: unknown) {
  let text = String(value).replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@');
  for (const key of ['NPM_TOKEN', 'NODE_AUTH_TOKEN']) {
    if (process.env[key]) text = text.split(process.env[key]).join('[redacted]');
  }
  return text.replace(
    /(\b(?:_authToken|token|password|authorization)\s*[=:]\s*)[^\s,]+/gi,
    '$1[redacted]',
  );
}
