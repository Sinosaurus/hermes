// 文件职责：保护 run 锁和原始身份，管理创建、续跑、摘要绑定及状态持久化。
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunIdentity, RunState } from '../types.js';
import { failure, type Api, type NormalizedOptions } from './context.js';
import { validate, inspectBundle } from './plan.js';
import * as common from '../../lib/index.js';

export async function withRun<T>(
  runDir: string | undefined,
  callback: (dir: string, empty: boolean) => Promise<T>,
): Promise<T> {
  if (!runDir) throw failure('A run directory is required');
  const dir = path.resolve(runDir);
  await mkdir(dir, { recursive: true });
  let lock;
  // shortcut: 锁只保护本机单个 run；跨 run 或机器写入需私服维护窗口或统一单写者。
  try {
    lock = await open(path.join(dir, '.lock'), 'wx', 0o600);
  } catch {
    throw failure('Run is locked; inspect the active process before removing a stale .lock');
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    // 预检失败可能留下空目录；持锁后确认只有本次锁文件才允许重新初始化。
    const empty = (await readdir(dir)).every((name) => name === '.lock');
    return await callback(dir, empty);
  } finally {
    await lock.close();
    await rm(path.join(dir, '.lock'), { force: true });
  }
}

export async function loadRun(dir: string) {
  let identity, state;
  try {
    identity = await common.readJson<RunIdentity>(path.join(dir, 'identity.json'));
    state = await common.readJson<RunState>(path.join(dir, 'state.json'));
  } catch {
    throw failure(
      'Run has no complete original identity/state; preserve it and use a new run directory',
    );
  }
  if (
    identity.schemaVersion !== 1 ||
    state.schemaVersion !== 1 ||
    identity.runId !== state.runId ||
    (await common.fileHash(path.join(dir, 'identity.json'))) !== state.identityDigest
  )
    throw failure('Run identity or original tag snapshot changed');
  validate(identity.manifest, identity.recovery);
  return { identity, state };
}

export const persist = (dir: string, state: RunState) =>
  common.writeJson(path.join(dir, 'state.json'), state);
export const result = (identity: RunIdentity, state: RunState, api: Api) => ({
  ...state,
  registry: identity.registry,
  readRegistry: identity.readRegistry,
  recovery: identity.recovery,
  manifestDigest: identity.manifestDigest,
  temporaryTag: identity.temporaryTag,
  stats: { ...api.stats },
});

export async function verifyRunBundle(identity: RunIdentity) {
  const verified = await common.verifyBundle(identity.bundle);
  if (verified.manifestDigest !== identity.manifestDigest)
    throw failure('Bundle changed since this run started');
}

export async function createImportRun(
  dir: string,
  absoluteBundle: string,
  options: NormalizedOptions,
  api: Api,
) {
  const { registry, readRegistry } = options;
  const plan = await inspectBundle(absoluteBundle, options, api);
  // npm 的 JSON 输出也会脱敏 UUID 形态的文本，临时 tag 后缀需去掉 UUID 分隔符。
  const identity: RunIdentity = {
    schemaVersion: 1,
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    bundle: absoluteBundle,
    registry,
    readRegistry,
    recovery: options.recovery === true,
    manifestDigest: plan.manifestDigest,
    manifest: plan.manifest,
    tagSnapshot: plan.tagSnapshot,
    temporaryTag: `offline-import-${randomUUID().replaceAll('-', '')}`,
    writerConstraint: 'Registry changes require one writer across all runs and machines.',
  };
  await common.writeJson(path.join(dir, 'identity.json'), identity, { exclusive: true });
  // 身份与原始 tag 快照只写一次，变更状态绑定其摘要，避免续跑覆盖回滚依据。
  const state: RunState = {
    schemaVersion: 1,
    runId: identity.runId,
    identityDigest: await common.fileHash(path.join(dir, 'identity.json')),
    phase: 'importing',
    versions: {},
    temporaryTags: {},
    tagIntents: [],
    attempts: 0,
  };
  await common.writeJson(path.join(dir, 'state.json'), state, { exclusive: true });
  return { identity, state };
}

export async function resumeImportRun(
  dir: string,
  absoluteBundle: string,
  options: NormalizedOptions,
) {
  const { registry, readRegistry } = options;
  const { identity, state } = await loadRun(dir);
  if (
    identity.bundle !== absoluteBundle ||
    identity.registry !== registry ||
    identity.readRegistry !== readRegistry ||
    identity.recovery !== (options.recovery === true)
  )
    throw failure('Resume must use the same bundle, write/read registry and recovery mode');
  await verifyRunBundle(identity);
  if (['rolling-back', 'rollback-pending', 'rolled-back'].includes(state.phase))
    throw failure('Rollback run is closed to import; finish rollback or use a new run directory');
  if (state.phase === 'promoting')
    throw failure('Promotion was interrupted; resume promote or rollback');
  return { identity, state };
}
