// 文件职责：受控子进程调用：禁用 shell、限制输出/超时并绑定 npm registry。
import { mkdtemp, writeFile, lstat, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PACK_NPM_VERSION, OUTPUT_LIMIT } from '../config.js';
import { normalizeRegistry, redact, anonymousHttpMode } from './security.js';

export interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}
export interface NpmOptions extends CommandOptions {
  registry?: string;
  packageName?: string;
  cache?: string;
}

export async function command(
  executable: string,
  args: string[],
  { cwd, timeoutMs = 300_000, env = process.env }: CommandOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      length = 0,
      failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error('Command timed out');
      child.kill();
    }, timeoutMs);
    const capture = (key: 'stdout' | 'stderr') => (data: Buffer) => {
      length += data.length;
      if (length > OUTPUT_LIMIT) {
        failure = new Error('Command output exceeds 16 MiB');
        child.kill();
        return;
      }
      if (key === 'stdout') stdout += data.toString();
      else stderr += data.toString();
    };
    child.stdout.on('data', capture('stdout'));
    child.stderr.on('data', capture('stderr'));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code === 0) return resolve(stdout);
      let npmCode;
      try {
        npmCode = JSON.parse(stdout).error?.code;
      } catch {}
      npmCode ||= stderr.match(/\bcode\s+(E[A-Z0-9_]+)/)?.[1];
      const error: Error & { npmCode?: string; exitCode?: number | null } = new Error(
        redact(
          `${path.basename(executable)} failed${npmCode ? ` (${npmCode})` : ''}: ${stderr || stdout}`,
        ).slice(0, 3000),
      );
      error.npmCode = npmCode;
      error.exitCode = code;
      reject(error);
    });
  });
}

async function configuredNpmCommand(args: string[], options: NpmOptions = {}) {
  const { registry, packageName, cache, ...execution } = options;
  const flags = [
    ...args,
    '--update-notifier=false',
    '--prefer-online=true',
    '--prefer-offline=false',
    '--offline=false',
    `--cache=${cache || process.env.OFFLINE_NPM_CACHE || path.join(tmpdir(), 'offline-npm-cache')}`,
  ];
  if (registry) {
    const normalized = normalizeRegistry(registry);
    flags.push(`--registry=${normalized}`);
    if (packageName?.startsWith('@'))
      flags.push(`--${packageName.split('/')[0]}:registry=${normalized}`);
  }
  // Windows 的 .cmd 入口依赖 shell；通过 npm run 注入 JS 入口，保持 shell 禁用。
  if (process.env.npm_execpath && /\.(?:c?js|mjs)$/.test(process.env.npm_execpath)) {
    return command(process.execPath, [process.env.npm_execpath, ...flags], execution);
  }
  if (process.platform === 'win32')
    throw new Error('On Windows run through npm run cli -- ... (npm_execpath is required)');
  return command('npm', flags, execution);
}

/** HTTP 授权操作统一隔离 npm 的凭据和路由配置；不会读取用户 npmrc。 */
export async function npmCommand(args: string[], options: NpmOptions = {}) {
  if (!anonymousHttpMode()) return configuredNpmCommand(args, options);
  if (args[0] === 'publish') {
    // publishConfig 会被 npm 叠加到配置；匿名 HTTP 不接受包内额外配置来源。
    const file = args[1];
    if (!file || !path.isAbsolute(file))
      throw new Error('Anonymous HTTP publish requires an absolute verified tarball path');
    const { readArtifact } = await import('./artifacts.js');
    const { packageJson: manifest } = await readArtifact(file);
    if (manifest.publishConfig !== undefined)
      throw new Error(
        'Anonymous HTTP publish refuses package publishConfig; use HTTPS without modifying the original artifact',
      );
  }
  // project npmrc 无法通过 userconfig 禁用。拒绝祖先配置，避免 npm 自动发现后带出认证。
  let directory = path.resolve(options.cwd ?? process.cwd());
  while (true) {
    try {
      await lstat(path.join(directory, '.npmrc'));
      throw new Error(
        'Anonymous HTTP mode refuses project .npmrc; use a clean working directory and HTTPS for authenticated registries',
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  // 不继承 npm_config_*、token、代理认证或任意第三方 secret 环境变量。
  const source = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
  ])
    if (source[key] !== undefined) env[key] = source[key];
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    if (!source[key]) continue;
    const proxy = new URL(source[key]);
    if (
      !['http:', 'https:'].includes(proxy.protocol) ||
      proxy.username ||
      proxy.password ||
      proxy.search ||
      proxy.hash
    )
      throw new Error('Anonymous HTTP mode refuses authenticated or invalid proxy configuration');
    env[key] = proxy.href;
  }
  for (const key of ['NO_PROXY', 'no_proxy']) {
    if (source[key] && /^[A-Za-z0-9.*,:[\]\s_-]+$/.test(source[key])) env[key] = source[key];
  }
  env.NO_PROXY = [env.NO_PROXY ?? env.no_proxy, 'localhost', '127.0.0.1', '[::1]']
    .filter(Boolean)
    .join(',');
  env.no_proxy = env.NO_PROXY;
  const temp = await mkdtemp(path.join(tmpdir(), 'hermes-anonymous-npm-'));
  try {
    const userconfig = path.join(temp, 'user.npmrc');
    const globalconfig = path.join(temp, 'global.npmrc');
    await Promise.all([writeFile(userconfig, ''), writeFile(globalconfig, '')]);
    env.HOME = temp;
    env.USERPROFILE = temp;
    return await configuredNpmCommand(
      [
        ...args,
        `--userconfig=${userconfig}`,
        `--globalconfig=${globalconfig}`,
        '--ignore-scripts=true',
      ],
      { ...options, env },
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function npmJson<T = unknown>(args: string[], options: NpmOptions = {}): Promise<T> {
  const output = await npmCommand([...args, '--json'], options);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`npm returned invalid/empty JSON for ${args[0]}`);
  }
}

export async function assertPackToolchain(options: NpmOptions = {}) {
  const version = (await npmCommand(['--version'], options)).trim();
  if (version !== PACK_NPM_VERSION)
    throw new Error(
      `Packing requires verified npm ${PACK_NPM_VERSION}; found ${version}. Do not use an older pack --ignore-scripts for prepare.`,
    );
  return version;
}
