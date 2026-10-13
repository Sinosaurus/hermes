// 文件职责：收集、盘点和发布流程共用的数据契约；外部数据仍需运行时校验。
export interface PackageIdentity {
  name: string;
  version: string;
}
export type Tags = Record<string, string>;
export interface PackageJson extends PackageIdentity {
  scripts?: Record<string, string>;
  dependencies?: Tags;
  optionalDependencies?: Tags;
  peerDependencies?: Tags;
  deprecated?: string;
  workspaces?: unknown;
  bundledDependencies?: boolean | string[];
  bundleDependencies?: boolean | string[];
  dist?: { tarball?: string; integrity?: string; shasum?: string };
  'dist-tags'?: Tags;
}
export interface TransferStats {
  total: number;
  downloaded: number;
  downloadBytes: number;
  uploaded: number;
  uploadBytes: number;
  reused: number;
  repacked?: number;
  packedBytes?: number;
}
export interface ProgressEvent extends Partial<TransferStats> {
  phase: string;
  completed?: number;
  name?: string;
  version?: string;
}
export type OnProgress = (event: ProgressEvent) => void;
export interface Target {
  os: string;
  cpu: string;
  node?: string;
  nodeAbi?: string;
  libc?: string;
}
export interface ResourceReview {
  status: 'pending' | 'reviewed';
  evidence?: string[];
}
export interface Resource {
  id: string;
  targets: Target[];
  instructions: string;
  files: string[];
}
export interface ResourceConfig {
  resources: (Omit<Resource, 'files'> & { source: string })[];
  review?: ResourceReview;
}
export interface BundlePackage extends PackageIdentity {
  id: string;
  artifactKind: 'registry-original' | 'installed-repack';
  file: string;
  sha256: string;
  artifactIntegrity: string;
  sourceIntegrity: string | null;
  metadataFile?: string;
  sourceRegistry?: string;
  sourceTarball?: string;
  instances?: { context: string; location: string }[];
}
export interface TagPlan {
  name: string;
  sourceTags: Tags;
  set: Tags;
  excluded: { tag: string; version: string; reason: string }[];
}
export interface Manifest {
  schemaVersion: number;
  status: string;
  batchId: string;
  capturedAt: string;
  mode: string;
  toolchain: { node: string; npm: string };
  targets: Target[];
  roots: {
    context?: string;
    name?: string;
    version?: string;
    requested?: string;
    resolved?: Tags;
  }[];
  inputs: {
    context?: string;
    packageJson?: string;
    lock?: string;
    installFlags?: string[];
    inventory?: string;
    layout?: string;
  }[];
  packages: BundlePackage[];
  tagPlan: TagPlan[];
  resources: Resource[];
  resourceReview: ResourceReview;
  exceptions: { context: string; location: string; reason: string }[];
  files: Record<string, string>;
}
export interface VerifiedBundle {
  manifest: Manifest;
  manifestDigest: string;
  stats?: TransferStats;
}
export interface LockEntry {
  name?: string;
  version: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  inBundle?: boolean;
  optional?: boolean;
  peer?: boolean;
}
export interface NpmLock {
  lockfileVersion: number;
  packages: Record<string, LockEntry>;
}
export interface SourceEntry extends PackageIdentity {
  location?: string;
  resolved?: string;
  integrity?: string;
}
export interface InstalledInstance extends PackageIdentity {
  id: string;
  path: string;
  sourceRoot: string;
  locations: string[];
  packageJson: PackageJson;
  contentHash: string | null;
  peerContext?: string;
}
export interface InventoryIssue {
  code: string;
  path: string;
  message: string;
  target?: string;
  instanceId?: string;
  instances?: string[];
}
export interface Inventory {
  sourceRoot: string;
  layout: string;
  instances: InstalledInstance[];
  issues: InventoryIssue[];
}
export interface CollectOptions {
  out: string;
  project?: string;
  specs?: string[];
  registry?: string;
  allowHosts?: string[];
  resourcesFile?: string;
  installFlags?: string[];
  onProgress?: OnProgress;
}
export interface RecoverOptions extends Omit<CollectOptions, 'project' | 'specs' | 'installFlags'> {
  modules?: string;
  repack?: boolean;
  allowLinkRoots?: string[];
}
export interface RunIdentity {
  schemaVersion: number;
  runId: string;
  createdAt: string;
  bundle: string;
  registry: string;
  readRegistry: string;
  recovery: boolean;
  manifestDigest: string;
  manifest: Manifest;
  tagSnapshot: Record<string, Tags>;
  temporaryTag: string;
  writerConstraint: string;
}
export interface TagIntent {
  name: string;
  tag: string;
  before: string | null;
  after: string;
  status: string;
}
export interface Acceptance {
  status: string;
  manifestDigest: string;
  writeRegistry: string;
  readRegistry: string;
  targets: Target[];
  resourceReview: string;
  evidence: string[];
  file?: string;
  sha256?: string;
}
export interface RunState {
  schemaVersion: number;
  runId: string;
  identityDigest: string;
  phase: string;
  versions: Record<string, { status: string; sha256: string }>;
  temporaryTags: Record<string, { versions: string[]; status: string }>;
  tagIntents: TagIntent[];
  attempts: number;
  error?: string;
  acceptance?: Acceptance;
  cleanupPending?: string[];
  rollbackPending?: string[];
}
