# dsh-session-recycle-bin

**DeepSeek Harness 的「会话回收站」插件** —— 把「删除会话」做成可还原的两步操作：
先移入回收站（只是归档，日志一个字节都不删），需要时一键还原，确认不要了再真正删除磁盘日志。

[中文](#中文) · [English](#english)

> 适用 DeepSeek Harness **0.2.1-rc.2**（Desktop / Web profile）。零依赖、零构建。

---

<a id="中文"></a>

## 中文

### 为什么需要它

DSH 自带的会话菜单只有 **重命名 / 分叉 / 归档**：归档只是把会话从侧栏藏起来，
磁盘上的日志原封不动；而想真正删掉一条会话，官方没有提供入口——`sessionPersistence`
的契约里明确写着「没有删除或保留 API，清理会话属于带外维护」。
于是想清理磁盘的人只能手动去 `%USERPROFILE%\.dsh\sessions\` 里删目录，
既容易误删，也容易把会话列表、投影缓存、工作区注册表搞得半死不活。

这个插件补上这一环：

| 位置 | 新增的东西 |
|---|---|
| 会话头部（标题右侧工具行） | **垃圾桶按钮**：把当前会话移入回收站 |
| 侧栏会话「⋯」菜单 | **删除会话**（红色，order 500，排在官方 pin / 重命名 / 分叉 / 归档 / 会话 ID 之后） |
| 设置 → **会话回收站** | 归档会话集中管理：多选还原、永久删除、清空回收站、清理 30 天前；显示工作区路径、删除时间、日志体积、子代理会话数、「运行中」标记 |

「删除」= 归档（可还原）；「永久删除」才真正动磁盘，且有二次确认。

### 功能一览

- **软删除**：头部按钮或菜单项 → 确认 → 会话从侧栏消失，进入回收站。
  日志、子代理会话、投影缓存都还在，随时可以还原。
- **回收站**：成员 = 官方归档集合（`workspaceRegistry` 的 archived set）∪ 插件记录，
  所以**通过官方「归档会话」归档的会话也会集中显示**在这里。
- **还原**：一键移出归档集合，会话回到侧栏原来的位置——磁盘文件从未被触碰。
- **永久删除**：真正删除 `<DSH_HOME>/sessions/<项目>/<会话 id>/` 整个目录、
  该会话名下每一层**子代理会话**目录、`session_projcache` 投影缓存行，
  并从归档 / 置顶 / 工作区成员中摘除引用，最后广播 `api-session/removed` 让侧栏当帧移除该行。
- **批量清理**：多选后批量还原 / 批量永久删除；「清空回收站」；「清理 30 天前」
  （按插件记录的删除时间过滤，没有记录的按官方归档元素处理）。

回收站的附加记录（删除时间 / 标题 / 工作区路径）写在
`$DSH_HOME/session-recycle-bin.json`；它只是展示用的旁路记录，删掉也不影响归档状态。

### 安全边界

| 情况 | 行为 |
|---|---|
| 会话仍在运行（回合 / 子代理 / 后台任务 / 定时提醒） | 归档时拒绝，并提供「停止并删除」；走官方 `workspace/session-stop` 通道 |
| 会话仍被当前进程持有（界面打开着） | 永久删除拒绝，提示先切换会话（避免活着的写句柄把日志写回来） |
| 存储后端没有提供路径 | 按文档化的 JSONL 布局 `<sessions>/<项目>/<会话 id>/session*.jsonl*` 扫描定位 |
| 目录名与会话 id 不匹配 | 直接跳过并报告，**绝不猜路径** |
| 子代理会话 | 随父会话一起删除；分叉（fork）会话是独立对话，不连带 |
| 附件对象 | 内容寻址、跨会话共享，**不删除** |
| 会话工作区里的文件 | **不删除**（工作区可能被多个会话共用） |

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

2. 侧栏 → **插件** → **添加插件** → 填**本地目录的绝对路径**，例如
   `C:\Users\<你>\Documents\dsh-plugins\dsh-session-recycle-bin`。
3. 宿主半即时生效；浏览器半刷新页面一次生效（替换已安装的包则需重启以加载新的模块代次）。

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

### 验证安装是否生效

- 会话头部出现垃圾桶图标；侧栏「⋯」菜单出现「删除会话」；
- 设置 → 会话回收站能列出已归档会话（底部显示 `$DSH_HOME` 与日志定位方式）；
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

### 实现说明

| 文件 | 职责 |
|---|---|
| `index.js` | 宿主半：`/api/session-recycle-bin.{health,list,archive,restore,purge}` 五条精确路由，注册在 Connection 的 `/api` 鉴权围栏内（没有该 seam 时退回 `webServer`） |
| `client.js` | 浏览器半：头部按钮、菜单行、归档确认浮层、设置页（全部只用 `--dsw-alias-*` 主题变量，按钮按官方 `ui-primitives` 的 Button 原子复刻） |
| `locale/*.json` | 插件管理器里显示的标题与说明 |
| `icon.svg` | 插件图标（原创） |

浏览器半调用宿主半的方式与官方插件一致：同源 `fetch` + 自定义围栏请求头
`x-dsh-session-recycle-bin: 1`，并校验 Origin 只允许回环地址。

### 兼容性

- 实测于 DeepSeek Harness **0.2.1-rc.2**（Desktop，web profile，Windows）；
- 需要组合中存在 `connection`、`sessionPersistence`、`workspaceRegistry` 三个服务；
- 需要客户端存在 `sidebar.workspaces.session.menu.item`、
  `conversation.session.header.utilities`、`shell.overlay`、`settings.section` 四个 slot；
- 不依赖任何第三方 npm 包，也不 import 任何 Harness 客户端包。

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

### What permanent deletion removes

- the whole session directory `<DSH_HOME>/sessions/<project>/<session-id>/`
  (the `session*.jsonl.zstd` log and its write lease);
- every **subagent session** stored beneath it (each subagent session is a separate stored
  session whose log lives next to its parent's and would become unreachable);
- the session's `session_projcache` checkpoint row;
- its archive / pin / workspace membership references;
- and it broadcasts `api-session/removed`, so the sidebar row disappears without a reload.

Never removed: content-addressed attachment objects (shared across sessions) and files in
the session's workspace (a workspace may be shared by several sessions). Forked sessions are
independent conversations and are not cascaded.

### Safety model

- Running work (turn / subagents / background jobs / reminders) refuses the archive and
  offers **Stop and delete**, using the official `workspace/session-stop` admission.
- A session still held by the process (open in the UI) refuses permanent deletion, so a live
  write handle can never recreate a removed log.
- The log location comes from the persistence backend's `locate()` when available, otherwise
  the documented JSONL layout is scanned; a directory must be named exactly like the session
  id or the plugin refuses instead of guessing.
- Order is deliberate and must not be swapped: **release → stop → flush barrier → remove
  files → clean registry → emit `api-session/removed`**.

### Install

```powershell
git clone https://github.com/Afgkwyp/dsh-session-recycle-bin.git
```

Then either add it from the GUI (**Plugins → Add plugin → absolute path of the cloned
directory**), or:

```powershell
dsh plugin --profile <profile-name> add "C:/path/to/dsh-session-recycle-bin"
```

The Host half activates immediately; refresh the page once for the Client half (restart to
load a fresh module generation when replacing an already-installed package).

### Compatibility

Tested against DeepSeek Harness **0.2.1-rc.2** (desktop, web profile, Windows). Requires the
`connection`, `sessionPersistence` and `workspaceRegistry` Host services and the
`sidebar.workspaces.session.menu.item`, `conversation.session.header.utilities`,
`shell.overlay` and `settings.section` Client slots. No dependencies, no build step, and no
import of any Harness Client package.

### License

[MIT](LICENSE)
