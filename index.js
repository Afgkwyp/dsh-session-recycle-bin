// @ts-check
/**
 * session-recycle-bin — Host half.
 *
 * 会话回收站：把「删除会话」做成可还原的两步操作。
 *
 *  - 归档（软删除）：走官方 `workspaceRegistry.archiveSession()`，会话从侧栏消失，
 *    但日志仍完整留在磁盘上；插件在 `$DSH_HOME/session-recycle-bin.json` 里记下
 *    删除时间与标题，作为回收站的排序与展示依据。
 *  - 还原：`workspaceRegistry.unarchiveSession()`，会话回到侧栏，磁盘文件未被触碰。
 *  - 永久删除（真正删磁盘日志）：先释放进程内的写句柄、停掉仍在跑的工作、跑一次
 *    持久化屏障，再按持久化后端 `locate()` 给出的路径删除
 *    `<DSH_HOME>/sessions/<项目>/<会话id>/`，并清理该会话（含子代理会话）的
 *    `session_projcache` 记录、工作区引用，最后广播 `api-session/removed` 让侧栏
 *    当帧移除该行。
 *
 * 回收站成员 = 官方归档集合（registry 或 `storages/workspace.json` 的
 * `global.archivedSessionIds`）∪ 本插件记录过的会话，因此通过官方「归档会话」
 * 菜单项归档的会话同样集中可见。
 *
 * 路由注册优先走 `connection.fetch.register`（`/api` 鉴权围栏内），组合里没有
 * 该 seam 时退回 `webServer.register`（改用不带 `/api` 前缀的路径，`/api` 属于
 * RPC 网关）。浏览器半会自动探测可用的前缀。
 */
import { mkdir, readFile, readdir, rename, rm, rmdir, stat as fsStat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

/** 会话 id 合法形态：`session-<uuid>` 或裸 uuid（防御路径穿越）。 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/
/** 同源围栏请求头（跨源 fetch 需要预检，而本路由从不回应 OPTIONS）。 */
const GUARD_HEADER = 'x-dsh-session-recycle-bin'
/** 请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024
/** 停止运行中的工作后等待清零的上限。 */
const STOP_WAIT_MS = 8000
/** 读取标题时最多探测多少个冷会话（避免打开很多会话）。 */
const TITLE_PROBE_LIMIT = 30
/** 宿主半构建标记：写进激活记录，用来确认运行的是哪一版代码。 */
const BUILD = 'recycle-bin@4'

/** 本宿主插件需要的服务。 */
export const inject = ['connection', 'sessionPersistence', 'workspaceRegistry']

/**
 * 路由表：名字 → 处理函数。真实路径前缀在 apply 时决定。
 * @type {ReadonlyArray<{ name: string, method: 'GET' | 'POST', run: (runtime: Runtime, body: any) => Promise<RouteResult> }>}
 */
const ROUTES = [
  { name: 'health', method: 'GET', run: healthRoute },
  { name: 'list', method: 'GET', run: listRoute },
  { name: 'archive', method: 'POST', run: archiveRoute },
  { name: 'restore', method: 'POST', run: restoreRoute },
  { name: 'purge', method: 'POST', run: purgeRoute },
]

/**
 * @typedef {object} Runtime
 * @property {any} ctx 宿主 Cordis 上下文
 * @property {string} home DSH 数据根目录
 * @property {RecycleBin} bin 回收站附加记录
 * @property {number} stopWaitMs 停止后等待上限
 * @property {'api' | 'root'} base 实际使用的路径前缀
 */

/**
 * @typedef {object} RouteResult
 * @property {number} status HTTP 状态码
 * @property {any} body JSON 响应体
 */

/* ------------------------------------------------------------------ 插件入口 */

/**
 * 挂载宿主半：注册精确路由，生命周期由本插件的 fiber 管理。
 * @param {any} ctx 宿主上下文
 * @param {any} config 插件行 config（可选）
 */
export function apply(ctx, config) {
  const home = resolveHome(config)
  const bin = new RecycleBin(join(home, 'session-recycle-bin.json'))
  /** @type {Runtime} */
  const runtime = {
    ctx,
    home,
    bin,
    stopWaitMs: Number.isFinite(config?.stopWaitMs) ? Math.max(500, config.stopWaitMs) : STOP_WAIT_MS,
    base: 'api',
  }

  const seam = registerRoutes(ctx, runtime)
  ctx.logger?.info?.(`session-recycle-bin: host half active (seam ${seam}, home ${home})`)
  void recordBoot(runtime, seam)
  /* 激活时顺手清掉历史遗留的空「项目目录」（只有真正空的才会被删）。 */
  void pruneEmptyProjectDirs(runtime)
}

/**
 * 写一份激活记录：宿主模块的一次性诊断证据（重新装载后会刷新）。
 * 排查「改完代码没生效」时先看这个文件的时间戳。
 * @param {Runtime} runtime 运行时句柄
 * @param {string} seam 使用的路由 seam
 * @returns {Promise<void>}
 */
async function recordBoot(runtime, seam) {
  try {
    await mkdir(runtime.home, { recursive: true })
    await writeFile(join(runtime.home, 'plugin-session-recycle-bin.json'), `${JSON.stringify({
      build: BUILD,
      activatedAt: new Date().toISOString(),
      seam,
      base: runtime.base,
      home: runtime.home,
      pid: process.pid,
    }, null, 2)}\n`, 'utf8')
  } catch {
    /* 诊断记录写失败不影响插件本身 */
  }
}

/**
 * 解析 DSH 数据根目录。
 * @param {any} config 插件行 config
 * @returns {string}
 */
function resolveHome(config) {
  if (typeof config?.home === 'string' && config.home.length > 0) return config.home
  const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME : ''
  return env.length > 0 ? env : join(homedir(), '.dsh')
}

/**
 * 会话目录删除后，如果它所在的「项目目录」（`<sessions>/<项目>/`）已经空了，就一并删掉，
 * 避免磁盘上留一串空的 `--C-Users-...--` 文件夹。只处理 sessions 根的直接子目录，
 * 且只在目录确实为空时删除。
 * @param {string} home DSH 数据根目录
 * @param {string} sessionDirectory 刚被删除的会话目录
 * @param {string[]} [removed] 已删除项记录数组（用于报告）
 * @returns {Promise<void>}
 */
async function pruneEmptyProjectDir(home, sessionDirectory, removed) {
  const sessionsRoot = join(home, 'sessions')
  const project = dirname(sessionDirectory)
  /* 只认 `<sessions>/<项目>` 这一层，别的地方一律不动。 */
  if (dirname(project) !== sessionsRoot) return
  try {
    const entries = await readdir(project)
    if (entries.length > 0) return
    await rmdir(project)
    removed?.push(`session-project:${basename(project)}`)
  } catch {
    /* 目录不空、已被删除或不可读时保持原样 */
  }
}

/**
 * 清理历史遗留的空项目目录（例如插件装好之前手动删会话留下的空文件夹）。
 * 只删除 `<sessions>` 下真正为空的一级目录，sessions 根本身永不删除。
 * @param {Runtime} runtime 运行时句柄
 * @returns {Promise<void>}
 */
async function pruneEmptyProjectDirs(runtime) {
  const sessionsRoot = join(runtime.home, 'sessions')
  let projects
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return
  }
  let pruned = 0
  for (const entry of projects) {
    if (!entry.isDirectory()) continue
    const directory = join(sessionsRoot, entry.name)
    try {
      if ((await readdir(directory)).length > 0) continue
      await rmdir(directory)
      pruned += 1
    } catch {
      /* 竞态、权限或目录不空都保持原样 */
    }
  }
  if (pruned > 0) {
    runtime.ctx.logger?.info?.(`session-recycle-bin: pruned ${pruned} empty session project director${pruned === 1 ? 'y' : 'ies'}`)
  }
}

