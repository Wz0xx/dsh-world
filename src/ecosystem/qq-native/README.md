# QQ 原生通道

插件直连 SnowLuma 提供的 OneBot WebSocket，自己收、自己发。中间没有第二个进程，也不需要另一套 QQ 实现。

## 文件

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 插件主体：配置、连接、白名单、合批、会话路由、回复分条、主动开口推送、静默 |
| `snowluma.ts` | SDK 侧：连接、把事件归一化成段、发送 |
| `home.ts` | 把一个人的话送进家会话（或群会话），拿回这一轮的回答 |
| `native-bridge.ts` | 「阳台」：给这台机器上别的程序留的一条线 |
| `ws.d.ts` | `ws` 的最小类型声明 |

## 依赖

- Node 22（测试用 `node --experimental-strip-types` 跑，不需要预编译）
- `ws`，运行期依赖（阳台的 `WebSocketServer` 从它来）
- `@snowluma/sdk@1.14.22`，声明在 `optionalDependencies` —— 不开 QQ 就不加载，没装也不影响插件本身
- SnowLuma 本体要单独装、单独登录，装法和参数见 [INSTALL.md](../../../INSTALL.md)

## 支持的消息类型

**收**：`text` / `at` / `face` / `mface` / `image` / `record` / `video` / `file` / `reply` / `json` / `markdown` / `forward`

- 图片、语音、视频、文件都带文件标识，例如 `[图片 file=4EF2F7D340DA07EBC890F4F7D40F94DF.jpg]`。光写 `[图片]` 等于把图丢了，所以 content 要另外拿这个 `file` 去 OneBot 换（`get_image` / `get_record`）
- 卡片、合并转发这类段压成占位符，内容不进上下文

**发**：`text` / `at` / `reply` / `image`（本地绝对路径）/ `face`（QQ 内置表情）

- 回复里直接写标记：`[[img:/abs/path.png]]`、`[[face:13]]`、`[[at:3475994805]]`、`[[sticker:1]]`
- 收藏表情走 `send_custom_face`，**不是消息段**，只能单独一条发，塞不进 parts
- 回复里带空行就按空行拆成多条发，间隔 600ms

## 启停

- 配置项 `qqNative.enabled`，或控制台「接入」卡片上那个开关
- **默认 `false`**。关着的时候不 import SDK、不建连接、不看门狗，`/dsh-world/qq` 页面照常能打开
- 改 profile 配置后要重载插件；控制台开关立即生效，状态记在世界目录的 `qq-native.json`

## 配置

都在 profile 的 `cordis.patch.yml` 里 `qqNative` 段：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关 |
| `wsUrl` | — | SnowLuma 的 OneBot WebSocket，形如 `ws://127.0.0.1:3003` |
| `accessToken` | — | OneBot 侧的 access token |
| `allowPrivate` | `[]` | 允许私聊她的 QQ 号；空着等于谁都不理 |
| `allowGroups` | `[]` | 允许接话的群号；空着等于哪个群都不接 |
| `ownerQQ` | `''` | 她自己开口时推给谁。空着退回 `allowPrivate` 的第一个 |
| `autoReply` | `true` | 回不回。关掉是「收到但不理」，连问都不问，不花调用 |
| `groupTrigger` | `mention` | 群里什么时候接话：`mention` 只接被 @、被引用、命中关键词的；`all` 每句都接 |
| `groupKeywords` | `[]` | 群里命中这些词也算在叫她 |
| `bindHomeSession` | `owner` | `owner` 主人的私聊用家会话、群各开一间；`all` 都用家会话；`none` 每段对话各一间 |
| `contextMessages` | — | 每来一条新消息，带多少条同会话的历史给她看 |
| `mutedUntil` | `''` | 静默到什么时候。这段时间照旧进上下文，但一句不回，到点自己醒 |
| `batchQuietMs` | `10000` | 合批窗口：同一个人这几秒内说的话攒成一条问。`0` 是一条一问（测试用） |
| `bridge` | `{port:0}` | 阳台。`port` 为 0 就整块不开 |
| `snowlumaHome` | 自动发现 | SnowLuma 装在哪儿，看门狗和「拉起来」按钮靠它 |
| `supervise` | `true` | 插件自己盯 3003，不通就拉 |

## 身份映射

复用 `shared/identity.ts` 的 `SpeakerIdentity`：

- `channel` = `qq`
- `accountId` = 登录的 QQ 号
- `conversationId` = 私聊是对面 QQ 号，群聊是群号
- `speakerId` = `qq:<QQ 号>`，`mentionIds` 同格式
- 外部发言人保持 `role: user`

身份一律来自平台事件，不从正文、昵称或模型输出推断；群触发用平台给的**真实 @ 元数据**，手打 `@昵称` 不算。

## 会话路由

- 群会话走 `shared/sessions.ts`，挂在房间工作区下、用同一个 `agentPreset`
- 私聊按 `bindHomeSession` 决定落哪儿
- 模块不另建人设，也不另建一份共享记忆

## 验证范围

- 回归测试：`tests/qqNative.test.ts`（收发、白名单、合批、串身份、静默、阳台、群触发）
- 真机验过：私聊收发、群收发、图 / 语音 / 收藏表情、白名单拦截、静默到点自醒、「拉起来」按钮、看门狗拉起
- **未验证**：视频与文件的内容、多账号并发、真实风控触发之后的恢复、远端（非 127.0.0.1）的 OneBot

## 平台风险

- SnowLuma 按自己的 EULA 不允许被自动化部署，装和扫码登录都得人来做，CI 里只跑不需要账号的部分
- 走 OneBot 协议，不是官方接口，QQ 侧改协议就得跟着改
- 同一个 QQ 号被别的客户端抢登录会掉线；重载插件会停这条模块两秒，这两秒的回复进 outbox，进程重启那一下不兜
- 收藏表情的序号是本地缓存，换号或改收藏之后会对不上
- 群里 `groupTrigger: all` 在人多的大群等于拿模型当过滤器，费钱也费延迟，大群建议留在 `mention`