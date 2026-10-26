import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * QQ: the outside `qq-bridge` process, managed as one more pipe into her home.
 *
 * Why it belongs here rather than in a .bat: the bridge is a separate process, and before this it took a
 * launcher by hand plus editing `state/sessions.json` by hand to point a QQ entry at a session. Inside the
 * plugin those become a click in the world console, and they share one lifecycle with memory, diary and the
 * life line. Nothing of the bridge's own logic is copied — this only probes, starts, stops, binds and reports.
 */

const PROBE_TIMEOUT_MS = 2500;
const STOP_WAIT_MS = 8000;
const START_WAIT_MS = 15000;

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The host logger, or nothing at all when the module runs without one. */
export interface QqLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

export interface QqSessionEntry { key: string; sessionId: string; owner: boolean }

/** What the console shows: is it up, is it talking to DSH, which entries are bound where. */
export interface QqStatus {
  running: boolean;
  port: number;
  dir: string;
  /** `reserved2` / `closed-agent` …; absent while the bridge is not answering. */
  mode?: string | null;
  /** DSH answers the bridge's own API calls — this is what goes false first when DSH moves to a new port. */
  dsh?: boolean;
  /** The QQ protocol side is online; when it drops, messages stop arriving. */
  connected?: boolean;
  accountOnline?: boolean;
  lastPacketAgoMs?: number | null;
  ownerQQ?: string | null;
  allowGroups?: string[];
  sessions: QqSessionEntry[];
  faults: string[];
}

export interface SyncResult { changed: boolean; reason?: string; baseUrl?: string; before?: string }
export interface StartResult { started: boolean; reason?: string }
export interface StopResult { stopped: boolean; reason?: string }
export interface BindResult extends StartResult { key: string; sessionId?: string }
export interface SyncEndpointResult extends SyncResult { restarted?: boolean }

export interface QqBridgeOptions {
  /** The qq-bridge checkout; nothing is guessed when this is empty, the module is simply off. */
  dir: string;
  /** The bridge's console port. */
  port?: number;
  /** Node to start the bridge with; the current process by default. */
  nodePath?: string;
  /** DSH's current origin, read fresh every time. */
  origin?: () => string;
  logger?: QqLogger;
}

export interface QqBridge {
  status(): Promise<QqStatus>;
  start(): Promise<StartResult>;
  stop(): Promise<StopResult>;
  bind(key: string, sessionId: string): Promise<BindResult>;
  unbind(key: string): Promise<BindResult>;
  ensureRunning(): Promise<StartResult>;
  syncEndpoint(): Promise<SyncEndpointResult>;
  faults(): string[];
}

