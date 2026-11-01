// 文件职责：验证资源声明与审查证据，收集本地文件或显式声明的远端资源。
import { cp, mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { ResourceConfig } from '../types.js';
import type { Bundle } from './bundle.js';
import { readJson, listFiles } from '../../lib/index.js';
import { downloadResource } from './resource-download.js';

export async function addResources(bundle: Bundle, configFile?: string) {
  if (!configFile) return;
  const config = await readJson<ResourceConfig>(configFile);
  if (!Array.isArray(config.resources))
    throw new Error('resources config requires a resources array');
  const ids = new Set();
  for (const resource of config.resources) {
    if (
      !resource ||
      typeof resource.id !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(resource.id) ||
      ids.has(resource.id.toLowerCase()) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(resource.id) ||
      (resource.source !== undefined) === (resource.download !== undefined) ||
      (resource.source !== undefined &&
        (typeof resource.source !== 'string' || !resource.source.trim())) ||
      (resource.version !== undefined &&
        (typeof resource.version !== 'string' || !resource.version.trim())) ||
      typeof resource.instructions !== 'string' ||
      !resource.instructions.trim() ||
      !Array.isArray(resource.targets) ||
      !resource.targets.length ||
      resource.targets.some(
        (target) =>
          !target ||
          typeof target.os !== 'string' ||
          !target.os.trim() ||
          typeof target.cpu !== 'string' ||
          !target.cpu.trim() ||
          (['node', 'nodeAbi', 'libc'] as const).some(
            (key) =>
              target[key] !== undefined && (typeof target[key] !== 'string' || !target[key].trim()),
          ),
      )
    )
      throw new Error('Invalid resource id/source/instructions/targets');
    if (
      resource.environment !== undefined &&
      (!resource.environment ||
        typeof resource.environment !== 'object' ||
        Array.isArray(resource.environment) ||
        Object.entries(resource.environment).some(
          ([key, value]) =>
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
            typeof value !== 'string' ||
            !value.trim() ||
            /[\r\n\0]/.test(value),
        ))
    )
      throw new Error('Invalid resource environment hints');
    ids.add(resource.id.toLowerCase());
    const destination = path.join(bundle.out, 'resources', resource.id);
    const download =
      resource.download !== undefined
        ? await downloadResource(resource.download, destination)
        : undefined;
    if (!download)
      await copyResource(path.resolve(path.dirname(configFile), resource.source!), destination);
    const files = (await listFiles(destination)).map((file) => `resources/${resource.id}/${file}`);
    if (!files.length) throw new Error(`Empty resource: ${resource.id}`);
    bundle.manifest.resources.push({
      id: resource.id,
      targets: resource.targets,
      instructions: resource.instructions,
      files,
      ...(resource.version === undefined ? {} : { version: resource.version }),
      ...(download ? { download } : {}),
      ...(resource.environment === undefined ? {} : { environment: resource.environment }),
    });
  }
  if (
    config.review?.status === 'reviewed' &&
    Array.isArray(config.review.evidence) &&
    config.review.evidence.length &&
    config.review.evidence.every((item) => typeof item === 'string' && item.trim())
  ) {
    bundle.manifest.resourceReview = { status: 'reviewed', evidence: config.review.evidence };
  }
}

async function copyResource(source: string, destination: string) {
  const info = await lstat(source);
  // 先检查资源目录并拒绝链接，再复制到交付目录，避免带入未经审查的缓存布局。
  if (info.isDirectory()) {
    await listFiles(source);
    await cp(source, destination, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
  } else if (info.isFile()) {
    await mkdir(destination, { recursive: true });
    await cp(source, path.join(destination, path.basename(source)), {
      errorOnExist: true,
      force: false,
    });
  } else throw new Error('Resource must be a file or directory');
}
