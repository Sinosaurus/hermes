// 文件职责：端点与日志安全：规范 registry URL、移除来源凭证并脱敏错误。
// registry、来源 URL 和日志脱敏属于本项目的安全策略，不改写包内容。
export function normalizeRegistry(value: string) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Registry must be HTTPS (localhost HTTP is allowed), without embedded credentials/query/fragment',
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