/**
 * 注册全部路由；优先 Connection 的 fetch seam，退回 WebServer。
 * @param {any} ctx 宿主上下文
 * @param {Runtime} runtime 运行时句柄
 * @returns {string} 使用的 seam
 */
function registerRoutes(ctx, runtime) {
  const connectionFetch = ctx.connection?.fetch
  if (connectionFetch !== undefined && typeof connectionFetch.register === 'function') {
    runtime.base = 'api'
    const staged = []
    try {
      for (const route of ROUTES) {
        staged.push(connectionFetch.register({
          path: `/api/session-recycle-bin.${route.name}`,
          methods: [route.method],
          requestBody: 'buffered',
          fetch: (request) => handleWebRoute(route, request, runtime),
        }))
      }
      ctx.effect(() => () => disposeAll(staged), 'session-recycle-bin: routes')
      return 'connection.fetch'
    } catch (error) {
      disposeAll(staged)
      ctx.logger?.warn?.(`session-recycle-bin: connection.fetch registration failed, falling back: ${String(error)}`)
    }
  }

  const webServer = ctx.get('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    runtime.base = 'root'
    const staged = []
    try {
      for (const route of ROUTES) {
        staged.push(webServer.register({
          kind: 'exact',
          path: `/session-recycle-bin.${route.name}`,
          handler: (request, response) => handleServerRoute(route, request, response, runtime),
        }))
      }
      ctx.effect(() => () => disposeAll(staged), 'session-recycle-bin: routes')
      return 'webServer'
    } catch (error) {
      disposeAll(staged)
      throw error
    }
  }

  throw new Error('session-recycle-bin: 组合里既没有 connection.fetch 也没有 webServer，无法注册路由')
}

