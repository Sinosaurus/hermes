import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, unlink, link, stat, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

export const PACK_NPM_VERSION = '11.19.0';
const OUTPUT_LIMIT = 16 * 1024 * 1024;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const packageSpec = pkg => `${pkg.name}@${pkg.version}`;

export function validateIdentity(pkg) {
  if (!pkg || typeof pkg.name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.name)) {
    throw new Error('Invalid npm package name');
  }
  // npm remains the SemVer authority; only disallow unsafe/non-exact input here.
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(pkg.version)) {
    throw new Error(`Invalid exact version for ${pkg.name}`);
  }
}

export function normalizeRegistry(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    throw new Error('Registry must be HTTPS (localhost HTTP is allowed), without embedded credentials/query/fragment');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.href;
}

export function publicUrl(value) {
  const url = new URL(value);
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  return url.href;
}

export function redact(value) {
  let text = String(value).replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@');
  for (const key of ['NPM_TOKEN', 'NODE_AUTH_TOKEN']) {
    if (process.env[key]) text = text.split(process.env[key]).join('[redacted]');
  }
  return text.replace(/(\b(?:_authToken|token|password|authorization)\s*[=:]\s*)[^\s,]+/gi, '$1[redacted]');
}

export async function command(executable, args, { cwd, timeoutMs = 300_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', length = 0, failure;
    const timer = setTimeout(() => { failure = new Error('Command timed out'); child.kill(); }, timeoutMs);
    const capture = key => data => {
      length += data.length;
      if (length > OUTPUT_LIMIT) { failure = new Error('Command output exceeds 16 MiB'); child.kill(); return; }
      if (key === 'stdout') stdout += data.toString(); else stderr += data.toString();
    };
    child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code === 0) return resolve(stdout);
      let npmCode;
      try { npmCode = JSON.parse(stdout).error?.code; } catch {}
      npmCode ||= stderr.match(/\bcode\s+(E[A-Z0-9_]+)/)?.[1];
      const error = new Error(redact(`${path.basename(executable)} failed${npmCode ? ` (${npmCode})` : ''}: ${stderr || stdout}`).slice(0, 3000));
      error.npmCode = npmCode; error.exitCode = code;
      reject(error);
    });
  });
}

export async function npmCommand(args, options = {}) {
  const { registry, packageName, cache, ...execution } = options;
  const flags = [...args, '--update-notifier=false', '--prefer-online=true', '--prefer-offline=false', '--offline=false', `--cache=${cache || process.env.OFFLINE_NPM_CACHE || path.join(tmpdir(), 'offline-npm-cache')}`];
  if (registry) {
    const normalized = normalizeRegistry(registry);
    flags.push(`--registry=${normalized}`);
    if (packageName?.startsWith('@')) flags.push(`--${packageName.split('/')[0]}:registry=${normalized}`);
  }
  // On Windows npm's .cmd wrapper would require a shell. npm run cli sets this JS entrypoint instead.
  if (process.env.npm_execpath && /\.(?:c?js|mjs)$/.test(process.env.npm_execpath)) {
    return command(process.execPath, [process.env.npm_execpath, ...flags], execution);
  }
  if (process.platform === 'win32') throw new Error('On Windows run through npm run cli -- ... (npm_execpath is required)');
  return command('npm', flags, execution);
}

export async function npmJson(args, options = {}) {
  const output = await npmCommand([...args, '--json'], options);
  try { return JSON.parse(output); } catch { throw new Error(`npm returned invalid/empty JSON for ${args[0]}`); }
}

export async function assertPackToolchain(options = {}) {
  const version = (await npmCommand(['--version'], options)).trim();
  if (version !== PACK_NPM_VERSION) throw new Error(`Packing requires verified npm ${PACK_NPM_VERSION}; found ${version}. Do not use an older pack --ignore-scripts for prepare.`);
  return version;
}

export async function readJson(file) {
  if ((await stat(file)).size > OUTPUT_LIMIT) throw new Error('JSON exceeds 16 MiB');
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeJson(file, data, { exclusive = false } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    if (exclusive) { await link(temporary, file); await unlink(temporary); }
    else await rename(temporary, file);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function fileHash(file, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

export async function assertIntegrity(file, integrity) {
  if (typeof integrity !== 'string' || !integrity.trim()) throw new Error('Missing artifact integrity');
  const candidates = integrity.trim().split(/\s+/).map(item => {
    const match = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$/.exec(item);
    if (!match) throw new Error('Unsupported or invalid SRI');
    return { algorithm: match[1], value: match[2] };
  });
  const order = ['sha512', 'sha384', 'sha256', 'sha1'];
  const algorithm = order.find(name => candidates.some(item => item.algorithm === name));
  const actual = await fileHash(file, algorithm, 'base64');
  if (!candidates.some(item => item.algorithm === algorithm && item.value === actual)) throw new Error('Artifact integrity mismatch');
}

export async function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe bundle path');
  }
  const base = await realpath(root);
  const file = path.resolve(base, relative);
  const actual = await realpath(file);
  if (!actual.startsWith(`${base}${path.sep}`)) throw new Error('Bundle path escapes root');
  if ((await lstat(file)).isSymbolicLink() || !(await stat(file)).isFile()) throw new Error('Bundle entries must be regular files');
  return actual;
}

export async function canonicalPath(value) {
  let ancestor = path.resolve(value);
  const tail = [];
  while (true) {
    try { return path.join(await realpath(ancestor), ...tail); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      tail.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}

export async function listFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Unregistered symlink in bundle: ${relative}`);
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported bundle entry: ${relative}`);
  }
  return files.sort();
}

