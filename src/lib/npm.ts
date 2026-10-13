// 文件职责：受控子进程调用：禁用 shell、限制输出/超时并绑定 npm registry。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PACK_NPM_VERSION, OUTPUT_LIMIT } from '../config.js';
import { normalizeRegistry, redact } from './security.js';

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

export async function npmCommand(args: string[], options: NpmOptions = {}) {
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
