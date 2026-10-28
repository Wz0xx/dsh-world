# 交给她的安装说明

这份文件不是给人看的，是给 **DSH 里的陪伴角色**看的：谁把仓库地址发过来，谁就照着这份说明，把 `dsh-world` 装进 DSH、把 QQ 接上，最后让 QQ 里的她和人说话。

先说清 QQ 现在长什么样：**只有一条路——插件自己连 OneBot**（代码在 `src/ecosystem/qq-native/`，对外叫「原生通道」）。以前那个外部的桥进程已经在 2026-10-27 整段拆掉了，连它那几个配置项一起没了。所以这份说明里不会出现第二个进程，只有两样东西：插件，和负责登录 QQ 的 SnowLuma。

一句话说清边界：**第二步只有人能做——装 SnowLuma、拿手机扫码登录。这两件事你替不了，其余步骤你自己做。**

---

## 第零步：先摸清四件事

动任何文件之前，先把这四样查出来，后面每条命令都要用。

| 要知道的 | 怎么查 |
|---|---|
| `DSH_HOME` | Windows 默认 `C:\Users\<用户名>\.dsh`；看目录里有没有 `profiles`、`worlds` |
| 用哪个 profile | 列 `<DSH_HOME>/profiles/` 下的目录，挑 `package.json` 里 `dependencies` 有你正在跑的那些插件的那个 |
| node 版本 | `node -v`，必须 ≥ 22.16（dsh-world 的要求） |
| pnpm 在哪 | 先试 `pnpm -v`；没有就用 DSH 自带的：`<DSH 安装目录>\resources\runtime\x64\primary-runtime\dependencies\pnpm\bin\pnpm.cjs`，用 `node <那个 pnpm.cjs> <命令>` 调用 |

> macOS / Linux 的路径换成对应位置即可，命令不变。

---

## 第一步：把 dsh-world 装进 profile

```bash
git clone https://github.com/chenkezhen480/dsh-world.git

cd dsh-world
npm ci        # 仓库带 package-lock.json，能装全 devDependencies
npm pack      # 会先 typecheck + build，产出 dsh-world-<版本>.tgz
```

安装会自动执行 `scripts/patch-snowluma.mjs`，为固定的 SnowLuma SDK 1.x 补齐相对 ESM 导入的 `.js` 后缀，保留 Node 22 支持；不需要升级 DSH 的 Node。QQ 只在启用时加载，加载失败只显示 QQ 自身故障。

拿到 `dsh-world-0.6.0.tgz` 的**绝对路径**，然后：

```bash
cd <DSH_HOME>/profiles/<你的 profile>
node <pnpm.cjs 路径> add <tgz 的绝对路径>
```

如果包管理器阻止了安装脚本（或使用了 `--ignore-scripts`），在 profile 目录执行 `node node_modules/dsh-world/scripts/patch-snowluma.mjs`，重新启动 DSH 后再开启 QQ。此命令只修补该 SDK 的相对导入，可重复执行，不改世界数据。

**不要用 `link:` 指向 clone 下来的目录。** 那样会加载项目自带的一份 Cordis，和 DSH 自己的打架。README 里也写了这句，别忽略。

接着改两个文件：

**1. `<profile>/package.json`** —— 在 `dsh.profile.bundles` 数组里加一项 `"dsh-world"`：

```json
"dsh": { "profile": { "bundles": [ "…", "dsh-world" ] } }
```

**2. `<profile>/cordis.patch.yml`** —— 让插件知道 QQ 从哪儿接进来：

- 文件里**已经有** `- id: dsh-world` 的话，只补 `config` 下这一段
- **没有**的话，整段贴到文件末尾

