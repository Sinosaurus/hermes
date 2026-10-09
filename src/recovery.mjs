import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readJson, validateIdentity } from './common.mjs';

const segment = /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/;
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};
const failure = (code, message) => Object.assign(new Error(message), { code });

async function readIdentity(directory) {
  const filename = path.join(directory, 'package.json');
  const realFilename = await fs.realpath(filename);
  if (!inside(directory, realFilename)) throw failure('external-content-link', `${filename} points outside the package`);
  const value = await readJson(realFilename);
  try { validateIdentity(value); }
  catch (error) { throw failure('invalid-package-identity', `${filename}: ${error.message}`); }
  return value;
}

// The same traversal hashes inventory and copies staging, so accepted links cannot disappear during packing.
async function packageContent(root, destination) {
  const hash = createHash('sha256');
  const add = value => hash.update(JSON.stringify(value) + '\n');

  async function visit(source, relative, ancestors) {
    const link = await fs.lstat(source);
    let actual = source;
    if (link.isSymbolicLink()) {
      try { actual = await fs.realpath(source); }
      catch (error) { throw failure('broken-content-link', `${source}: ${error.message}`); }
      if (!inside(root, actual)) throw failure('external-content-link', `${source} points outside the package`);
      if (path.relative(root, actual).split(path.sep).includes('node_modules')) {
        throw failure('dependency-content-link', `${source} points into excluded node_modules`);
      }
    }
    const stat = link.isSymbolicLink() ? await fs.stat(actual) : link;
    const target = destination && path.join(destination, relative);
    if (stat.isDirectory()) {
      if (ancestors.has(actual)) throw failure('content-link-cycle', `Directory link cycle at ${source}`);
      if (relative) add([relative, 'directory']);
      if (target && relative) await fs.mkdir(target);
      const next = new Set([...ancestors, actual]);
      for (const entry of (await fs.readdir(actual)).sort()) {
        if (entry !== 'node_modules') await visit(path.join(actual, entry), path.join(relative, entry), next);
      }
    } else if (stat.isFile()) {
      const fileHash = createHash('sha256');
      if (target) {
        const digest = new Transform({
          transform(chunk, encoding, callback) { fileHash.update(chunk); callback(null, chunk); },
        });
        await pipeline(createReadStream(actual), digest, createWriteStream(target, { flags: 'wx', mode: stat.mode & 0o777 }));
        await fs.chmod(target, stat.mode & 0o777);
      } else {
        for await (const chunk of createReadStream(actual)) fileHash.update(chunk);
      }
      add([relative, 'file', stat.mode & 0o111, fileHash.digest('hex')]);
    } else {
      throw failure('unsupported-content-file', `Unsupported file type at ${source}`);
    }
  }

  await visit(root, '', new Set());
  return hash.digest('hex');
}

