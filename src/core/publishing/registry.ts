// 文件职责：查询目标版本和 tag，并通过实际 tarball 字节验证远端制品。
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Tags, BundlePackage } from '../types.js';
import { failure, missing, type Api } from './context.js';
import * as common from '../../lib/index.js';

async function query<T>(
  api: Api,
  args: string[],
  registry: string,
  name: string,
): Promise<T | null> {
  try {
    return await api.npmJson<T>(args, { registry, packageName: name });
  } catch (error) {
    if (missing(error)) return null;
    throw failure(`Registry query failed for ${name}`, error);
  }
}

export async function tagsFor(api: Api, name: string, registry: string): Promise<Tags> {
  let output: string;
  try {
    // npm 11.19 的 ls 即使传 --json 也输出逐行文本；包级读取不依赖 latest 或某个版本。
    output = await api.npmCommand(
      ['dist-tag', 'ls', name, '--json', '--loglevel=error', '--color=false'],
      { registry, packageName: name },
    );
  } catch (error) {
    const noTags =
      !error.npmCode &&
      !error.code &&
      error.message
        ?.split(/\r?\n/)
        .some(
          (line: string) =>
            line.replace(/^(?:\S+ failed: )?(?:npm error )?/, '') ===
            `No dist-tags found for ${name}`,
        );
    if (missing(error) || noTags) return {};
    throw failure(`Registry query failed for ${name}`, error);
  }
  const tags: Tags = {};
  try {
    for (const line of output.replace(/\r?\n$/, '').split(/\r?\n/)) {
      const match = /^([^\s:]+): ([^\s]+)$/.exec(line);
      if (!match || Object.hasOwn(tags, match[1])) throw failure('Invalid tag line');
      const [, tag, version] = match;
      common.validateDistTag(tag);
      common.validateIdentity({ name, version });
      Object.defineProperty(tags, tag, { value: version, enumerable: true });
    }
  } catch {
    throw failure(`Invalid dist-tag snapshot for ${name}`);
  }
  return tags;
}

export async function remoteArtifact(api: Api, pkg: BundlePackage, registry: string) {
  const dist = await query<{ tarball?: string }>(
    api,
    ['view', common.packageSpec(pkg), 'dist', '--json'],
    registry,
    pkg.name,
  );
  if (dist === null) return false;
  if (!dist || typeof dist !== 'object' || typeof dist.tarball !== 'string')
    throw failure(`Invalid remote metadata for ${common.packageSpec(pkg)}`);
  let tarball;
  try {
    tarball = new URL(dist.tarball);
  } catch {
    throw failure(`Invalid remote tarball URL for ${common.packageSpec(pkg)}`);
  }
  if (
    tarball.origin !== new URL(registry).origin ||
    tarball.username ||
    tarball.password ||
    tarball.hash
  )
    throw failure(
      `Remote tarball must use the target registry origin for ${common.packageSpec(pkg)}`,
    );
  const scratch = await mkdirScratch();
  try {
    api.progress({ name: pkg.name, version: pkg.version });
    const artifact = await api.packArtifact(tarball.href, scratch, {
      registry,
      packageName: pkg.name,
    });
    if (
      artifact.sha256 !== pkg.sha256 ||
      artifact.packageJson.name !== pkg.name ||
      artifact.packageJson.version !== pkg.version
    )
      throw failure(`Artifact conflict for ${common.packageSpec(pkg)}`);
    api.stats.downloaded++;
    api.stats.downloadBytes += artifact.size ?? (await stat(artifact.file)).size;
    api.progress();
    return true;
  } catch (error) {
    if (error.message?.startsWith('Artifact conflict')) throw error;
    throw failure(`Cannot verify remote artifact for ${common.packageSpec(pkg)}`, error);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function mkdirScratch() {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(os.tmpdir(), 'offline-npm-remote-'));
}