```yaml
- insert:
    - id: dsh-world
      name: dsh-world
      config:
        qqNative:
          enabled: true
          wsUrl: ws://127.0.0.1:3003            # OneBot 的 WS 服务端口（不是 HTTP 那个）
          accessToken: '<OneBot 的 WS 服务端自己的 token>'
          allowPrivate: [ '3475994805' ]        # 谁能私聊她，留空 = 谁都不理
          allowGroups: [ '681528723' ]          # 群白名单
          autoReply: true                       # false = 只看不回
          contextMessages: 6                    # 每轮带上最近的几条
          groupTrigger: mention                 # 群里被叫到才接（@ / 被引用 / 命中 groupKeywords）；all = 每句都接
          groupKeywords: []
          bindHomeSession: none                 # owner = 群各自独立、主人私聊用她的家会话；all = 都用家会话；none = 各建一个
          snowlumaHome: 'D:\SnowLuma'           # 去哪儿读 SnowLuma 的 config/runtime.json（控制台那扇门要用）；不填按 D:\SnowLuma、C:\SnowLuma、E:\SnowLuma、~/SnowLuma、~/snowluma 挨个认
          # proactive: { enabled: false, dryRun: true, policy: { ... } }   # 主动开口，默认关
```

> 这一段**先照抄**：token、白名单、端口这些真值要等第二步人把 SnowLuma 装好才有，第五步再填。
> `qqNative.enabled` 写 `false`（或者整段不写）= 不接 QQ，控制台里那张 QQ 卡整个不出现。这是刻意的。
> 示例里 `bindHomeSession` 写了 `none`，是为了第一次联调不往她真正生活着的家会话里写东西；通道顺了以后改回默认的 `owner`（群各自独立、主人私聊用她的家会话）。
> 路径写 Windows 绝对路径，用正斜杠或单反斜杠都行。

---

## 第二步：装 SnowLuma，扫码登录，开 OneBot，把参数交给你（**只有人能做**）

### 2.1 装 SnowLuma 并扫码登录 QQ

- 下载：<https://github.com/SnowLuma/SnowLuma/releases/latest> 选 `SnowLuma-v<版本>-win-x64.zip`（完整版自带 Node 运行时；Lite 版要本机 Node 22.13+）
- 解压到任意目录，双击 `launcher.bat`
- 用**启动日志里打印的初始密码**登录 WebUI（地址也在日志里，通常是 `http://localhost:5099`）
- 按引导：同意条款 → 设置新密码 → **接入 QQ 进程（扫码）**

> **为什么这两件事不能自动化**：SnowLuma 的 EULA §5.4 明确禁止「通过自动化脚本部署」和「并入第三方安装包」。所以插件既不代装、也不代启动它，只连它开出来的 OneBot；装好一次之后，插件再也不碰它的安装目录。这不是我们偷懒，是对面写死的规矩。
> 另外扫码本身也要人拿手机。装好一次之后，以后重启不用再扫。

### 2.2 在 SnowLuma 里开 OneBot，把参数交给你

让人在 SnowLuma WebUI 里：

1. 开启 **WebSocket 服务端** → 记下端口（示例里写 `3003`，**以它页面上显示的为准**）
2. 开启 **HTTP API** → 也记下端口，但插件**不用**它，记下来只是为了别填错
3. 如果设了 accessToken，记下来 —— 你要的是 **WebSocket 服务端自己那个**

然后人把这几样告诉你：**WS 端口、WS 服务端的 accessToken（可能为空）、放行的 QQ 号、放行的群号**。

> **分不清两个 token 就看这里。** SnowLuma 给 HTTP 和 WebSocket 各生成一份 token，插件走的是 WebSocket 那条握手，拿 HTTP 那份会得到 `401`，卡上会直接写出来：`WS 错误: Unexpected server response: 401`。token 存在 SnowLuma 的 `config/onebot_*.json` 里 —— **认 `enableWebSocket` 为真的那个文件**，里面的 token 就是你要的。

---

## 第三步：重启一次 DSH

前两步改的都是「DSH 启动时才读」的东西：`bundles`、`cordis.patch.yml`。

所以现在**重启 DSH**。重启后验证两件事：

1. 打开 DSH 设置里的「世界控制台」，能看到世界卡——说明 dsh-world 起来了
2. 按一次「开始」，控制台里能找到 **QQ 卡**，状态是 `● 她自己的通道没连上`——说明 `qqNative.enabled` 生效了、卡出来了，只是还没填对参数（第五步才填）

> QQ 卡只在 `qqNative.enabled: true` 且世界已经开始时出现。世界没开始跑，通道不连、卡也不出来。