/** The bridge's console token: `config.json` first, else `state/console-token` (rewritten on every start). */
export function readConsoleToken(dir: string): string {
  try {
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { consoleToken?: unknown };
    const fromConfig = typeof config?.consoleToken === 'string' ? config.consoleToken.trim() : '';
    if (fromConfig) return fromConfig;
  } catch {
    // An unreadable config.json is not fatal: there is a second copy below.
  }
  try {
    return readFileSync(join(dir, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** PowerShell and Notepad both like to save JSON with a BOM; `JSON.parse` dies on its first character. */
function readJsonTolerant(file: string): Record<string, any> {
  const raw = readFileSync(file, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as Record<string, any>;
}

/**
 * Writes DSH's current origin back into the bridge's `config.json` (`dsh.baseUrl`).
 *
 * Why the plugin owns this: DSH picks a new port on every restart, the bridge's baseUrl is a fixed value, and
 * nothing complains when it goes stale — `dshReady` just stays false and the event stream reconnects every 30s
 * for zero frames. 2026-10-26 the link sat dead for four hours looking exactly like a crashed bridge.
 */
export function syncBridgeBaseUrl(dir: string, origin: string, logger?: QqLogger): SyncResult {
  const url = typeof origin === 'string' ? origin.trim().replace(/\/+$/, '') : '';
  if (!/^https?:\/\/[^/]/i.test(url)) return { changed: false, reason: 'no-origin' };
  const file = join(dir, 'config.json');
  let config: Record<string, any>;
  try {
    config = readJsonTolerant(file);
  } catch (error) {
    return { changed: false, reason: `config.json 读不到：${messageOf(error)}` };
  }
  config.dsh = config.dsh ?? {};
  const before = typeof config.dsh.baseUrl === 'string' ? config.dsh.baseUrl.trim() : '';
  if (before === url) return { changed: false, baseUrl: url };
  config.dsh.baseUrl = url;
  // Written without a BOM: the bridge reads it as utf-8-sig, other tools choke on the BOM.
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  logger?.info?.(`[qq] 桥的 DSH 端点已更新：${before || '(空)'} → ${url}`);
  return { changed: true, baseUrl: url, before };
}

interface CallResult { status: number; body: any }

async function call(base: string, path: string, init: RequestInit = {}): Promise<CallResult> {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  const text = await response.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  return { status: response.status, body };
}

export function createQqBridge(options: QqBridgeOptions): QqBridge {
  const { dir, logger, port = 3100, nodePath = process.execPath, origin = () => '' } = options;
  const base = `http://127.0.0.1:${port}`;
  const entry = join(dir, 'src', 'bridge.js');
  const stateDir = join(dir, 'state');

  const faults = new Map<string, string>();
  let child: ReturnType<typeof spawn> | undefined;

  const note = (key: string, error: unknown): void => {
    faults.set(key, `${key}：${messageOf(error)}`);
    logger?.warn?.(`[qq] ${key}: ${messageOf(error)}`);
  };
  const clear = (key: string): void => { faults.delete(key); };

  function ensureDir(): void {
    if (!existsSync(entry)) throw new Error(`找不到桥的入口：${entry}`);
  }

  /** Whether the bridge is up: `/api/status` wants the console token too (401 without it), so it serves as the probe. */
  async function ping(): Promise<any> {
    try {
      const token = readConsoleToken(dir);
      const { status, body } = await call(base, `/api/status${token ? `?token=${encodeURIComponent(token)}` : ''}`);
      return status === 200 ? body ?? {} : undefined;
    } catch {
      return undefined;
    }
  }

  async function sessions(): Promise<any[]> {
    try {
      const token = readConsoleToken(dir);
      const { status, body } = await call(base, `/api/sessions${token ? `?token=${encodeURIComponent(token)}` : ''}`);
      return status === 200 && Array.isArray(body?.sessions) ? body.sessions : [];
    } catch {
      return [];
    }
  }

  async function status(): Promise<QqStatus> {
    const alive = await ping();
    if (!alive) return { running: false, port, dir, faults: [...faults.values()], sessions: [] };
    const list = await sessions();
    const snowluma = (alive.snowluma ?? {}) as { connected?: boolean; accountOnline?: boolean; lastPacketAgoMs?: number };
    return {
      running: true,
      port,
      dir,
      mode: typeof alive.mode === 'string' ? alive.mode : null,
      dsh: alive.dshReady === true,
      connected: snowluma.connected === true,
      accountOnline: snowluma.accountOnline === true,
      lastPacketAgoMs: snowluma.lastPacketAgoMs ?? null,
      ownerQQ: alive.ownerQQ ?? null,
      allowGroups: Array.isArray(alive.allowGroups) ? alive.allowGroups : [],
      sessions: list.map((item: any) => ({ key: String(item?.key ?? ''), sessionId: String(item?.sessionId ?? ''), owner: item?.owner === true })),
      faults: [...faults.values()],
    };
  }

  async function start(): Promise<StartResult> {
    ensureDir();
    // Line the endpoint up first: the bridge never notices DSH moved, and this is its only lifeline.
    const synced = syncBridgeBaseUrl(dir, origin(), logger);
    if (await ping()) {
      if (!synced.changed) return { started: false, reason: 'already-running' };
      // It already read the old baseUrl into memory — writing the file is not enough, it has to be restarted.
      await stop();
    }
    const proc = spawn(nodePath, ['src/bridge.js'], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true });
    proc.unref();
    child = proc;
    const deadline = Date.now() + START_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(600);
      if (await ping()) {
        clear('start');
        return { started: true };
      }
    }
    note('start', new Error(`拉起后 ${START_WAIT_MS / 1000}s 内没连上控制台，去看 state/bridge.log`));
    return { started: false, reason: 'not-ready' };
  }

  /** Graceful shutdown through the bridge's own `/api/restart` (it flushes state first), then wait for the port. */
  async function stop(): Promise<StopResult> {
    const token = readConsoleToken(dir);
    if (!(await ping())) return { stopped: false, reason: 'already-stopped' };
    try {
      await call(base, `/api/restart${token ? `?token=${encodeURIComponent(token)}` : ''}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
    } catch {
      // It drops the connection on the way out; that error is expected.
    }
    const deadline = Date.now() + STOP_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(400);
      if (!(await ping())) {
        clear('stop');
        return { stopped: true };
      }
    }
    note('stop', new Error('请求重启后端口仍在响应，可能被别的守护进程又拉起来了'));
    return { stopped: false, reason: 'still-alive' };
  }

  /**
   * Points a QQ entry (`group:123` / `private:123`) at a DSH session.
   * The bridge must be stopped while the file is edited: it reads `sessions.json` into memory at startup and
   * writes it back over anything changed while running — done by hand once, and that is exactly how it went.
   */
  async function bind(key: string, sessionId: string): Promise<BindResult> {
    const file = join(stateDir, 'sessions.json');
    if (!existsSync(file)) throw new Error(`找不到 ${file}`);
    await stop();
    const raw = readJsonTolerant(file);
    raw.sessions = raw.sessions ?? {};
    raw.sessions[key] = sessionId;
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    const started = await start();
    return { key, sessionId, ...started };
  }

  async function unbind(key: string): Promise<BindResult> {
    const file = join(stateDir, 'sessions.json');
    if (!existsSync(file)) throw new Error(`找不到 ${file}`);
    await stop();
    const raw = readJsonTolerant(file);
    if (raw.sessions) delete raw.sessions[key];
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    const started = await start();
    return { key, ...started };
  }

  /**
   * Endpoint alignment: writes the current origin into the bridge's config.json, and if it is running (holding
   * the old value in memory) restarts it once. With autoStart off only the first half happens — a bridge that
   * is meant to be stopped is not started behind the user's back.
   */
  async function syncEndpoint(): Promise<SyncEndpointResult> {
    const synced = syncBridgeBaseUrl(dir, origin(), logger);
    if (!synced.changed) return synced;
    if (!(await ping())) return { ...synced, restarted: false };
    const stopped = await stop();
    if (!stopped.stopped) return { ...synced, restarted: false, reason: 'stop-failed' };
    const started = await start();
    return { ...synced, restarted: started.started === true };
  }

  async function ensureRunning(): Promise<StartResult> {
    try {
      return await start();
    } catch (error) {
      note('start', error);
      return { started: false, reason: 'failed' };
    }
  }

  return { status, start, stop, bind, unbind, ensureRunning, syncEndpoint, faults: () => [...faults.values()] };
}