/** 关闭一批注册项，单个失败不影响其余。 */
function disposeAll(disposers) {
  for (const dispose of disposers) {
    try {
      dispose?.()
    } catch {
      /* 卸载失败已无补救手段，忽略即可 */
    }
  }
  disposers.length = 0
}

/* --------------------------------------------------------------------- 路由 */

/** fetch 风格处理（Web Request → Response）。 */
async function handleWebRoute(route, request, runtime) {
  const denied = fenceFetch(request)
  if (denied !== undefined) return denied
  if (request.method.toUpperCase() !== route.method) {
    return webJson(405, { ok: false, code: 'method-not-allowed' })
  }
  let body
  if (route.method === 'POST') {
    try {
      body = await request.json()
    } catch {
      return webJson(400, { ok: false, code: 'invalid-body', message: '请求体不是合法 JSON。' })
    }
  }
  try {
    const result = await route.run(runtime, body)
    return webJson(result.status, result.body)
  } catch (error) {
    runtime.ctx.logger?.warn?.(`session-recycle-bin: ${route.name} failed: ${String(error)}`)
    return webJson(500, { ok: false, code: 'internal', message: messageOf(error) })
  }
}

/**
 * webServer 风格处理；兼容 `(req, res)` 与 `(request)` 两种调用约定。
 * @param {{ name: string, method: string, run: Function }} route 路由
 * @param {any} request Node IncomingMessage 或 Web Request
 * @param {any} response Node ServerResponse 或 undefined
 * @param {Runtime} runtime 运行时句柄
 */
async function handleServerRoute(route, request, response, runtime) {
  if (response === undefined || response === null || typeof response.writeHead !== 'function') {
    return handleWebRoute(route, request, runtime)
  }

  /** @param {number} status 状态码 @param {any} body 响应体 */
  const send = (status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(body))
  }

  if (request.headers[GUARD_HEADER] !== '1') {
    send(403, { ok: false, code: 'forbidden' })
    return
  }
  if (!loopbackOrigin(request.headers.origin)) {
    send(403, { ok: false, code: 'forbidden' })
    return
  }
  const method = String(request.method ?? 'GET').toUpperCase()
  if (method !== route.method) {
    send(405, { ok: false, code: 'method-not-allowed' })
    return
  }
  let body
  if (route.method === 'POST') {
    try {
      body = await readNodeBody(request)
    } catch {
      send(400, { ok: false, code: 'invalid-body', message: '请求体不是合法 JSON。' })
      return
    }
  }
  try {
    const result = await route.run(runtime, body)
    send(result.status, result.body)
  } catch (error) {
    runtime.ctx.logger?.warn?.(`session-recycle-bin: ${route.name} failed: ${String(error)}`)
    send(500, { ok: false, code: 'internal', message: messageOf(error) })
  }
}

/** Web Request 侧的围栏校验。 */
function fenceFetch(request) {
  if (request.headers.get(GUARD_HEADER) !== '1') return webJson(403, { ok: false, code: 'forbidden' })
  if (!loopbackOrigin(request.headers.get('origin') ?? undefined)) return webJson(403, { ok: false, code: 'forbidden' })
  return undefined
}

/** Origin 缺失（同源导航）或为回环地址时放行。 */
function loopbackOrigin(origin) {
  if (origin === undefined || origin === null || origin === '') return true
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(origin))
}