/** Read installed package instances, without executing package code or changing the source. */
export async function inventoryModules(modulesDir, { allowLinkRoots = [] } = {}) {
  const sourceRoot = await fs.realpath(path.resolve(modulesDir));
  if (!(await fs.stat(sourceRoot)).isDirectory()) throw failure('invalid-modules-directory', 'node_modules must be a directory');
  const allowed = [sourceRoot];
  for (const root of allowLinkRoots) {
    const actual = await fs.realpath(path.resolve(root));
    if (!(await fs.stat(actual)).isDirectory()) throw failure('invalid-link-root', `${root} must be a directory`);
    allowed.push(actual);
  }
  const issues = [];
  const byPath = new Map();
  const seenModules = new Set();
  const stores = new Set();
  const report = (code, filename, message, extra = {}) => issues.push({ code, path: filename, message, ...extra });

  async function entries(directory) {
    try { return (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); }
    catch (error) { report('unreadable-directory', directory, error.message); return []; }
  }

  async function controlledDirectory(filename) {
    try {
      const actual = await fs.realpath(filename);
      if (!allowed.some(root => inside(root, actual))) {
        report('external-link', filename, 'Link target is outside the source tree and allowLinkRoots', { target: actual });
        return;
      }
      if (!(await fs.stat(actual)).isDirectory()) {
        report('invalid-package-directory', filename, 'Expected a package or layout directory');
        return;
      }
      return actual;
    } catch (error) {
      report(error.code === 'ENOENT' || error.code === 'ELOOP' ? 'broken-link' : 'unreadable-directory', filename, error.message);
    }
  }

  async function scanPackage(location, context) {
    const actual = await controlledDirectory(location);
    if (!actual) return;
    const previous = byPath.get(actual);
    if (previous) {
      if (!previous.locations.includes(location)) previous.locations.push(location);
      if (context && !previous.peerContext) previous.peerContext = context;
      return;
    }
    let packageJson;
    try { packageJson = await readIdentity(actual); }
    catch (error) {
      report(error.code === 'ENOENT' ? 'missing-package-json' : error.code || 'invalid-package-json', location, error.message);
      return;
    }
    const instance = {
      id: `instance-${createHash('sha256').update(actual).digest('hex').slice(0, 24)}`,
      path: actual,
      sourceRoot,
      locations: [location],
      name: packageJson.name,
      version: packageJson.version,
      packageJson,
      contentHash: null,
      ...(context ? { peerContext: context } : {}),
    };
    byPath.set(actual, instance);
    try { instance.contentHash = await packageContent(actual); }
    catch (error) { report(error.code || 'unreadable-package-content', actual, error.message, { instanceId: instance.id }); }
    const nested = path.join(actual, 'node_modules');
    try { await fs.lstat(nested); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      report('unreadable-directory', nested, error.message);
      return;
    }
    await scanModules(nested, context);
  }

  async function scanStore(location, kind) {
    const actual = await controlledDirectory(location);
    if (!actual) return;
    stores.add(kind);
    for (const entry of await entries(actual)) {
      if (entry.name === 'node_modules') await scanModules(path.join(actual, entry.name));
      else if (!entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink())) {
        const group = await controlledDirectory(path.join(actual, entry.name));
        if (!group) continue;
        const nested = path.join(group, 'node_modules');
        try { await fs.lstat(nested); }
        catch (error) {
          if (error.code === 'ENOENT') continue; // Store metadata files are not packages.
          report('unreadable-directory', nested, error.message);
          continue;
        }
        await scanModules(nested, `${kind}:${entry.name}`);
      }
    }
  }

  async function scanModules(location, context) {
    const actual = await controlledDirectory(location);
    if (!actual || seenModules.has(actual)) return;
    seenModules.add(actual);
    for (const entry of await entries(actual)) {
      const filename = path.join(location, entry.name);
      if (entry.name === '.pnpm' || entry.name === '.store') {
        await scanStore(filename, entry.name === '.pnpm' ? 'pnpm' : 'yarn-store');
      } else if (entry.name.startsWith('@') && segment.test(entry.name.slice(1))) {
        const scope = await controlledDirectory(filename);
        if (!scope) continue;
        for (const child of await entries(scope)) {
          if (segment.test(child.name) && (child.isDirectory() || child.isSymbolicLink())) await scanPackage(path.join(filename, child.name), context);
        }
      } else if (segment.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) {
        await scanPackage(filename, context);
      }
    }
  }

  await scanModules(sourceRoot);
  const instances = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  const variants = new Map();
  for (const instance of instances) {
    instance.locations.sort();
    const key = `${instance.name}@${instance.version}`;
    if (!variants.has(key)) variants.set(key, []);
    variants.get(key).push(instance);
  }
  for (const [key, values] of variants) {
    if (new Set(values.map(value => value.contentHash).filter(Boolean)).size > 1) {
      report('content-conflict', values[0].path, `Different installed content for ${key}`, { instances: values.map(value => value.id) });
    }
  }
  return { sourceRoot, layout: stores.size > 1 ? 'mixed' : [...stores][0] || 'node-modules', instances, issues };
}

/** Make a fresh, materialized copy for later script-free packing; never modify the installed tree. */
export async function stageInstance(instance, destination) {
  const source = await fs.realpath(instance.path);
  const packageJson = await readIdentity(source);
  if (packageJson.name !== instance.name || packageJson.version !== instance.version) {
    throw failure('changed-package-identity', 'Source package identity changed since inventory');
  }
  for (const field of ['bundledDependencies', 'bundleDependencies']) {
    if (packageJson[field] !== undefined && packageJson[field] !== false &&
        !(Array.isArray(packageJson[field]) && packageJson[field].length === 0)) {
      throw failure('unsupported-bundled-repack', 'Bundled dependencies require the original tarball; installed bundle recovery is not implemented');
    }
  }
  const requested = path.resolve(destination);
  let ancestor = requested;
  const tail = [];
  while (true) {
    try { ancestor = await fs.realpath(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      tail.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  const target = path.join(ancestor, ...tail);
  const protectedRoots = [source, ...(instance.sourceRoot ? [await fs.realpath(instance.sourceRoot)] : [])];
  if (protectedRoots.some(root => inside(root, target) || inside(target, root))) throw failure('unsafe-staging-path', 'Staging must be separate from the installed tree');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.mkdir(target); // Existing output is never overwritten.
  try {
    const hash = await packageContent(source, target);
    if (!instance.contentHash || hash !== instance.contentHash) throw failure('changed-package-content', 'Source package content changed since inventory');
    return target;
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
}
