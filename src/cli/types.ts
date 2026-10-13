// 文件职责：命令参数与输出流契约；命令解析边界统一验证后交给业务层。
import type { OnProgress, Inventory } from '../core/types.js';

export interface CliOptions {
  json?: boolean;
  progress?: string;
  project?: string;
  package?: string[];
  packagesFile?: string;
  out?: string;
  registry?: string;
  resources?: string;
  allowHost?: string[];
  installFlag?: string[];
  nodeModules?: string;
  allowLinkRoot?: string[];
  repack?: boolean;
  bundle?: string;
  readRegistry?: string;
  recovery?: boolean;
  run?: string;
  acceptance?: string;
  overwriteTags?: boolean;
}
export interface OutputStream {
  isTTY?: boolean;
  write(text: string): unknown;
}
export type CliAction = (options: CliOptions, onProgress: OnProgress) => Promise<CommandResult>;

export type CommandResult =
  | Inventory
  | Awaited<ReturnType<typeof import('./actions.js').collectAction>>
  | Awaited<ReturnType<typeof import('../core/publish.js').planImport>>
  | Awaited<ReturnType<typeof import('../core/publish.js').importBundle>>;
