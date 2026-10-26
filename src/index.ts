import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { createBridge, type Bridge } from './bridge/bridge.ts';
import { bridgeRoute } from './bridge/route.ts';
import { consoleRoute, type ConsoleActions } from './console/routes.ts';
import { consoleSources } from './console/snapshot.ts';
import { errorText, Faults } from './faults.ts';
import { hostLife } from './life/host.ts';
import { createLifeStore, durableWrite } from './life/lifeStore.ts';
import { toastSupported, windowsToast, type Notifier } from './life/notify.ts';
import { createLifeRuntime, type LifeRuntime } from './life/runtime.ts';
import type { LifeOptions } from './life/types.ts';
import { createOutlet } from './outlets.ts';
import { readPersona, writePersona } from './persona.ts';
import { createQqBridge, type QqBridge } from './qq/bridge.ts';
import { qqRoute } from './qq/route.ts';
import { createWorldRuntime } from './runtime.ts';
import { createArchiveStore } from './store.ts';
import type { WorldConfig } from './types.ts';
import { DEFAULT_TEMPLATE_FILE, worldNames } from './worldPrompt.ts';
import { createWorldSwitch } from './worldSwitch.ts';

export { createWorldRuntime } from './runtime.ts';
export type { WorldConfig, ConversationRecord, ConversationTurn, ArchiveCursor } from './types.ts';
export const name = 'dsh-world';
export const inject = ['agents', 'sessions', 'sessionPersistence', 'llm'];
/** What `apply` receives: the schema below fills these defaults. */
export type Config = WorldConfig & Required<Pick<WorldConfig, 'life' | 'fallbackWakeTime' | 'outlets' | 'bridge' | 'toast' | 'allowedHosts' | 'qqBridgeDir' | 'qqBridgePort' | 'qqBridgeAutoStart'>>;
// One companion per profile is the usual case, so it works as installed: the standard preset, a world named
// default and the system time zone, with the life line on (it needs the desktop host's services and stays off without them).
const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const Config = z.object({
  worldId: z.string().default('default'), agentPreset: z.string().default('standard'), timeZone: z.string().default(systemTimeZone),
  companionName: z.string(), partnerName: z.string(),
  archiveScope: z.union([z.const('world'), z.const('home')]).default('world'),
  life: z.boolean().default(true), diaryDir: z.string(), fallbackWakeTime: z.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
  selfFile: z.string(), worldPromptFile: z.string(), alarmTemplateFile: z.string(), personaFile: z.string(),
  // Where her words go outside DSH; no app is known by name (see README for the push body).
  outlets: z.array(z.object({ name: z.string().required(), url: z.string(), urlFile: z.string(), path: z.string(), kinds: z.array(z.union([z.const('reply'), z.const('busy'), z.const('reach')])) })).default([]),
  // A local app may hand her partner's words to her home through POST /dsh-world/bridge/say.
  bridge: z.boolean().default(false),
  toast: z.boolean().default(true),
  // The console and the bridge answer only this machine by name, plus these (a LAN address or domain behind a proxy).
  allowedHosts: z.array(z.string()).default([]),
  // QQ: her home is reachable from outside DSH through a separate `qq-bridge` process. Empty qqBridgeDir leaves
  // this whole module off; the bridge is started by hand from the console unless qqBridgeAutoStart says otherwise.
  qqBridgeDir: z.string().default(''), qqBridgePort: z.number().default(3100), qqBridgeNode: z.string(),
  qqBridgeAutoStart: z.boolean().default(false),
});
interface WebServer { register(route: ReturnType<typeof consoleRoute> | ReturnType<typeof bridgeRoute> | ReturnType<typeof qqRoute>): () => void }

