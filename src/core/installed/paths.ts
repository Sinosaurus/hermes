// 文件职责：限定 node_modules 实体路径，向上查找最近安装树并拒绝断链。
import * as fs from 'node:fs/promises';
import path from 'node:path';

export const inside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};
export const failure = (code: string, message: string) =>
  Object.assign(new Error(message), { code });
export const inModules = (filename: string) => filename.split(path.sep).includes('node_modules');

/** 仅向上查找最近安装树，不递归搜索磁盘或猜测兄弟项目。 */
export async function findModulesDirectory(value?: string, cwd = process.cwd()) {
  let directory = path.resolve(value ?? cwd);
  if (value && path.basename(directory) !== 'node_modules')
    throw failure('invalid-modules-directory', 'Input must be a node_modules directory');
  while (true) {
    const candidate =
      value || path.basename(directory) === 'node_modules'
        ? directory
        : path.join(directory, 'node_modules');
    let present = false;
    try {
      await fs.lstat(candidate);
      present = true;
    } catch (error) {
      if (error.code !== 'ENOENT' || value) throw error;
    }
    // 已存在但断链的安装树必须报错，不能悄悄换成上层项目。
    if (present) {
      const actual = await fs.realpath(candidate);
      if (path.basename(actual) !== 'node_modules' || !(await fs.stat(actual)).isDirectory()) {
        throw failure(
          'invalid-modules-directory',
          'Resolved input must be a node_modules directory',
        );
      }
      return actual;
    }
    const parent = path.dirname(directory);
    if (parent === directory)
      throw failure(
        'missing-node-modules',
        'No node_modules found; run from the project or pass --node-modules',
      );
    directory = parent;
  }
}
