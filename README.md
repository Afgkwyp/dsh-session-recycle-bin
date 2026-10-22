# dsh-session-recycle-bin

**DeepSeek Harness 的「会话回收站」插件** —— 把「删除会话」做成可还原的两步操作：
先移入回收站（只是归档，日志一个字节都不删），需要时一键还原，确认不要了再真正删除磁盘日志。

[中文](#中文) · [English](#english)

![license](https://img.shields.io/github/license/Afgkwyp/dsh-session-recycle-bin)
![dsh](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.2-4b6bfb)
![node](https://img.shields.io/badge/node-%3E%3D22-43853d)
![tests](https://img.shields.io/badge/fixture%20checks-39%2F39-2ea44f)

> 零依赖、零构建、单文件宿主 + 单文件客户端。适用 DeepSeek Harness **0.2.1-rc.2**（Desktop / Web profile）。

---

<a id="中文"></a>

## 中文

### 为什么需要它

DSH 自带的会话菜单只有 **重命名 / 分叉 / 归档**：归档只是把会话从侧栏藏起来，
磁盘上的日志原封不动；而想真正删掉一条会话，官方没有提供入口——`sessionPersistence`
的契约里明确写着「没有删除或保留 API，清理会话属于带外维护」。
于是想清理磁盘的人只能手动去 `%USERPROFILE%\.dsh\sessions\` 里删目录，
既容易误删，也容易把会话列表、投影缓存、工作区注册表搞得半死不活——
而且删完还会留下一串空的 `--C-Users-...--` 项目文件夹。

这个插件补上这一环。

### 功能一览

| 位置 | 新增的东西 |
|---|---|
| 会话头部（标题右侧工具行） | **垃圾桶按钮**：把当前会话移入回收站 |
| 侧栏会话「⋯」菜单 | **删除会话**（红色，order 500，排在官方 pin / 重命名 / 分叉 / 归档 / 会话 ID 之后） |
| 设置 → **会话回收站** | 归档会话集中管理：多选还原、永久删除、清空回收站、删除 30 天前的会话；显示工作区路径、删除时间、日志体积、子代理会话数、「运行中」标记 |

- **软删除**：头部按钮或菜单项 → 确认 → 会话从侧栏消失，进入回收站。
  日志、子代理会话、投影缓存都还在，随时可以还原。
- **回收站**：成员 = 官方归档集合（`workspaceRegistry` 的 archived set）∪ 插件记录，
  所以**通过官方「归档会话」归档的会话也会集中显示**在这里。
- **还原**：一键移出归档集合，会话回到侧栏原来的位置——磁盘文件从未被触碰。
- **永久删除**：真正删除磁盘数据（见下一节），并从归档 / 置顶 / 工作区成员中摘除引用，
  最后广播 `api-session/removed` 让侧栏当帧移除该行。
- **批量清理按"作用范围"分开摆**：工具栏只放**对所选**的动作（还原所选 / 永久删除所选）；
  两个**作用于整个回收站**的动作收进列表下方的「危险操作」区，各带一句适用范围说明——
  「删除 30 天前的会话」和「清空回收站（N 个）」不会再和"删所选"混在同一行。
  按天清理只删「有可靠时间依据且确实够老」的会话：优先用删除记录，没有记录时用日志文件
  的最后修改时间；两者都拿不到的会话一律保留，并在结果里报告数量。
- **确认不会认错对象**：单条删除在该行**行内确认**（问句里就写着会话标题）；
  批量 / 清空 / 按天清理用顶部确认卡，写明条数与目标标题；确认期间其它行的操作被锁住，
  不会出现「点着 A 行、确认却删了 B 行」。
- **不留空文件夹**：删除后若该会话所在的「项目目录」（`sessions/--C-Users-...--/`）
  已经空了，会一并删掉；插件激活时也会顺手清理历史遗留的空项目目录
  （只删真正为空的，`sessions` 根本身永不删除）。

回收站的附加记录（删除时间 / 标题 / 工作区路径）写在
`$DSH_HOME/session-recycle-bin.json`；它只是展示用的旁路记录，删掉也不影响归档状态。

### 永久删除会删除什么

| 位置 | 内容 |
|---|---|
| `$DSH_HOME/sessions/<项目>/<会话 id>/` | 整个会话目录（`session.jsonl.zstd` 日志与写租约） |
| 同一项目目录下的子代理会话 | 该会话名下每一层子代理 / 团队会话的日志目录 |
| `$DSH_HOME/sessions/<项目>/` | 若删除后已空，连项目目录一起移除（1.0.1+） |
| `session_projcache` 存储域 | 该会话及其子代理会话的投影检查点行 |
| `storages/workspace.json` | 归档 / 置顶 / 工作区成员里的引用 |
| 页面 | 广播 `api-session/removed`，侧栏该行当帧消失 |

**不删除**：附件对象（内容寻址、跨会话共享）、会话工作区里的文件（工作区可能被多个会话共用）、
分叉（fork）会话——它是独立对话，不会随源会话消失。

### 安全边界

| 情况 | 行为 |
|---|---|
| 会话仍在运行（回合 / 子代理 / 后台任务 / 定时提醒） | 归档时拒绝，并提供「停止并删除」；走官方 `workspace/session-stop` 通道 |
| 会话仍被当前进程持有（界面打开着） | 永久删除拒绝，提示先切换会话（避免活着的写句柄把日志写回来） |
| 存储后端没有提供路径 | 按文档化的 JSONL 布局 `<sessions>/<项目>/<会话 id>/session*.jsonl*` 扫描定位 |
| 目录名与会话 id 不匹配 | 直接跳过并报告，**绝不猜路径** |
| 待清理的项目目录不为空 | 保持原样，只删空目录 |
| 子代理会话 | 随父会话一起删除 |
| 「删除 30 天前的会话」遇到时间未知的条目 | 一律保留；优先用删除记录，其次用日志最后修改时间，两者都没有就不删（结果里报告数量） |

永久删除的执行顺序是有意编排的，不能交换：

```
释放驻留会话 → 停止仍在跑的工作并等待清零 → 持久化 flush 屏障
→ 删除日志目录/子代理目录/投影缓存 → 清理注册表引用 → 广播 api-session/removed
```

先释放再停止，否则被停止的会话会唤醒 agent 重新干活，那份新工作会活过删除变成孤儿；
先释放再删文件，否则写句柄会在下一次 flush 把刚删掉的日志写回来。

### 安装

**方式 A：图形界面（推荐）**

1. 克隆本仓库到任意目录：

   ```powershell
   git clone https://github.com/Afgkwyp/dsh-session-recycle-bin.git
   ```

2. 侧栏 → **插件** → **添加插件** → 填**本地目录的绝对路径**，
   例如 `C:\Users\<你>\Documents\dsh-plugins\dsh-session-recycle-bin`。
3. 宿主半即时生效；浏览器半刷新页面一次生效。

**方式 B：CLI**

```powershell
dsh plugin --profile <profile-name> add "C:/path/to/dsh-session-recycle-bin"
```

**方式 C：手工写行**（等价于插件管理器做的事）

```yaml
# <DSH_HOME>/profiles/<profile>/cordis.patch.yml
- insert:
    - id: session-recycle-bin
      name: 'dsh-session-recycle-bin'
```

并在同名 profile 的 `package.json` 依赖里加入
`"dsh-session-recycle-bin": "file:C:/path/to/dsh-session-recycle-bin"`。

**更新**：`git pull` 后，在插件页把本插件关掉再打开（重新装载宿主模块），再刷新页面；
替换已安装包时重启应用最稳妥。

**卸载**：插件页移除本插件即可；如需手工清理，删除 `cordis.patch.yml` 里的
`session-recycle-bin` 行、profile 依赖，以及 `$DSH_HOME/session-recycle-bin.json`
（回收站旁路记录，删掉不影响会话本身）。

### 验证安装是否生效

- 会话头部出现垃圾桶图标；侧栏「⋯」菜单出现「删除会话」；
- 设置 → 会话回收站能列出已归档会话（底部显示数据目录，悬停可见日志定位方式）；
- 宿主半激活后会在 `$DSH_HOME/plugin-session-recycle-bin.json` 写一条激活记录
  （构建号、seam、时间戳），排查「改了代码没生效」时先看它。

### 配置（可选）

写在插件行的 `config` 下，全部可省略：

```yaml
- id: session-recycle-bin
  name: 'dsh-session-recycle-bin'
  config:
    home: 'C:/Users/me/.dsh'   # DSH 数据根目录，默认取 $DSH_HOME 或 ~/.dsh
    stopWaitMs: 8000           # 停止后等待工作清零的上限（毫秒）
```

### 界面与实现

| 文件 | 职责 |
|---|---|
| `index.js` | 宿主半：`/api/session-recycle-bin.{health,list,archive,restore,purge}` 五条精确路由，注册在 Connection 的 `/api` 鉴权围栏内（没有该 seam 时退回 `webServer`） |
| `client.js` | 浏览器半：头部按钮、菜单行、归档确认浮层、设置页；只用 `--dsw-alias-*` 主题变量，按钮/复选框按官方 `ui-primitives` 复刻 |
| `locale/*.json` | 插件管理器里显示的标题与说明 |
| `icon.svg` | 插件图标（原创） |
| `test/host-test.mjs` | 宿主半 fixture 自测（假 Cordis 服务 + 临时 `$DSH_HOME`） |

浏览器半调用宿主半的方式与官方插件一致：同源 `fetch` + 自定义围栏请求头
`x-dsh-session-recycle-bin: 1`，并校验 Origin 只允许回环地址。

### 自测

```powershell
node test/host-test.mjs   # 或 npm test
```

纯 Node、无依赖、不需要启动 Harness：用假服务跑真实 `index.js`，覆盖路由注册、
回收站列表、归档、还原、永久删除（含子代理目录、投影缓存、工作区摘除、
`api-session/removed` 广播）、空项目目录清理、按天清理的时间判定
（有记录 / 只有日志 mtime / 时间未知三种情况），以及后端提供/不提供 `locate()` 两条定位路径。

### 常见问题

**删除了会话，为什么还留着一个空文件夹？**
1.0.1 之前只删会话目录，不处理变空的「项目目录」；1.0.1 起删除后会自动收掉空项目目录，
插件激活时也会清理历史遗留的空目录。升级后若仍看到，重载一次插件即可。

**「删除 30 天前的会话」会不会误删刚归档的会话？**
不会。它只删有可靠时间依据（删除记录，或日志文件最后修改时间）且确实早于 30 天的会话；
如果某个会话既没有删除记录、日志也读不到时间，会被保留并在结果里提示数量。

**点了删除，侧栏没马上消失？**
永久删除成功会广播 `api-session/removed`，正常当帧移除；若页面版本较旧或列表未刷新，
切一下会话或刷新页面即可。

**能删正在运行的会话吗？**
可以，但需要先停止它的工作——确认框会提供「停止并删除」，走官方停止通道
（注意它会丢弃该会话排队中的输入，与官方归档一致）。

**会删掉附件或工作区里的文件吗？**
不会。附件是跨会话共享的内容寻址存储；工作区可能被多个会话共用，两者都不动。

**支持多个 profile 吗？**
支持。装到哪个 profile，就只在那个 profile 生效；插件按 `$DSH_HOME` 解析日志位置。

### 兼容性

- 实测于 DeepSeek Harness **0.2.1-rc.2**（Desktop，web profile，Windows）；
- 需要组合中存在 `connection`、`sessionPersistence`、`workspaceRegistry` 三个服务；
- 需要客户端存在 `sidebar.workspaces.session.menu.item`、
  `conversation.session.header.utilities`、`shell.overlay`、`settings.section` 四个 slot；
- 不依赖任何第三方 npm 包，也不 import 任何 Harness 客户端包。

### 更新日志

- **1.0.3** — 按作用范围拆分清理动作：工具栏只保留「还原所选 / 永久删除所选」，
  「删除 30 天前的会话」「清空回收站」移入列表下方的「危险操作」区，并各自标注适用范围。
- **1.0.2** — 删除确认写明目标（单条改为行内确认，批量卡写明条数/标题，确认期间锁住其它行）；
  「删除 30 天前的会话」修正时间判定，时间未知的条目不再被误删；工具栏分组避免「清空回收站」掉行；
  设置页去掉 `locate()` 等实现术语、合并数据目录展示；子代理数量改为标签显示；禁用态按钮去红。
- **1.0.1** — 永久删除后会清理变空的会话项目目录；插件激活时清理历史遗留空目录；仓库加入 fixture 自测。
- **1.0.0** — 首个公开版本：头部垃圾桶、侧栏删除会话、回收站设置页（还原 / 永久删除 / 批量清理）。

### 许可

[MIT](LICENSE)

---

<a id="english"></a>

## English

**A "recycle bin" for DeepSeek Harness sessions.** Deleting a session becomes a two-step,
undoable operation: it first moves into the recycle bin (a plain archive — not one byte of
the log is removed), can be restored at any time, and only a second, explicit action erases
its data from disk.

### What it adds

| Surface | Contribution |
|---|---|
| Session header (right-hand utilities) | A **trash button** that moves the current session into the recycle bin |
| Sidebar session "…" menu | A **Delete session** row (danger, order 500, after the shipped pin / rename / fork / archive / session-id rows) |
| Settings → **Session recycle bin** | Central management of archived sessions: multi-select restore, permanent delete, empty the bin, delete sessions older than 30 days; each row shows the workspace path, deletion time, log size, subagent count and a "running" tag |

"Delete" means *archive*, so it is always undoable. Only "Delete permanently" touches the
disk, and it asks first.

- **Batch cleanup is grouped by scope**: the toolbar only holds actions that apply to the
  selection (restore selected / delete selected); the two actions that apply to the whole bin
  live in a **Danger zone** below the list, each with a one-line explanation — so
  "delete sessions older than 30 days" and "empty the recycle bin (N)" can no longer be
  confused with "delete the selected ones". Age-based cleanup only removes sessions with a
  trustworthy date — the recorded deletion time, or the log file's last-modified time as a
  fallback; sessions with neither are kept and reported.
- **The confirmation always names its target**: deleting one session opens an **inline
  confirmation inside that row** (the question includes the session title); batch, empty and
  age-based actions use a top card naming the count and titles. While a confirmation is open,
  the other rows' actions are locked, so a click can never silently retarget the deletion.

### What permanent deletion removes

- the whole session directory `<DSH_HOME>/sessions/<project>/<session-id>/`
  (the `session*.jsonl.zstd` log and its write lease);
- every **subagent session** stored beneath it (each subagent session is a separate stored
  session whose log lives next to its parent's and would become unreachable);
- the now-empty **project directory** `<DSH_HOME>/sessions/<project>/` (1.0.1+); leftovers
  from earlier versions are swept on activation — only genuinely empty directories are
  removed, never the `sessions` root;
- the session's `session_projcache` checkpoint row;
- its archive / pin / workspace membership references;
- and it broadcasts `api-session/removed`, so the sidebar row disappears without a reload.

Never removed: content-addressed attachment objects (shared across sessions), files in the
session's workspace (a workspace may be shared by several sessions), and forked sessions
(independent conversations).

### Safety model

- Running work (turn / subagents / background jobs / reminders) refuses the archive and
  offers **Stop and delete**, using the official `workspace/session-stop` admission.
- A session still held by the process (open in the UI) refuses permanent deletion, so a live
  write handle can never recreate a removed log.
- The log location comes from the persistence backend's `locate()` when available, otherwise
  the documented JSONL layout is scanned; a directory must be named exactly like the session
  id or the plugin refuses instead of guessing.
- A project directory is removed only when it is empty.
- Age-based cleanup never guesses: a session with no recorded deletion time and no readable
  log timestamp is kept (the response reports how many were kept).
- Order is deliberate and must not be swapped: **release → stop → flush barrier → remove
  files → clean registry → emit `api-session/removed`**.

### Install / update / uninstall

```powershell
git clone https://github.com/Afgkwyp/dsh-session-recycle-bin.git
```

Then either add it from the GUI (**Plugins → Add plugin → absolute path of the cloned
directory**), or:

```powershell
dsh plugin --profile <profile-name> add "C:/path/to/dsh-session-recycle-bin"
```

The Host half activates immediately; refresh the page once for the Client half. To update,
`git pull`, toggle the plugin off and on (fresh Host module generation), then refresh. To
uninstall, remove it from the Plugins page.

### Tests

```powershell
node test/host-test.mjs
```

Runs the real `index.js` against fake Cordis services and a disposable `$DSH_HOME` — no
Harness and no dependencies required. Covers route registration, recycle-bin listing,
archive, restore, permanent deletion (session + subagent directories, projection cache,
workspace detach, `api-session/removed`), empty-project-directory cleanup, the three
age-cleanup cases (recorded time / log mtime / unknown), and both log lookup paths
(`locate()` present / absent).

### Compatibility

Tested against DeepSeek Harness **0.2.1-rc.2** (desktop, web profile, Windows). Requires the
`connection`, `sessionPersistence` and `workspaceRegistry` Host services and the
`sidebar.workspaces.session.menu.item`, `conversation.session.header.utilities`,
`shell.overlay` and `settings.section` Client slots. No dependencies, no build step, and no
import of any Harness Client package.

### Changelog

- **1.0.3** — clean-up actions are split by scope: the toolbar keeps only the
  selection-scoped actions (restore selected / delete selected), while "delete sessions older
  than 30 days" and "empty the recycle bin" move into a **Danger zone** below the list, each
  with its own explanation.
- **1.0.2** — confirmations now name their target (single deletes happen inline in the row;
  batch cards name counts and titles; other rows are locked while a confirmation is open);
  age-based cleanup no longer deletes sessions with unknown timing; toolbar groups keep
  "empty bin" from wrapping onto its own line; the settings page drops implementation jargon
  (`locate()`) and merges the data-directory line; subagent counts render as a tag; disabled
  danger buttons lose their red tint.
- **1.0.1** — prune the project directory once its last session is deleted; sweep leftover
  empty project directories on activation; add the fixture test suite.
- **1.0.0** — first public release: header trash button, sidebar delete row, recycle-bin
  Settings page (restore / permanent delete / batch cleanup).

### License

[MIT](LICENSE)
