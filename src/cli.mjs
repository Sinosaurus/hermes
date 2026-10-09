#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { collect, recover } from './collect.mjs';
import { inventoryModules } from './recovery.mjs';
import { planImport, importBundle, promoteRun, rollbackRun } from './publish.mjs';
import { readJson, redact, verifyBundle, writeJson } from './common.mjs';
import { createProgress } from './progress.mjs';

const help = `offline-npm — npm tarball collection and offline import

Run: node src/cli.mjs <command> [options] (or npm --silent run cli -- ...)

collect   --project DIR | --package SPEC (repeat) / --packages-file JSON, --out DIR
          [--registry URL] [--resources JSON] [--allow-host HOST:PORT] (repeat)
          [--install-flag=--legacy-peer-deps] (repeat; see docs)
inventory --node-modules DIR [--out JSON] [--allow-link-root DIR] (repeat)
recover   --node-modules DIR --out DIR, --registry URL | --repack
          [--resources JSON] [--allow-host HOST:PORT] [--allow-link-root DIR]
verify    --bundle DIR
plan      --bundle DIR --registry URL [--read-registry URL] [--recovery]
import    --bundle DIR --registry URL --run DIR [--read-registry URL] [--recovery]
promote   --run DIR --acceptance JSON [--overwrite-tags]
rollback  --run DIR

Collection/packing requires Node 22+ and verified npm 11.19.0, plus system tar.
plan only queries. import uses temporary tags. promote requires real acceptance.
--recovery explicitly routes repacked artifacts to a dedicated recovery registry.
Outputs JSON. Exit 1: failed; exit 2: inventory issues or unresolved cleanup/rollback.
--progress=auto|plain|none controls stderr progress (auto uses a TTY progress bar).
See docs/architecture.md for resource and acceptance contracts.
`;

const string = { type: 'string' }, multiple = { type: 'string', multiple: true }, boolean = { type: 'boolean' };
const definitions = {
  collect: { project: string, package: multiple, 'packages-file': string, out: string, registry: string, resources: string, 'allow-host': multiple, 'install-flag': multiple },
  inventory: { 'node-modules': string, out: string, 'allow-link-root': multiple },
  recover: { 'node-modules': string, out: string, registry: string, repack: boolean, resources: string, 'allow-host': multiple, 'allow-link-root': multiple },
  verify: { bundle: string },
  plan: { bundle: string, registry: string, 'read-registry': string, recovery: boolean },
  import: { bundle: string, registry: string, 'read-registry': string, run: string, recovery: boolean },
  promote: { run: string, acceptance: string, 'overwrite-tags': boolean },
  rollback: { run: string },
};

function required(values, ...names) {
  for (const name of names) if (typeof values[name] !== 'string' || !values[name].trim()) throw new Error(`--${name} is required`);
}

const summary = (directory, verified) => ({ bundle: path.resolve(directory), batchId: verified.manifest.batchId, manifestDigest: verified.manifestDigest, packages: verified.manifest.packages.length, resources: verified.manifest.resources.length, resourceReview: verified.manifest.resourceReview, targets: verified.manifest.targets, stats: verified.stats });

async function packageInputs(values) {
  const repeated = values.package ?? [];
  if (!values['packages-file']) return repeated;
  if (values.project) throw new Error('--packages-file cannot be combined with --project');
  const list = await readJson(path.resolve(values['packages-file']));
  if (!Array.isArray(list) || !list.length || list.some(item => typeof item !== 'string' || !item.trim())) throw new Error('--packages-file must contain a nonempty JSON array of package specifications');
  return [...new Set([...list, ...repeated])];
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!action || ['help', '--help', '-h'].includes(action)) { process.stdout.write(help); return; }
  if (!Object.hasOwn(definitions, action)) throw new Error(`Unknown command: ${action}; use --help`);
  const { values } = parseArgs({ args, options: { ...definitions[action], progress: string, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false });
  if (values.help) { process.stdout.write(help); return; }
  const progress = createProgress({ mode: values.progress });
  const onProgress = event => progress.update(event);
  let output;
  try {
    if (action === 'collect') {
      required(values, 'out');
      const verified = await collect({ out: values.out, project: values.project, specs: await packageInputs(values), registry: values.registry, allowHosts: values['allow-host'], resourcesFile: values.resources, installFlags: values['install-flag'], onProgress });
      output = summary(values.out, verified);
    } else if (action === 'inventory') {
      required(values, 'node-modules');
      onProgress({ phase: 'inventory', completed: 0, total: 0 });
      output = await inventoryModules(values['node-modules'], { allowLinkRoots: values['allow-link-root'] });
      onProgress({ phase: 'inventory', completed: output.instances.length, total: output.instances.length });
      if (values.out) await writeJson(path.resolve(values.out), output, { exclusive: true });
      if (output.issues.length) process.exitCode = 2;
    } else if (action === 'recover') {
      required(values, 'node-modules', 'out');
      if (values.repack && values.registry) throw new Error('Use --registry for original artifacts or --repack for recovery artifacts, not both');
      const verified = await recover({ modules: values['node-modules'], out: values.out, registry: values.registry, repack: values.repack, allowHosts: values['allow-host'], allowLinkRoots: values['allow-link-root'], resourcesFile: values.resources, onProgress });
      output = summary(values.out, verified);
    } else if (action === 'verify') {
      required(values, 'bundle');
      output = summary(values.bundle, await verifyBundle(values.bundle));
    } else if (action === 'plan' || action === 'import') {
      required(values, 'bundle', 'registry', ...(action === 'import' ? ['run'] : []));
      const options = { registry: values.registry, readRegistry: values['read-registry'], runDir: values.run, recovery: values.recovery, onProgress };
      output = action === 'plan' ? await planImport(values.bundle, options) : await importBundle(values.bundle, options);
    } else if (action === 'promote') {
      required(values, 'run', 'acceptance');
      output = await promoteRun(values.run, { acceptanceFile: values.acceptance, overwriteTags: values['overwrite-tags'], onProgress });
    } else {
      required(values, 'run');
      output = await rollbackRun(values.run, { onProgress });
    }
    if (output.cleanupPending?.length || output.rollbackPending?.length) process.exitCode = 2;
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally { progress.stop(); }
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ status: 'failed', message: redact(error.message) })}\n`);
  process.exitCode = 1;
});
