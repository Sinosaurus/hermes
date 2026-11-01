// 文件职责：只在本地导出已校验的资源和静态服务映射，不上传或改动现有服务器。
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { verifyBundle, safePath, writeJson, canonicalPath, fileHash } from '../lib/index.js';

export async function exportResources(bundle: string, out: string, baseUrl: string) {
  const base = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('Static base URL must use HTTP(S) without credentials, query or fragment');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const verified = await verifyBundle(bundle);
  const source = await canonicalPath(bundle);
  const destination = await canonicalPath(out);
  if (destination === source || destination.startsWith(`${source}${path.sep}`))
    throw new Error('Resource export must be outside the frozen bundle');
  const files = new Set<string>();
  const resources = verified.manifest.resources.map((resource) => {
    const prefix = `resources/${resource.id}/`;
    for (const file of resource.files) {
      if (!file.startsWith(prefix))
        throw new Error('Resource file must belong to its resource directory');
      files.add(file);
    }
    return {
      ...resource,
      environment: Object.fromEntries(
        Object.entries(resource.environment ?? {}).map(([key, value]) => [
          key,
          value.replaceAll('{{baseUrl}}', base.href.replace(/\/$/, '')),
        ]),
      ),
      urls: resource.files.map((file) => ({
        file,
        url: new URL(file.split('/').map(encodeURIComponent).join('/'), base).href,
        sha256: verified.manifest.files[file],
      })),
    };
  });
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(destination); // 已存在输出拒绝，避免覆盖线上文件或不同批次。
  try {
    for (const file of files) {
      const target = path.join(destination, file);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(await safePath(bundle, file), target, constants.COPYFILE_EXCL);
      if ((await fileHash(target)) !== verified.manifest.files[file])
        throw new Error('Resource changed during export');
    }
    await writeJson(
      path.join(destination, 'resource-map.json'),
      {
        schemaVersion: 1,
        batchId: verified.manifest.batchId,
        manifestDigest: verified.manifestDigest,
        baseUrl: base.href,
        resources,
        notice:
          '仅生成本地暂存目录，未上传。将 resources/ 保持路径部署至 baseUrl；environment 仅为提示，不自动执行。',
      },
      { exclusive: true },
    );
    return {
      exportDirectory: destination,
      files: files.size,
      resources: resources.length,
      baseUrl: base.href,
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
