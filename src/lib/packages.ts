// 文件职责：npm 身份校验：包名、精确版本、registry 规格和 dist-tag。
import type { PackageIdentity } from '../core/types.js';
import npa from 'npm-package-arg';
import semver from 'semver';
import validatePackageName from 'validate-npm-package-name';

export const packageSpec = (pkg: PackageIdentity) => `${pkg.name}@${pkg.version}`;

/** 制品身份必须是可发布的包名和精确版本；不能把范围或 tag 当成版本。 */
export function validateIdentity(pkg: unknown): asserts pkg is PackageIdentity {
  if (
    !pkg ||
    typeof pkg !== 'object' ||
    !('name' in pkg) ||
    !('version' in pkg) ||
    typeof pkg.name !== 'string' ||
    !validatePackageName(pkg.name).validForNewPackages
  ) {
    throw new Error('Invalid npm package name');
  }
  const version = typeof pkg.version === 'string' && semver.parse(pkg.version);
  // 保留合法 build metadata，但拒绝 npm 可宽容归一化的 v 前缀与空白。
  const canonical =
    version && `${version.version}${version.build.length ? `+${version.build.join('.')}` : ''}`;
  if (!version || canonical !== pkg.version)
    throw new Error(`Invalid exact version for ${pkg.name}`);
}

/** 解析规则由 npm 库负责；首版业务只接收 registry 输入，不触发 Git/file 构建。 */
export function registrySpec(value: string) {
  let parsed;
  try {
    parsed = typeof value === 'string' && npa(value);
  } catch {}
  if (
    !parsed ||
    value.startsWith('-') ||
    !parsed.registry ||
    !['version', 'range', 'tag'].includes(parsed.type) ||
    !validatePackageName(parsed.name ?? '').validForNewPackages
  ) {
    throw new Error(
      'Package input must be a registry name, tag or version range; Git/file/URL/alias inputs are not supported',
    );
  }
  return parsed.name!;
}

/** npm 的 tag 不能同时被解释为 SemVer 范围，例如 x、v1、1.2。 */
export function validateDistTag(tag: unknown) {
  try {
    if (
      typeof tag === 'string' &&
      tag.trim() === tag &&
      npa.resolve('offline-tag-validation', tag).type === 'tag' &&
      semver.validRange(tag) === null
    )
      return;
  } catch {}
  throw new Error(`Invalid or ambiguous dist-tag: ${tag}`);
}