export async function readArtifact(file) {
  const listing = (await command('tar', ['-tzf', file])).trim().split('\n');
  for (const entry of listing) {
    const parts = entry.replace(/\/$/, '').split('/');
    if (parts[0] !== 'package' || parts.some(part => part === '..' || part === '.') || entry.includes('\\') || entry.includes('\0')) throw new Error('Unsafe tarball member');
  }
  if (listing.filter(entry => entry === 'package/package.json').length !== 1) throw new Error('Tarball needs exactly one package/package.json');
  // No extraction is needed; reject links/devices rather than trust their targets during later installation.
  const verbose = await command('tar', ['-tvzf', file]);
  if (verbose.trim().split('\n').some(line => !['-', 'd'].includes(line[0]))) throw new Error('Tarball links and special files are not supported');
  const packageJson = JSON.parse(await command('tar', ['-xOf', file, 'package/package.json']));
  validateIdentity(packageJson);
  return { packageJson, members: listing };
}

export async function packArtifact(spec, destination, options = {}) {
  await assertPackToolchain(options);
  await mkdir(destination, { recursive: true });
  // Fresh artifact cache ensures remote byte checks cannot reuse a previous download of the same URL.
  const output = await npmJson(['pack', spec, '--ignore-scripts', '--pack-destination', path.resolve(destination)], { ...options, cache: path.join(path.resolve(destination), '.npm-cache') });
  if (!Array.isArray(output) || output.length !== 1 || typeof output[0].filename !== 'string' || path.basename(output[0].filename) !== output[0].filename) throw new Error('Unexpected npm pack output');
  const file = await safePath(destination, output[0].filename);
  const { packageJson } = await readArtifact(file);
  return { file, packageJson, sha256: await fileHash(file), artifactIntegrity: `sha512-${await fileHash(file, 'sha512', 'base64')}`, size: (await stat(file)).size };
}

export async function verifyBundle(directory) {
  const manifestFile = await safePath(directory, 'manifest.json');
  const manifest = await readJson(manifestFile);
  if (manifest.schemaVersion !== 1 || manifest.status !== 'complete' || !Array.isArray(manifest.packages) || !manifest.packages.length || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('Invalid/incomplete bundle manifest');
  const expectedFiles = Object.keys(manifest.files).sort();
  if (JSON.stringify(await listFiles(directory)) !== JSON.stringify([...expectedFiles, 'manifest.json', 'checksums.sha256'].sort())) throw new Error('Bundle file set differs from manifest');
  for (const [relative, hash] of Object.entries(manifest.files)) {
    if (!/^[0-9a-f]{64}$/.test(hash) || await fileHash(await safePath(directory, relative)) !== hash) throw new Error(`File checksum mismatch: ${relative}`);
  }
  const manifestDigest = await fileHash(manifestFile);
  const expectedChecksums = [...expectedFiles, 'manifest.json'].sort().map(relative => `${relative === 'manifest.json' ? manifestDigest : manifest.files[relative]}  ${relative}`).join('\n') + '\n';
  if (await readFile(await safePath(directory, 'checksums.sha256'), 'utf8') !== expectedChecksums) throw new Error('Invalid checksums.sha256');
  const identities = new Set(), ids = new Set();
  for (const pkg of manifest.packages) {
    validateIdentity(pkg);
    const identity = packageSpec(pkg);
    if (typeof pkg.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(pkg.id) || identities.has(identity) || ids.has(pkg.id) || !['registry-original', 'installed-repack'].includes(pkg.artifactKind)) throw new Error('Duplicate/invalid package identity');
    identities.add(identity); ids.add(pkg.id);
    if (manifest.files[pkg.file] !== pkg.sha256) throw new Error(`Missing package checksum: ${identity}`);
    const file = await safePath(directory, pkg.file);
    await assertIntegrity(file, pkg.artifactIntegrity);
    if (pkg.artifactKind === 'registry-original') await assertIntegrity(file, pkg.sourceIntegrity);
    const { packageJson } = await readArtifact(file);
    if (packageSpec(packageJson) !== identity) throw new Error(`Tarball identity mismatch: ${identity}`);
    if (pkg.metadataFile && !Object.hasOwn(manifest.files, pkg.metadataFile)) throw new Error('Unregistered metadata file');
  }
  if (!Array.isArray(manifest.tagPlan) || !Array.isArray(manifest.resources) || !Array.isArray(manifest.targets) || !manifest.targets.length) throw new Error('Missing tag/resource/target declarations');
  if (manifest.targets.some(target => !target || typeof target !== 'object' || Array.isArray(target))) throw new Error('Invalid target declaration');
  for (const plan of manifest.tagPlan) {
    if (!plan || typeof plan.name !== 'string' || !plan.set || typeof plan.set !== 'object' || Array.isArray(plan.set) || Object.values(plan.set).some(version => typeof version !== 'string')) throw new Error('Invalid tag plan');
  }
  const resourceIds = new Set();
  for (const resource of manifest.resources) {
    if (!resource || typeof resource.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(resource.id) || resourceIds.has(resource.id) || typeof resource.instructions !== 'string' || !resource.instructions.trim() || !Array.isArray(resource.targets) || !resource.targets.length || !Array.isArray(resource.files) || !resource.files.length || resource.files.some(file => typeof file !== 'string' || !Object.hasOwn(manifest.files, file))) throw new Error('Invalid resource declaration or missing file');
    resourceIds.add(resource.id);
  }
  const review = manifest.resourceReview;
  if (!review || !['pending', 'reviewed'].includes(review.status) || (review.status === 'reviewed' && (!Array.isArray(review.evidence) || !review.evidence.length || review.evidence.some(item => typeof item !== 'string' || !item.trim())))) throw new Error('Invalid resource review');
  return { manifest, manifestDigest };
}