---

## 第四步：确认你自己能做的都做完了

跑一遍这个判断，全绿再进第五步：

| 检查 | 怎么验 | 期望 |
|---|---|---|
| dsh-world 已加载 | 浏览器打开 `http://127.0.0.1:<DSH 端口>/dsh-world/console/snapshot` | 返回 JSON，有 `worldId`、`life`、`native`。`qq` 那个字段现在恒为 `null`（拆掉的桥留下的），不用管它，看 `native` |
| 通道认了配置 | `http://127.0.0.1:<DSH 端口>/dsh-world/qq/native` | 返回的 `url` 是你填的 `wsUrl`；没连上时 `connected: false`、`lastError` 里写着原因。通道没开时这个端点返回 `null` |
| 世界在跑 | 控制台右上角是「停止」状态 | 通道跟着生活线一起起，世界没开始它不连 |

> 用浏览器而不是 curl：DSH 的 webServer 会校验 Host 头，curl 直接打会被挡。同源请求不受影响。

到这里，**你这一侧全部就绪**。剩下的是人必须插手的部分——也就是第二步已经做完的那两件事；做完之后你接手继续。

---

## 第五步：把参数填进去，接上（你来做）

拿到第二步那几个值，把第一步那段 `qqNative` 改真：

```yaml
        qqNative:
          enabled: true
          wsUrl: ws://127.0.0.1:3003
          accessToken: '<第二步拿到的 WS 服务端 token，没有就留空>'
          allowPrivate: [ '3475994805' ]        # 谁能私聊她；主动开口也发给这里面的第一个人
          allowGroups: [ '681528723' ]          # 要放行的群
          autoReply: true
          contextMessages: 6
          groupTrigger: mention
          groupKeywords: [ '小鱼' ]
          bindHomeSession: owner
          snowlumaHome: 'D:\SnowLuma'
```

改完重载插件（或者重启一次 DSH）就生效。**没有第二个进程要起**，QQ 这条线跑在插件自己的进程里。

两个坑，都会让人以为「装坏了」：

- **`wsUrl` 要填 OneBot 的 WebSocket 服务端端口**，不是 HTTP 那个。填错会一直连不上、日志刷重连。
- **`allowPrivate` / `allowGroups` 留空等于谁都不理**，不是「所有人都理」。白名单挡下的消息会计数，卡上显示 `· 挡下 N`。这是故意的，别指望它默认全接。

### 谁和谁共用一个会话

`bindHomeSession` 管的是这件事，值得单独说清楚：

| 值 | 效果 |
|---|---|
| `owner`（默认） | 主人私聊用她的「家会话」（`~/.dsh/worlds/<世界>/life.json` 里的 `homeSessionId`），**每个群各自一个独立会话**。群里聊的不会串到私聊，私聊里的记忆也不会漏进群 |
| `all` | 群里、私聊都用家会话，记忆完全共享；群里人多的时候上下文容易串味 |
| `none` | 谁都不绑：群各自一个，私聊也另建一个独立会话 |

> 自己开发调试这条通道时建议先写 `none`：测试回合不会写进她真正生活着的那条线，等通道彻底顺了再改回 `owner`。

规则是**每条消息现算的**，改完重载插件，下一条消息就按新规矩落会话。旧的频道会话留在原处不动（不自动拆，也不删）。

### 群里她什么时候接话

默认 `groupTrigger: mention`：只有这三种算在叫她，其余的**只记进上下文、不开口，也不烧一轮 token**：

- 被 `@` 到
- 引用她刚说过的那句话
- 文本命中 `groupKeywords` 里的词

写 `all` 就是群里每句都接 —— 那意味着群里每一条消息都会让她跑完一轮、还往群里冒一条，没人说话的时候也一样。**除非那个群本来就是你和她两个人的地方，否则别写 `all`。**

`contextMessages` 控制每轮带几条最近的上下文（默认 6）——群里那些没叫她的消息，价值就在这里：她看得见，但不接。

### 主动开口（她先说话）