/** 读取 Node 请求体（有上限）。 */
function readNodeBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    /** @type {Buffer[]} */
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function webJson(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

/* --------------------------------------------------------------------- 处理器 */

/** 自检：报告 seam、数据根目录与回收站条目数，排查时先看这里。 */
async function healthRoute(runtime) {
  const { ctx } = runtime
  const bin = await runtime.bin.load()
  return {
    status: 200,
    body: {
      ok: true,
      seam: runtime.base,
      home: runtime.home,
      binPath: runtime.bin.path,
      binEntries: bin.ids().length,
      archived: (await archivedIds(runtime)).length,
      hasLocate: typeof ctx.sessionPersistence?.locate === 'function',
    },
  }
}

/** 回收站列表：归档集合 ∪ 插件记录，附带体积、子代理数与运行状态。 */
async function listRoute(runtime) {
  const { ctx } = runtime
  const bin = await runtime.bin.load()
  const catalog = await loadCatalog(ctx)
  const ids = new Set(await archivedIds(runtime))
  for (const id of bin.ids()) ids.add(id)

  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  /** @type {any[]} */
  const entries = []
  let titleProbes = 0

  for (const id of ids) {
    if (!SESSION_ID_RE.test(id)) continue
    const record = bin.get(id)
    const header = catalog.headers.get(id)
    const path = header === undefined ? undefined : await locateSessionFile(ctx, runtime.home, header)
    const logBytes = path === undefined ? 0 : await fileSize(path)
    let title = record?.title
    if (typeof title !== 'string' || title.length === 0) title = typeof header?.title === 'string' ? header.title : undefined
    if ((title === undefined || title.length === 0) && header !== undefined && titleProbes < TITLE_PROBE_LIMIT) {
      titleProbes += 1
      title = await titleOf(ctx, id)
    }
    entries.push({
      id,
      title: typeof title === 'string' && title.length > 0 ? title : id,
      workspacePath: typeof header?.cwd === 'string' ? header.cwd : (record?.workspacePath ?? null),
      deletedAt: typeof record?.deletedAt === 'string' ? record.deletedAt : null,
      logBytes,
      hasLog: header !== undefined,
      subagentCount: header === undefined ? 0 : descendantsOf(catalog, id).length,
      live: sessions?.get?.(id) !== undefined,
      running: agents?.get?.(id)?.status === 'running',
    })
  }

  entries.sort((left, right) => {
    const leftAt = left.deletedAt === null ? '' : left.deletedAt
    const rightAt = right.deletedAt === null ? '' : right.deletedAt
    if (leftAt === rightAt) return left.title.localeCompare(right.title)
    return rightAt.localeCompare(leftAt)
  })

  return {
    status: 200,
    body: {
      ok: true,
      entries,
      totalBytes: entries.reduce((sum, entry) => sum + entry.logBytes, 0),
      home: runtime.home,
      /* 日志定位方式：后端有 locate() 时用它，否则按磁盘布局扫描。 */
      locator: typeof ctx.sessionPersistence?.locate === 'function' ? 'backend-locate' : 'layout-scan',
    },
  }
}

/** 归档（软删除）：移出侧栏但保留磁盘日志。 */
async function archiveRoute(runtime, body) {
  const { ctx } = runtime
  const sessionId = validSessionId(body?.sessionId)
  if (sessionId === undefined) {
    return { status: 400, body: { ok: false, code: 'invalid-session-id', message: '会话标识不合法。' } }
  }
  const catalog = await loadCatalog(ctx)
  const header = catalog.headers.get(sessionId)
  if (header === undefined) {
    return { status: 409, body: { ok: false, code: 'session-not-found', message: '找不到这个会话，可能已经被删除。' } }
  }

  const stop = body?.stop === true
  const activity = await sessionActivity(ctx, sessionId)
  const running = ctx.get('agents')?.get?.(sessionId)?.status === 'running'
  if ((activity.length > 0 || running) && !stop) {
    return {
      status: 409,
      body: {
        ok: false,
        code: 'session-active',
        activity: activityKinds(activity),
        message: '该会话仍在运行，需要先停止它的工作。',
      },
    }
  }

  try {
    /* 官方归档准入：给了 `stopActivity` 就由 `workspace/session-stop` 的各 provider
       先停掉回合 / 子代理 / 后台任务 / 定时提醒，再写入归档集合——插件不需要自己
       拼停止顺序，也不会和被停止的会话打架。 */
    await ctx.workspaceRegistry.archiveSession(sessionId, stop ? { stopActivity: true } : undefined)
  } catch (error) {
    if (String(error?.name ?? '') === 'WorkspaceActiveSessionError' || /active/i.test(messageOf(error))) {
      return {
        status: 409,
        body: {
          ok: false,
          code: 'session-active',
          activity: activityKinds(await sessionActivity(ctx, sessionId)),
          message: '该会话仍在运行，需要先停止它的工作。',
        },
      }
    }
    return {
      status: 409,
      body: { ok: false, code: 'archive-rejected', message: `归档被拒绝：${messageOf(error)}` },
    }
  }

  const logFile = await locateSessionFile(ctx, runtime.home, header)
  const entry = {
    id: sessionId,
    title: cleanTitle(body?.title) ?? (typeof header.title === 'string' ? header.title : sessionId),
    workspacePath: typeof header.cwd === 'string' ? header.cwd : null,
    deletedAt: new Date().toISOString(),
    sizeBytes: await fileSize(logFile ?? ''),
  }
  await runtime.bin.put(entry)
  runtime.ctx.logger?.info?.(`session-recycle-bin: archived ${sessionId}`)
  return { status: 200, body: { ok: true, entry } }
}

/** 还原：移出归档集合，磁盘文件不受影响。 */
async function restoreRoute(runtime, body) {
  const { ctx } = runtime
  const ids = Array.isArray(body?.sessionIds) ? body.sessionIds.map(validSessionId).filter(Boolean) : []
  const single = validSessionId(body?.sessionId)
  if (single !== undefined) ids.push(single)
  if (ids.length === 0) {
    return { status: 400, body: { ok: false, code: 'invalid-session-id', message: '没有给出要还原的会话。' } }
  }

  /** @type {any[]} */
  const results = []
  for (const id of ids) {
    try {
      await ctx.workspaceRegistry.unarchiveSession(id)
      await runtime.bin.remove(id)
      results.push({ id, ok: true })
    } catch (error) {
      results.push({ id, ok: false, message: messageOf(error) })
    }
  }
  ctx.logger?.info?.(`session-recycle-bin: restored ${results.filter((entry) => entry.ok).length}/${ids.length}`)
  return { status: 200, body: { ok: true, results } }
}

/** 永久删除：真正删掉磁盘日志（可选：全部 / 早于 N 天）。 */
async function purgeRoute(runtime, body) {
  const { ctx } = runtime
  /** @type {string[]} */
  let ids = []
  if (Array.isArray(body?.sessionIds)) {
    ids = body.sessionIds.map(validSessionId).filter((id) => id !== undefined)
  } else if (body?.all === true) {
    const union = new Set(await archivedIds(runtime))
    for (const id of (await runtime.bin.load()).ids()) union.add(id)
    ids = [...union]
  } else {
    return { status: 400, body: { ok: false, code: 'invalid-request', message: '需要 sessionIds 或 all。' } }
  }

  const bin = await runtime.bin.load()
  const catalog = await loadCatalog(ctx)
  const olderThanDays = Number.isFinite(body?.olderThanDays) ? Math.max(0, body.olderThanDays) : undefined
  /** 因「没有可靠的删除时间」而被 30 天清理规则跳过的会话数。 */
  let skippedUnknownAge = 0
  if (olderThanDays !== undefined) {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000
    /** @type {string[]} */
    const eligible = []
    for (const id of ids) {
      let at = Date.parse(bin.get(id)?.deletedAt ?? '')
      if (!Number.isFinite(at)) {
        /* 没有旁路记录时用日志文件的修改时间兜底；仍拿不到时间就绝不删——
           「30 天前」不能把时间未知的会话一并带走。 */
        const header = catalog.headers.get(id)
        const logFile = header === undefined ? undefined : await locateSessionFile(ctx, runtime.home, header)
        at = logFile === undefined ? Number.NaN : await fileMtimeMs(logFile)
      }
      if (!Number.isFinite(at)) {
        skippedUnknownAge += 1
        continue
      }
      if (at <= cutoff) eligible.push(id)
    }
    ids = eligible
  }
  if (ids.length === 0) {
    return { status: 200, body: { ok: true, results: [], purgedBytes: 0, failed: 0, skipped: { unknownAge: skippedUnknownAge } } }
  }

  /** @type {any[]} */
  const results = []
  let purgedBytes = 0

  for (const id of ids) {
    const header = catalog.headers.get(id)
    const bytes = header === undefined ? 0 : await fileSize((await locateSessionFile(ctx, runtime.home, header)) ?? '')
    const outcome = await purgeSession(runtime, id, catalog, header)
    if (outcome.ok === true) purgedBytes += bytes
    results.push({ id, bytes, ...outcome })
  }

  const failed = results.filter((entry) => entry.ok !== true).length
  ctx.logger?.info?.(`session-recycle-bin: purged ${results.length - failed}/${results.length} session(s)`)
  return { status: 200, body: { ok: true, results, purgedBytes, failed, skipped: { unknownAge: skippedUnknownAge } } }
}

/* --------------------------------------------------------------- 永久删除实现 */

/**
 * 永久删除一个会话：释放 → 停止 → 屏障 → 删文件 → 清注册表 → 广播。
 * @param {Runtime} runtime 运行时句柄
 * @param {string} sessionId 目标会话
 * @param {Catalog} catalog 会话目录索引
 * @param {any} header 目标会话的存储头
 * @returns {Promise<{ ok: boolean, code?: string, message?: string, removed?: string[], warnings?: any[] }>}
 */
async function purgeSession(runtime, sessionId, catalog, header) {
  const { ctx } = runtime
  /** @type {string[]} */
  const removed = []
  /** @type {any[]} */
  const warnings = []

  /* 1) 仍被进程持有（界面打开着 / agent 还活着）的会话必须先释放：活着的写句柄会在
     下一次 flush 把刚删掉的日志写回来。释放不成时拒绝，绝不留半删状态。 */
  const held = ctx.get('sessions')?.get?.(sessionId) !== undefined
  if (held) {
    const released = await releaseLiveSession(ctx, sessionId)
    if (released !== true) {
      return {
        ok: false,
        code: 'session-held',
        message: '该会话仍被当前进程打开，请先切换到别的会话（或重启应用）后再永久删除。',
        warnings,
      }
    }
    /* 释放后的持久化屏障：确认缓冲已落盘，接下来的删除不会被回写。 */
    try {
      await ctx.sessionPersistence.flush()
    } catch (error) {
      return {
        ok: false,
        code: 'flush-failed',
        message: `会话关闭时未能写入磁盘，为避免删除后被回写，本次没有删除：${messageOf(error)}`,
        warnings,
      }
    }
  }

  /* 2) 仍在跑的工作先停：走官方停止通道，再等工作族清零。 */
  const activity = await sessionActivity(ctx, sessionId)
  if (activity.length > 0 || ctx.get('agents')?.get?.(sessionId)?.status === 'running') {
    await stopSessionWork(ctx, sessionId)
    const remaining = await waitForWorkToClear(ctx, sessionId, runtime.stopWaitMs)
    if (remaining.length > 0) {
      return {
        ok: false,
        code: 'session-stopping',
        message: `该会话仍在收尾（${activityKinds(remaining).join('、') || '运行中的回合'}），请稍候再试。`,
        warnings,
      }
    }
  }

  /* 3) 删除日志目录与投影缓存；子代理会话是独立的存储会话，必须一起删除。 */
  const targets = [sessionId, ...descendantsOf(catalog, sessionId)]
  for (const target of targets) {
    const targetHeader = target === sessionId ? header : catalog.headers.get(target)
    if (targetHeader === undefined) continue
    const logFile = await locateSessionFile(ctx, runtime.home, targetHeader)
    if (logFile === undefined) {
      warnings.push({ id: target, what: 'location', message: '没有找到该会话的日志目录，已跳过。' })
    } else {
      const directory = dirname(logFile)
      if (basename(directory) !== target) {
        warnings.push({ id: target, what: 'unsafe-location', message: '会话数据目录与目标会话不匹配，已跳过。' })
      } else {
        try {
          await rm(directory, { recursive: true, force: true })
          removed.push(`session-dir:${target}`)
          /* 项目目录空了就一起收掉，别在 sessions 下留空文件夹。 */
          await pruneEmptyProjectDir(runtime.home, directory, removed)
        } catch (error) {
          warnings.push({ id: target, what: 'session-dir', message: messageOf(error) })
        }
      }
    }
    try {
      const table = ctx.get('storageDomain')?.get?.('session_projcache')?.table?.('sessions')
      if (table !== undefined && typeof table.delete === 'function') {
        const deleted = await table.delete(target)
        if (deleted === true) removed.push(`projection-cache:${target}`)
      }
    } catch (error) {
      warnings.push({ id: target, what: 'projection-cache', message: messageOf(error) })
    }
  }

  /* 4) 清掉注册表里仍然记着它的位置，并通知页面移除该行。 */
  for (const target of targets) await forgetSession(ctx, target)
  await runtime.bin.remove(sessionId)
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch (error) {
    warnings.push({ what: 'emit', message: messageOf(error) })
  }

  return { ok: true, removed, warnings }
}

/** 把一个会话从归档、置顶、工作区成员与进程内索引里摘除。 */
async function forgetSession(ctx, sessionId) {
  const registry = ctx.workspaceRegistry
  try {
    await registry.unarchiveSession(sessionId)
  } catch {
    /* 不在归档集合里是正常情况 */
  }
  try {
    await registry.unpinSession(sessionId)
  } catch {
    /* 不在置顶集合里是正常情况 */
  }
  try {
    for (const workspace of registry.list() ?? []) {
      if (!Array.isArray(workspace?.sessionIds) || !workspace.sessionIds.includes(sessionId)) continue
      await workspace.detachSession?.(sessionId)
    }
  } catch {
    /* 工作区摘除是尽力而为 */
  }
  try {
    registry.sessionPaths?.delete?.(sessionId)
    registry.headers?.delete?.(sessionId)
  } catch {
    /* 启动索引清理同样是尽力而为 */
  }
}

/**
 * 把一个驻留会话从实时 SessionStore 里释放掉；释放成功（store 里不再有它）返回 true。
 *
 * 不同版本给第三方的释放口子不同（`detachEntered` 是公开方法但它们不属于抽象契约），
 * 所以这里按候选顺序尝试，并以「store 里查不到该 id」作为唯一成功判据。
 * @param {any} ctx 宿主上下文
 * @param {string} sessionId 目标会话
 * @returns {Promise<boolean>}
 */
async function releaseLiveSession(ctx, sessionId) {
  const store = ctx.get('sessions')
  if (store === undefined) return true
  if (typeof store.get !== 'function') return false
  if (store.get(sessionId) === undefined) return true

  /** @type {Array<() => unknown>} */
  const candidates = []
  try {
    const entry = store.store?.get?.(sessionId)
    if (entry !== undefined && typeof store.detachEntered === 'function') {
      candidates.push(() => store.detachEntered(entry))
    }
  } catch {
    /* 内部结构不可读时跳过这一候选 */
  }
  try {
    const agent = ctx.get('agents')?.get?.(sessionId)
    if (agent !== undefined && typeof agent.dispose === 'function') candidates.push(() => agent.dispose())
  } catch {
    /* agent 可能已经被回收 */
  }
  try {
    if (typeof store.detach === 'function') candidates.push(() => store.detach(sessionId))
    if (typeof store.dispose === 'function') candidates.push(() => store.dispose(sessionId))
  } catch {
    /* 候选探测失败不影响其它候选 */
  }

  for (const candidate of candidates) {
    try {
      await candidate()
    } catch {
      continue
    }
    if (store.get(sessionId) === undefined) return true
  }
  return store.get(sessionId) === undefined
}

/* --------------------------------------------------------------- 会话目录索引 */

/**
 * @typedef {object} Catalog
 * @property {Map<string, any>} headers 会话 id → 存储头
 * @property {Map<string, string[]>} childrenByParent 父会话 id → 子代理会话 id
 */

/**
 * 读取全部会话头，并建立子代理索引。
 * @param {any} ctx 宿主上下文
 * @returns {Promise<Catalog>}
 */
async function loadCatalog(ctx) {
  /** @type {Catalog} */
  const catalog = { headers: new Map(), childrenByParent: new Map() }
  let snapshots
  try {
    snapshots = await ctx.sessionPersistence.list()
  } catch {
    return catalog
  }
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const header = snapshot?.header
    if (header === undefined || typeof header.id !== 'string') continue
    catalog.headers.set(header.id, header)
    if (header.origin === 'subagent' && typeof header.parentSession === 'string') {
      const siblings = catalog.childrenByParent.get(header.parentSession) ?? []
      siblings.push(header.id)
      catalog.childrenByParent.set(header.parentSession, siblings)
    }
  }
  return catalog
}

