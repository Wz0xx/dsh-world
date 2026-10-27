import { connect } from 'node:net';
import { startSnowluma, type StartResult } from './snowluma-start.ts';

/**
 * SnowLuma 的看门狗，做进插件里。
 *
 * 以前这个活是 `~/.dsh/tools/snowluma-watchdog.ps1` 加一个 Windows 计划任务干的：脚本每分钟探一次
 * 3003，不通就把 SnowLuma 拉起来。那种做法有两个毛病 —— 它跟插件各活各的（插件没装、任务还在跑），
 * 而且别人装插件时得额外去建一个计划任务，步骤一多就没人做。
 *
 * 做进插件之后只剩一条规矩：**插件在，就盯着**。探到 3003 不通就问一次 SnowLuma 家目录在不在，
 * 在就拉。拉不起来把原因记在面板上，不反复刷——退避到 30 秒一轮，不轰炸。
 */
export interface SnowlumaStatus {
  /** 正在盯着没有。 */
  watching: boolean;
  /** 上一次探测时 3003 通不通。 */
  alive: boolean;
  lastCheckAt: string | null;
  /** 由看门狗拉起来的次数。 */
  restarts: number;
  lastRestartAt: string | null;
  lastError: string | null;
}

export interface SnowlumaSupervisorOptions {
  /** SnowLuma 的家目录，空字符串表示没配。 */
  homeDir: string;
  host: string;
  port: number;
  intervalMs?: number;
  probeTimeoutMs?: number;
  /** 探活；测试里换掉。 */
  probe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  /** 拉起来；测试里换掉。 */
  launch?: () => StartResult;
  log: (message: string) => void;
}

/** 探一下某个端口通不通。连上就算活，其余全算死。 */
function probePort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export function createSnowlumaSupervisor(options: SnowlumaSupervisorOptions) {
  const intervalMs = options.intervalMs ?? 30_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 3_000;
  const probe = options.probe ?? probePort;
  const launch = options.launch ?? (() => startSnowluma(options.homeDir));
  const state: SnowlumaStatus = {
    watching: false, alive: false, lastCheckAt: null, restarts: 0, lastRestartAt: null, lastError: null,
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;

  async function tick(): Promise<void> {
    // 上一轮还没探完（网络卡住）就别叠第二轮：探活本身有超时，叠起来只会互相拖。
    if (busy) return;
    busy = true;
    try {
      const alive = await probe(options.host, options.port, probeTimeoutMs);
      state.alive = alive;
      state.lastCheckAt = new Date().toISOString();
      if (alive) { state.lastError = null; return; }
      if (!options.homeDir) {
        state.lastError = '没配 qqNative.snowlumaHome，不知道 SnowLuma 装在哪';
        return;
      }
      const result = launch();
      if (result.started) {
        state.restarts += 1;
        state.lastRestartAt = new Date().toISOString();
        state.lastError = result.error ?? null;
        options.log(`看门狗：3003 不通，已拉起 SnowLuma（${result.how ?? '未知方式'}）${result.error ? `，但${result.error}` : ''}`);
      } else {
        state.lastError = result.error ?? '拉不起来，原因不明';
        options.log(`看门狗：3003 不通，SnowLuma 没起来：${state.lastError}`);
      }
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  return {
    start(): void {
      if (timer) return;
      state.watching = true;
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref?.();
      void tick();
    },
    stop(): void {
      state.watching = false;
      if (timer) { clearInterval(timer); timer = undefined; }
    },
    /** 面板上「现在拉一次」用的：探一次、不通就拉。 */
    async checkNow(): Promise<SnowlumaStatus> {
      await tick();
      return { ...state };
    },
    status(): SnowlumaStatus { return { ...state }; },
  };
}

export type SnowlumaSupervisor = ReturnType<typeof createSnowlumaSupervisor>;