`proactive` 默认关。打开后（控制台卡上那个「让她自己想说话时说」）她会自己隔一阵子找时机开口。规矩由 `policy` 定，默认值：

| 键 | 默认 | 意思 |
|---|---|---|
| `checkIntervalMs` | `300000` | 每 5 分钟判一轮 |
| `idleThresholdMs` | `1800000` | 至少 30 分钟没人说话才考虑开口 |
| `minIntervalMs` | `10800000` | 距上次主动开口要超过 3 小时 |
| `maxPerDay` | `3` | 每天最多主动发 3 条 |
| `maxCallsPerDay` | `12` | 每天最多问她 12 次（判成要开口才问，问一次算一次） |
| `quietHours` | `23:00` – `08:00` | 静默时段不开口 |
| `sendProbability` | `1` | 判成要开口时真发的概率（0–1） |
| `failureLimit` | `3` | 连续失败 3 次，当天不再问 |

`dryRun: true` 是**演练**：照常判定，但不问她、也不发消息、不花配额 —— 想先看看她判得准不准，就开这个。`proactive.enabled` 关着时 `policy` 里的数字一个都不看。

主动开口只发给 `allowPrivate` 里的**第一个人**；白名单空着就发不出去（会记成失败）。

账在 `~/.dsh/worlds/<世界>/qq-proactive.json`。

### 控制台那张 QQ 卡上有什么

「世界控制台」里那张 QQ 卡写的是：`● 她自己连着 ws://…`（或「她自己的通道没连上」）+ `收 N 个会话 · 发 N 条[ · 失败 N][ · 挡下 N][ · 会自己回 / 只看不回]`，出问题会跟一句 `lastError`。

下面是一排控件：

- **「会自己回话 / 只看不回」** —— 等于 `autoReply`。想只验链路通不通就先关掉：她会收、但一个字都不回，也不开会话、不花 AI 的额度。
- **「让她自己想说话时说 / 不主动开口」** —— 上面的 `proactive.enabled`。
- **「演练模式（判而不做，不问她也不发）」** —— 上面的 `proactive.dryRun`。
- **「打开 SnowLuma 控制台」** —— 见下。
- **「刷新」** —— 重新拉一次快照。

这三个勾选和另外两个按钮都是**活的**：改完下一次判定就生效，不用重启。临时覆盖存在 `~/.dsh/worlds/<世界>/qq-native.json`；profile 里的值仍然是最底下的默认。

设置页「模块」里的 QQ 那一行管的是**通道本身**：关掉就断开这条 OneBot 连接、QQ 卡隐藏；再打开就恢复。状态记在 `world.json`。配置里没写 `qqNative.enabled: true` 时，这个开关按不动（控制台会明说）。

### SnowLuma 控制台那扇门

插件读 `snowlumaHome/config/runtime.json` 找 SnowLuma 的 WebUI 地址与端口，按钮点开就用系统浏览器打开、**带着登录票据**（`?token=…`），不用手输密码。

- **第一次**要先填一次 SnowLuma 的**面板密码**：那边只认密码，会话令牌只活在它的进程内存里。填对一次之后，密码记在 `<世界目录>/panel.json`（权限 600），以后点开就直接进。
- `snowlumaHome` 不填时，按 `D:\SnowLuma`、`C:\SnowLuma`、`E:\SnowLuma`、`~/SnowLuma`、`~/snowluma` 挨个认，认的是「里面有 `config/runtime.json`」这一条。

---

### 阳台：让本机别的程序也能跟她说上话

插件自己开一条 WebSocket（**默认关着**；在控制台 QQ 卡片上点「开这条线」就是 `ws://127.0.0.1:3210`，只认口令）。机器上任何会读写一行 JSON 的程序都能接上来，递一句话给她、听她回一句。设置页那张 QQ 卡上有地址、口令，还有一个「复制这条命令」——复下来的是一个现成的小程序，粘到对面就能用：

    DSH_QQ_BRIDGE_URL=ws://127.0.0.1:3210 DSH_QQ_BRIDGE_TOKEN=… node "<运行目录>/lib/qq-line.js" <这条线叫什么> <会话标识>

