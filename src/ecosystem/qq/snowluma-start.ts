import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 手动把 SnowLuma 拉起来一次。
 *
 * 为什么只能「手动」：SnowLuma 的 EULA §5.4 禁止通过自动化脚本部署它、也禁止并进第三方安装包。
 * 所以这里既不代装、也不在开机时自己去叫醒它 —— 只有人在面板上按下那个按钮，才算他本人的意思。
 *
 * 为什么优先走计划任务：DSH 把每个子进程放进一个带 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 的 job，
 * DSH 一退出，job 句柄一关，里面的进程全被杀，连日志都不留。从 DSH 里 spawn 出来的 SnowLuma
 * 一样在 job 里 —— 父进程换了，job 没换。计划任务跑在服务树里、job 之外，所以能活过 DSH 重启。
 * 本机恰好有那个任务（SnowLuma-watchdog）时就借它跑一次；没有就退回到直接 spawn，
 * 并如实告诉用户这条线只活到 DSH 退出为止。
 */

const TASK = 'SnowLuma-watchdog';

export interface StartResult {
  started: boolean;
  /** `task` = 借计划任务跑了一次（能活过 DSH 退出）；`spawn` = 直接起的（DSH 一退出就没了）。 */
  how?: 'task' | 'spawn';
  error?: string;
}

/** 找 SnowLuma 的可执行入口：优先它自带的 node.exe，其次本机 node + index.mjs。 */
function entry(homeDir: string): { exe: string; args: string[]; cwd: string } | undefined {
  const own = join(homeDir, 'node.exe');
  const index = join(homeDir, 'index.mjs');
  if (existsSync(own) && existsSync(index)) return { exe: own, args: [index], cwd: homeDir };
  // 完整版自带 node.exe；Lite 版没有，只能用本机 node 去跑 index.mjs。
  if (existsSync(index)) return { exe: 'node', args: [index], cwd: homeDir };
  const launcher = join(homeDir, 'launcher.bat');
  if (existsSync(launcher)) return { exe: launcher, args: [], cwd: homeDir };
  return undefined;
}

function hasTask(): boolean {
  // 只在 Windows 上问；别的系统一律当没有。
  if (process.platform !== 'win32') return false;
  const r = spawnSync('schtasks', ['/query', '/tn', TASK], { windowsHide: true, stdio: 'ignore' });
  return r.status === 0;
}

export function startSnowluma(homeDir: string): StartResult {
  if (!homeDir || !existsSync(homeDir)) return { started: false, error: '不知道 SnowLuma 装在哪（填 qqNative.snowlumaHome）' };

  let taskFailed = false;
  if (process.platform === 'win32' && hasTask()) {
    const r = spawnSync('schtasks', ['/run', '/tn', TASK], { windowsHide: true, stdio: 'ignore' });
    if (r.status === 0) return { started: true, how: 'task' };
    // 任务存在但跑不起来（最常见是被人禁用了）—— 那就退回直接 spawn，
    // 不能因为一个坏掉的任务把整条路堵死。代价是这条线只活到 DSH 退出。
    taskFailed = true;
  }

  const e = entry(homeDir);
  if (!e) return { started: false, error: '这个目录里没有 node.exe / index.mjs / launcher.bat' };
  try {
    const child = spawn(e.exe, e.args, {
      cwd: e.cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return taskFailed ? { started: true, how: 'spawn', error: '计划任务没跑起来（可能被禁用了），改为直接起；这条线只活到 DSH 退出' } : { started: true, how: 'spawn' };
  }
  catch (error) {
    return { started: false, error: error instanceof Error ? error.message : String(error) };
  }
}