# QQ 控制台门

这个目录只管「看」和「拨」，不碰收发。真正的收发在 [`../qq-native/`](../qq-native/README.md)。

## 文件

| 文件 | 职责 |
| --- | --- |
| `panel.ts` | 控制台那扇门：面板地址、SnowLuma 控制台入口、面板口令 |
| `route.ts` | `/dsh-world/qq/*` 的读写路由 |
| `snowluma-start.ts` | 「拉起来」按钮背后那一步 |
| `supervisor.ts` | 看门狗：盯着 3003，不通就拉 |

## HTTP

前缀是 `/dsh-world/qq`。宿主按最长前缀匹配，所以它不会被控制台的 `/dsh-world` 吃掉。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-world/qq/native` | 通道状态：`connected` / `url` / `allowPrivate` / `allowGroups` / `autoReply` / `groupTrigger` / `conversations` / `answering` / `lastEventAt` / `sent` / `failed` / `blocked` / `muted` / `mutedUntil` / `bridge` / `supervisor` |
| GET | `/dsh-world/qq/console` | SnowLuma 控制台地址（已经把面板口令换成一次性的 session token） |
| POST | `/dsh-world/qq/native` | 改开关，见下 |
| POST | `/dsh-world/qq/panel-password` | 记住 SnowLuma 面板口令 |

`POST /native` 收这些字段，可以只给一个：

```json
{ "autoReply": true }
{ "mutedUntil": "2026-10-28T03:00:00+08:00" }
{ "mutedUntil": null }
{ "startSnowluma": true }
{ "allowPrivate": ["3475994805"] }
{ "allowGroups": ["681528723"] }
{ "bridge": { "port": 3210 } }
```

**写操作必须带 `x-dsh-world` 头。** 跨站页面加不了这个头（加了会触发预检），这是唯一的防线，别的鉴权没有。只认 POST，别的动词回 405。

`allowPrivate` / `allowGroups` 接受字符串或数组，元素必须是形如 QQ 号的字符串，别的直接回 400 —— 名单是白名单，收错一个就等于放人进来。

## 面板口令

SnowLuma 的控制台只监听回环，但它 `X-Frame-Options: DENY`、session token 每次登录都换、重启就死，只能拿口令去 `POST /api/login` 换。所以那口令只输一次，存在 `<world>/panel.json`（权限 600），之后由插件替他去换 token。页面收 `?token=`，拿到就从地址栏抹掉。

## 「拉起来」

`snowluma-start.ts` 先看有没有可用的启动方式（Windows 上优先计划任务），没有就直接 `spawn` SnowLuma 的 `launcher.bat`。只认这个动作，不做别的自动化 —— SnowLuma 的 EULA 不允许脚本部署。

## 看门狗

以前这活是 `~/.dsh/tools/snowluma-watchdog.ps1` 加一个 Windows 计划任务干的，跟插件各活各的：插件没装任务还在跑，别人装插件又要多建一个计划任务。做进插件之后只剩一条规矩 —— **插件在，就盯着**。

- 探到 3003 不通，就看一眼 `snowlumaHome` 在不在，在就拉
- 拉不起来把原因记在面板上，退避到 30 秒一轮，不轰炸
- `supervise: false` 可以关掉

## 验证范围

- 真机验过：GET/POST 两个端点、静默到点自醒、名单增删、「拉起来」按钮、看门狗在 3003 断掉后自动拉起
- **未验证**：非 Windows 上的「拉起来」（只有 `spawn` 那条退路）、SnowLuma 改版之后控制台入口的兼容性

## 平台风险

- `x-dsh-world` 头是防跨站的最低保障，不是身份认证。这条服务只该跑在本机回环上，别往外暴露
- 面板口令是明文存在 `panel.json` 里的（权限 600），拿到那个文件就等于拿到 SnowLuma 面板
- 换 SnowLuma 版本之后，`/api/login` 和 token 的用法可能变，`console` 那扇门会先坏