一条线就是她的一间屋子（`channel` 是 `qq-bridge`，会话标识是线名），和 QQ 那几条互不打扰。递话、回话都是一行 JSON：

    递给她   {"text":"…","from":"谁"}            直接说一句
             {"kind":"ring"}                      只敲一下门，不说话
    她回话   {"kind":"reply","threadId":"…","text":"…","hold"?:true}
             {"kind":"error","message":"…"}

她可以在回话里带上怎么对待门外，这两个词不会被当成话发出去：`[安静]`（这条线半小时内不再敲得动门）与 `[待一会]`/`[在忙]`（对面收到 `hold`）。口令存在世界目录的 `qq-bridge.json` 里，重启 DSH 对面那份不用改；端口在 `qqNative.bridge.port`（`0` = 不开，默认 3210）。

那张卡上会显示「阳台开着 ws://127.0.0.1:<端口> · 连着几条线 · 收了几句、回了几句、她开口几次」，出问题就看同一行的 `lastError`。

## 验证清单

按顺序过一遍，哪条不过就查下表：

1. `http://127.0.0.1:<DSH 端口>/dsh-world/qq/native` → `connected: true`，`url` 是你填的那个 ws 地址
2. DSH 里「世界控制台」→ QQ 卡：`● 她自己连着 ws://…`，`挡下 0`
3. QQ 上用一个在白名单里的号给她私聊发一条 → 她回
4. 群里 @ 她 → 她回；群里说一句没叫她的 → 她**不回**，但卡上的会话计数和上下文在走
5. 设置页「模块」里关掉 QQ → 通道断开、QQ 卡隐藏 → 再打开 → 回来

## 出问题看这里

| 现象 | 真正的原因 |
|---|---|
| 世界卡在，但完全没有 QQ 卡 | ① `qqNative.enabled` 不是 `true`（或 `qqNative` 那一段缩进错了，没落在 `config:` 下面）——卡只在通道启用且世界已经开始时出现；② 装的是不含 QQ 模块的旧版本（0.5.2 及之前的上游 `main`）→ 按第一步用当前仓库重新打包安装 |
| 卡上写 `WS 错误: Unexpected server response: 401` | `accessToken` 填成了 HTTP 服务的 token。要用 **WS 服务端自己那个**：SnowLuma 的 `config/onebot_*.json` 里 `enableWebSocket` 为真的那个文件 |
| 一直连不上，日志刷重连 | `wsUrl` 的端口填成了 HTTP API 那个。要填 WebSocket 服务端的端口，端口号以 SnowLuma 页面上显示的为准 |
| 私聊发了没反应，卡上「挡下 N」在涨 | 那个 QQ 号不在 `allowPrivate` 里。白名单留空 = 谁都不理，抬手加上去 |
| 群里 @ 她了，还是不接 | 群里默认 `groupTrigger: mention`，只有 @、引用她的消息、命中 `groupKeywords` 才算叫她；另外确认群号在 `allowGroups` 里（要数字，别写成别的字） |
| 她收得到但一个字不回 | `autoReply` 关着（卡上写着「只看不回」），或者卡上那个勾被拨掉了 |
| 主动开口一条也发不出来 | `allowPrivate` 是空的（没处发）；或者 `dryRun` 开着（演练不真发）；或者还没满足 `idleThresholdMs` / 已到 `maxPerDay` / 正处 `quietHours` |
| 点「打开 SnowLuma 控制台」说「还差一次面板密码」 | 第一次要先填一次 SnowLuma 的面板密码，填对了就记在 `<世界目录>/panel.json`，之后不用再填 |
| 点那扇门说「没找到 SnowLuma 的控制台配置」 | `snowlumaHome` 没填或填错；它要的是 SnowLuma 的**安装目录**（里面得有 `config/runtime.json`） |
| 设置页「模块」里的 QQ 开关按不动 | 配置里没写 `qqNative.enabled: true`，控制台不会凭空打开一个没配的模块 |

---

## 一句话总结给主人听

「装好了。以后重启电脑只要两件事：DSH 起来（QQ 那条通道跟着生活线一起起）、SnowLuma 自己重连。除非换 QQ 号，否则不用再扫码。」