/**
 * 递归列出某会话名下的全部子代理会话（分叉会话不带 `origin: subagent`，不会入选）。
 * @param {Catalog} catalog 会话目录索引
 * @param {string} sessionId 根会话
 * @returns {string[]}
 */
function descendantsOf(catalog, sessionId) {
  /** @type {string[]} */
  const descendants = []
  const seen = new Set([sessionId])
  const queue = [sessionId]
  while (queue.length > 0) {
    const parent = /** @type {string} */ (queue.shift())
    for (const child of catalog.childrenByParent.get(parent) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      descendants.push(child)
      queue.push(child)
    }
  }
  return descendants
}

/**
 * 定位一个会话的日志文件：先问持久化后端（老版本有 `locate()`），没有就按文档化的
 * JSONL 布局 `<home>/sessions/<项目>/<会话id>/session*.jsonl*` 扫描。
 * 只接受目录名等于会话 id 的结果，所以调用方永远不会删到别的会话。
 * @param {any} ctx 宿主上下文
 * @param {string} home DSH 数据根目录
 * @param {any} header 会话存储头
 * @returns {Promise<string | undefined>}
 */
async function locateSessionFile(ctx, home, header) {
  const locate = ctx.sessionPersistence?.locate
  if (typeof locate === 'function') {
    try {
      const location = locate.call(ctx.sessionPersistence, { id: header.id, cwd: header.cwd })
      const path = typeof location?.path === 'string' && location.path.length > 0 ? location.path : undefined
      if (path !== undefined && basename(dirname(path)) === header.id) return path
    } catch {
      /* 后端没有 locate 或拒绝时退回目录扫描 */
    }
  }
  return findSessionLogByLayout(home, header.id)
}