/**
 * Her world runs only after her partner presses start in the world console, and stops when they press stop:
 * memory block, persona, world prompt, archive and life line come and go together. The switch is kept in
 * `<world>/world.json`, so it outlasts a restart.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const dshHome = resolveDshHome();
  const worldDir = join(dshHome, 'worlds', config.worldId);
  const store = createArchiveStore({ ...config, root: dshHome });
  const power = createWorldSwitch(worldDir);
  const faults = new Faults();
  // Her self-description lives in her room whether or not the life line runs; she writes it with her file tools.
  const selfFile = config.selfFile || join(worldDir, 'room', '我是谁.md');
  const personaFile = config.personaFile || join(worldDir, 'persona.md');
  const worldPromptFile = config.worldPromptFile || join(worldDir, 'world-prompt.md');
  const options: LifeOptions = { worldDir, roomDir: join(worldDir, 'room'), diaryDir: config.diaryDir || join(worldDir, 'diary'), selfFile, fallbackWakeTime: config.fallbackWakeTime, timeZone: config.timeZone, alarmFile: config.alarmTemplateFile || join(worldDir, 'alarm.md') };
  /** The name in her persona comes first, then the configured one. */
  const names = () => worldNames({ ...config, companionName: readPersona(personaFile).名字 || config.companionName });
  // Set while the life line runs; otherwise no session is her home.
  let isHome: (sessionId: string) => boolean = () => false;

  let memory: ReturnType<typeof createWorldRuntime> | undefined;
  async function startMemory(fresh: boolean): Promise<void> {
    if (memory) return;
    const prompt = { file: worldPromptFile, persona: personaFile, conversationsDir: join(worldDir, 'conversations'), names: names(), ...(config.life ? { life: options } : {}) };
    memory = createWorldRuntime(ctx, { ...config, selfFile }, store, { prompt, isHome: id => isHome(id) }, power.memoryTurns);
    await memory.start({ fresh });
  }
  async function stopMemory(): Promise<void> {
    const running = memory; memory = undefined;
    await running?.stop();
  }
  ctx.effect(() => () => stopMemory().finally(() => store.close()), 'dsh-world memory line');
  if (power.running()) await startMemory(false);

  // The console and the life line need the desktop host.
  ctx.inject(['sessionController', 'permissionPresets', 'webServer'], async lifeCtx => {
    const webServer = (lifeCtx as unknown as { webServer: WebServer }).webServer;
    const host = hostLife(lifeCtx);
    // QQ: one more door into her home, managed here rather than by a launcher script. The endpoint is aligned
    // on every start whether or not the bridge runs — DSH picks a new port each restart, and a stale baseUrl
    // looks exactly like a dead bridge (a dead event stream, no error, for hours).
    const qq = config.qqBridgeDir
      ? createQqBridge({ dir: config.qqBridgeDir, port: config.qqBridgePort, nodePath: config.qqBridgeNode || process.execPath, origin: () => host.origin(), logger: lifeCtx.logger })
      : undefined;
    if (qq) {
      const service = qq;
      lifeCtx.effect(() => webServer.register(qqRoute(service, config.allowedHosts)), 'dsh-world qq route');
      void (config.qqBridgeAutoStart ? service.ensureRunning() : service.syncEndpoint()).catch(error => lifeCtx.logger.warn(error));
    }
    const lifeStore = (() => {
      if (!config.life) return undefined;
      try { return createLifeStore(worldDir, config.timeZone); }
      catch (error) { faults.set('life', `生活线没能启动：${errorText(error)}`); lifeCtx.logger.error(error); return undefined; }
    })();
    let life: LifeRuntime | undefined;
    let bridge: Bridge | undefined;
    async function startLife(resumed: boolean): Promise<void> {
      if (!lifeStore || life) return;
      try {
        const outlets = config.outlets.map(outlet => createOutlet(outlet, () => host.origin()));
        const notifier: Notifier = { ...(config.toast && toastSupported() ? { toast: windowsToast() } : {}), outlets };
        const current = createLifeRuntime({ ctx: lifeCtx, config: { ...config, companionName: names().companion }, options, store: lifeStore, host, notifier, dailyBudget: power.dailyBudget });
        life = current; isHome = current.isHome;
        if (config.bridge) { bridge = createBridge({ ctx: lifeCtx, home: () => current.home(), outlets, origin: () => host.origin(), file: join(worldDir, 'bridge.json'), name: names().companion }); bridge.start(); }
        faults.clear('life');
        await current.start({ resumed });
      } catch (error) {
        // The console still opens and says why, instead of looking as if the life line were simply off.
        stopLife();
        faults.set('life', `生活线没能启动：${errorText(error)}`); lifeCtx.logger.error(error);
      }
    }
    function stopLife(): void {
      isHome = () => false;
      bridge?.stop(); life?.stop();
      bridge = undefined; life = undefined;
    }
    lifeCtx.effect(() => () => stopLife(), 'dsh-world life line');
    // The host matches exact routes before the longest prefix, so this path never reaches the console.
    if (config.bridge) lifeCtx.effect(() => webServer.register(bridgeRoute(() => bridge, config.allowedHosts)), 'dsh-world bridge route');

    const sources = consoleSources({ ctx: lifeCtx, config, archive: store, names, ...(lifeStore ? { lifeStore } : {}), life: () => life, diaryDir: options.diaryDir, running: power.running, dailyBudget: power.dailyBudget, memoryTurns: power.memoryTurns, ...(qq ? { qq: () => qq.status() } : {}), faults: () => [...faults.list(), ...(memory?.faults() ?? []), ...(bridge?.faults() ?? []), ...(qq?.faults() ?? [])] });
    const actions: ConsoleActions = {
      async start() {
        if (power.running()) return;
        power.set(true);
        try { await startMemory(true); await startLife(true); } finally { sources.invalidate(); }
      },
      async stop() {
        if (!power.running()) return;
        power.set(false);
        stopLife();
        try { await stopMemory(); } finally { sources.invalidate(); }
      },
      prompts: () => ({
        persona: readPersona(personaFile),
        worldPrompt: existsSync(worldPromptFile) ? { text: readFileSync(worldPromptFile, 'utf8'), custom: true } : { text: readFileSync(DEFAULT_TEMPLATE_FILE, 'utf8'), custom: false },
      }),
      savePersona: persona => { writePersona(personaFile, { ...readPersona(personaFile), ...persona }); sources.invalidate(); },
      setDailyBudget: yuan => { power.setDailyBudget(yuan); sources.invalidate(); },
      setMemoryTurns: turns => { power.setMemoryTurns(turns); sources.invalidate(); },
      saveWorldPrompt: text => { if (text.trim()) durableWrite(worldPromptFile, text); else rmSync(worldPromptFile, { force: true }); },
    };
    lifeCtx.effect(() => webServer.register(consoleRoute(sources, actions, config.allowedHosts)), 'dsh-world console routes');
    if (power.running()) await startLife(false);
  });
}