/**
 * 按 JSONL 后端的磁盘布局查找一个会话目录中的日志文件。
 * @param {string} home DSH 数据根目录
 * @param {string} sessionId 会话 id
 * @returns {Promise<string | undefined>}
 */
async function findSessionLogByLayout(home, sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) return undefined
  const sessionsRoot = join(home, 'sessions')
  /** @type {string[]} */
  let projects
  try {
    projects = (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return undefined
  }
  for (const project of projects) {
    const directory = join(sessionsRoot, project, sessionId)
    let files
    try {
      files = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    const logs = files
      .filter((entry) => entry.isFile() && entry.name.startsWith('session') && entry.name.includes('.jsonl'))
      .map((entry) => entry.name)
      .sort()
    if (logs.length === 0) continue
    return join(directory, logs[logs.length - 1])
  }
  return undefined
}

/** 归档集合：优先读注册表内存状态，退回 `storages/workspace.json`。 */
async function archivedIds(runtime) {
  const { ctx, home } = runtime
  const registry = ctx.workspaceRegistry
  for (const candidate of [
    () => (typeof registry.snapshot === 'function' ? registry.snapshot()?.archivedSessionIds : undefined),
    () => registry.archivedSessionIds,
    () => registry.state?.archivedSessionIds,
  ]) {
    try {
      const value = candidate()
      if (Array.isArray(value)) return value.filter((id) => typeof id === 'string')
    } catch {
      /* 换下一个候选形状 */
    }
  }
  try {
    const document = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
    const value = document?.global?.archivedSessionIds
    return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** 会话标题：`sessionQuery.readTitle` 的多种返回形状都接受。 */
async function titleOf(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (query === undefined) return undefined
  try {
    const snapshot = await query.readTitle?.(sessionId)
    for (const value of [snapshot?.title, snapshot?.value?.title, snapshot?.snapshot?.title]) {
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
  } catch {
    /* 读不到标题不是错误，退回会话 id */
  }
  return undefined
}

/* ------------------------------------------------------------- 会话工作状态 */

/** 运行中工作的族列表（回合 / 子代理 / 后台任务 / 定时提醒）。 */
async function sessionActivity(ctx, sessionId) {
  try {
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    return Array.isArray(activity) ? activity : []
  } catch {
    return []
  }
}

function activityKinds(activity) {
  return (Array.isArray(activity) ? activity : [])
    .map((entry) => entry?.kind)
    .filter((kind) => typeof kind === 'string')
}

/**
 * 官方停止通道：`workspaceRegistry.stopSessionActivity` 在新版本才存在，旧版本没有时
 * 退回归档准入的 `stopActivity` 分支——两者都由同一批 `workspace/session-stop` provider
 * 响应（回合 / 子代理 / 后台任务 / 定时提醒）。注意它和归档一样会丢弃排队中的输入。
 */
function stopSessionWork(ctx, sessionId) {
  const registry = ctx.workspaceRegistry
  if (typeof registry.stopSessionActivity === 'function') return registry.stopSessionActivity(sessionId)
  return registry.archiveSession(sessionId, { stopActivity: true })
}

/** 等 agent 与全部工作族清零，最多等 timeoutMs。 */
async function waitForWorkToClear(ctx, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const running = ctx.get('agents')?.get?.(sessionId)?.status === 'running'
    const activity = await sessionActivity(ctx, sessionId)
    if (!running && activity.length === 0) return []
    if (Date.now() >= deadline) return activity.length === 0 ? [{ kind: 'turn' }] : activity
    await delay(250)
  }
}

/* ------------------------------------------------------------------ 小工具 */

/**
 * 回收站附加记录：`{ version, entries: { [sessionId]: { id, title, workspacePath, deletedAt, sizeBytes } } }`。
 * 文件缺失或损坏时退化为空表，不影响归档/还原本身。
 */
class RecycleBin {
  /** @param {string} path 附加记录路径 */
  constructor(path) {
    this.path = path
    /** @type {Map<string, any>} */
    this.entries = new Map()
    this.loaded = false
    this.queue = Promise.resolve()
  }

  /** 读取一次并缓存。 @returns {Promise<RecycleBin>} */
  async load() {
    if (this.loaded) return this
    this.loaded = true
    try {
      const document = JSON.parse(await readFile(this.path, 'utf8'))
      const entries = document?.entries
      if (entries !== null && typeof entries === 'object') {
        for (const [id, value] of Object.entries(entries)) {
          if (value !== null && typeof value === 'object') this.entries.set(id, { ...value, id })
        }
      }
    } catch {
      /* 首次运行时文件不存在 */
    }
    return this
  }

  ids() {
    return [...this.entries.keys()]
  }

  get(id) {
    return this.entries.get(id)
  }

  /** @param {any} entry 记录 @returns {Promise<void>} */
  async put(entry) {
    await this.load()
    this.entries.set(entry.id, entry)
    await this.persist()
  }

  /** @param {string} id 会话 id @returns {Promise<void>} */
  async remove(id) {
    await this.load()
    if (this.entries.delete(id)) await this.persist()
  }

  /** 串行落盘，避免并发写同一个文件。 */
  persist() {
    this.queue = this.queue.then(async () => {
      const document = { version: 1, entries: Object.fromEntries(this.entries) }
      const temporary = `${this.path}.${process.pid}.tmp`
      try {
        await mkdir(dirname(this.path), { recursive: true })
        await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
        await rename(temporary, this.path)
      } catch {
        /* 附加记录写失败不影响主流程 */
      }
    })
    return this.queue
  }
}

/** 合法会话 id 或 undefined。 */
function validSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value) ? value : undefined
}

/** 标题清洗：去首尾空白、限长、过滤空串。 */
function cleanTitle(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
}

/** 文件体积；不存在或失败记 0。 */
async function fileSize(path) {
  if (path.length === 0) return 0
  try {
    return (await fsStat(path)).size
  } catch {
    return 0
  }
}

/** 文件修改时间（毫秒）；不存在或失败返回 NaN。 */
async function fileMtimeMs(path) {
  if (path.length === 0) return Number.NaN
  try {
    return (await fsStat(path)).mtimeMs
  } catch {
    return Number.NaN
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
