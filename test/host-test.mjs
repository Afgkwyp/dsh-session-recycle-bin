// Fixture test for the Host half of dsh-session-recycle-bin.
//
// It runs the real `index.js` against fake Cordis services (Connection routes,
// session persistence, workspace registry, storage domain) plus a disposable
// fixture `$DSH_HOME`, so archive / list / restore / permanent-delete can be
// verified without a running DeepSeek Harness.
//
// Run with: node test/host-test.mjs
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_URL = pathToFileURL(fileURLToPath(new URL('../index.js', import.meta.url))).href
const root = join(tmpdir(), `srb-fixture-${process.pid}`)
const home = join(root, 'home')
const sessionsRoot = join(home, 'sessions', '--C-project--')
const workspacePath = join(home, 'storages', 'workspace.json')
const checks = []

function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  ${detail}`}`)
}

async function write(path, content) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 80))

/* ---------------------------------------------------------------- fixture */

const headers = [
  { id: 'session-a', cwd: 'C:\\project', createdAt: 1, version: 4, isSeeded: false },
  { id: 'session-b', cwd: 'C:\\project', createdAt: 2, version: 4, isSeeded: false },
  { id: 'session-c', cwd: 'C:\\project', createdAt: 3, version: 4, isSeeded: false, origin: 'subagent', parentSession: 'session-a' },
  { id: 'session-d', cwd: 'C:\\other', createdAt: 4, version: 4, isSeeded: false },
]
for (const header of headers) await write(join(sessionsRoot, header.id, 'session.jsonl.zstd'), 'zstd-bytes')
await write(join(home, 'storages', 'session_projcache', 'sessions', 'session-a.json'), '{}')

// A leftover empty project directory: activation must sweep it away.
const emptyProject = join(home, 'sessions', '--C-empty--')
await mkdir(emptyProject, { recursive: true })

// The fake registry persists its archive set the way the real one does, so the
// plugin's `storages/workspace.json` fallback read sees the same truth.
const archived = new Set(['session-a', 'session-b', 'session-c'])
async function persistArchiveSet() {
  await write(workspacePath, JSON.stringify({
    global: { archivedSessionIds: [...archived] },
    tables: { workspaces: {} },
  }, null, 2))
}
await persistArchiveSet()

/* ------------------------------------------------------------------ fakes */

const calls = { archive: [], unarchive: [], unpin: [], detach: [], emit: [], cacheDeleted: [], flush: 0 }

function makeCtx(overrides = {}) {
  const routes = new Map()
  const tables = {
    async delete(key) {
      calls.cacheDeleted.push(key)
      return true
    },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    effect: (fn) => fn(),
    get(name) {
      if (name === 'sessions') return { get: () => undefined, store: new Map() }
      if (name === 'agents') return { get: () => undefined }
      if (name === 'storageDomain') return { get: () => ({ table: () => tables }) }
      if (name === 'sessionQuery') return { readTitle: async (id) => ({ title: `title-of-${id}` }) }
      return undefined
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return async () => {}
        },
      },
    },
    sessionPersistence: {
      async list() {
        return headers.map((header) => ({ header, revision: 'r' }))
      },
      async stat(id) {
        const header = headers.find((entry) => entry.id === id)
        return header === undefined ? undefined : { header, revision: 'r' }
      },
      async flush() {
        calls.flush += 1
      },
    },
    workspaceRegistry: {
      async archiveSession(id, options) {
        calls.archive.push({ id, options })
        archived.add(id)
        await persistArchiveSet()
      },
      async unarchiveSession(id) {
        calls.unarchive.push(id)
        archived.delete(id)
        await persistArchiveSet()
      },
      async unpinSession(id) {
        calls.unpin.push(id)
      },
      list() {
        return [{
          path: 'C:\\project',
          sessionIds: ['session-a', 'session-b', 'session-c', 'session-d'],
          async detachSession(id) {
            calls.detach.push(id)
          },
        }]
      },
    },
    waterfall: async (_name, _payload, fallback) => fallback(),
    emit(name, ...args) {
      calls.emit.push({ name, args })
    },
    ...overrides,
  }
  return { ctx, routes }
}

async function call(routes, method, name, body) {
  const route = routes.get(`/api/session-recycle-bin.${name}`)
  if (route === undefined) throw new Error(`route missing: ${name}`)
  if (!route.methods.includes(method)) throw new Error(`method mismatch: ${name}`)
  const request = new Request(`http://127.0.0.1/api/session-recycle-bin.${name}`, {
    method,
    headers: { 'x-dsh-session-recycle-bin': '1' },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  })
  const response = await route.fetch(request)
  return { status: response.status, body: await response.json() }
}

/* ----------------------------------------------------- run: layout fallback */

const plugin = await import(PACKAGE_URL)
const { ctx, routes } = makeCtx()
plugin.apply(ctx, { home })

await tick()
check('activation sweeps leftover empty project directories', (await exists(emptyProject)) === false)
check('routes registered under /api', [...routes.keys()].every((path) => path.startsWith('/api/session-recycle-bin.')), [...routes.keys()].join(','))
check('five routes registered', routes.size === 5, String(routes.size))

const health = await call(routes, 'GET', 'health')
check('health reports seam + no locate()', health.body.ok === true && health.body.seam === 'api' && health.body.hasLocate === false, JSON.stringify(health.body))

const listed = await call(routes, 'GET', 'list')
check('list returns the archived set', listed.body.ok === true && listed.body.entries.length === 3, JSON.stringify(listed.body.entries.map((entry) => entry.id)))
check('list reads log bytes from disk', listed.body.entries.some((entry) => entry.id === 'session-a' && entry.logBytes > 0), JSON.stringify(listed.body.entries))
check('list counts subagent sessions', listed.body.entries.some((entry) => entry.id === 'session-a' && entry.subagentCount === 1), JSON.stringify(listed.body.entries))
check('list fills titles from sessionQuery', listed.body.entries.some((entry) => entry.id === 'session-b' && entry.title === 'title-of-session-b'), JSON.stringify(listed.body.entries))
check('list reports the layout-scan locator', listed.body.locator === 'layout-scan', listed.body.locator)

const archivedD = await call(routes, 'POST', 'archive', { sessionId: 'session-d', title: 'Delete me' })
check('archive calls the registry', archivedD.body.ok === true && calls.archive.at(-1)?.id === 'session-d', JSON.stringify(archivedD.body))
const afterArchive = await call(routes, 'GET', 'list')
check('archived session joins the bin with its title', afterArchive.body.entries.some((entry) => entry.id === 'session-d' && entry.title === 'Delete me'), JSON.stringify(afterArchive.body.entries.map((entry) => [entry.id, entry.title])))

const restored = await call(routes, 'POST', 'restore', { sessionIds: ['session-b'] })
check('restore unarchives', restored.body.ok === true && calls.unarchive.includes('session-b'), JSON.stringify(restored.body))
const afterRestore = await call(routes, 'GET', 'list')
check('restored session leaves the bin', !afterRestore.body.entries.some((entry) => entry.id === 'session-b'), JSON.stringify(afterRestore.body.entries.map((entry) => entry.id)))

const purged = await call(routes, 'POST', 'purge', { sessionIds: ['session-a'] })
const result = purged.body.results?.[0] ?? {}
check('purge reports ok', purged.body.ok === true && result.ok === true, JSON.stringify(purged.body).slice(0, 400))
check('purge removed the session log directory', (await exists(join(sessionsRoot, 'session-a'))) === false)
check('purge removed the subagent session directory', (await exists(join(sessionsRoot, 'session-c'))) === false)
check('purge left an unrelated session directory alone', (await exists(join(sessionsRoot, 'session-d'))) === true)
check('purge keeps a non-empty project directory', (await exists(sessionsRoot)) === true)
check('purge deleted projection cache rows', calls.cacheDeleted.includes('session-a') && calls.cacheDeleted.includes('session-c'), JSON.stringify(calls.cacheDeleted))
check('purge unarchived and unpinned', calls.unarchive.includes('session-a') && calls.unpin.includes('session-a'))
check('purge detached workspace membership', calls.detach.includes('session-a') && calls.detach.includes('session-c'), JSON.stringify(calls.detach))
check('purge emitted api-session/removed', calls.emit.some((entry) => entry.name === 'api-session/removed' && entry.args[0] === 'session-a'), JSON.stringify(calls.emit))
check('purged session leaves the bin', (await call(routes, 'GET', 'list')).body.entries.every((entry) => entry.id !== 'session-a'))

const purgedAll = await call(routes, 'POST', 'purge', { all: true })
check('purge all clears every archived session', purgedAll.body.ok === true && purgedAll.body.results.length >= 1, JSON.stringify(purgedAll.body).slice(0, 300))
check('purge all removed the remaining logs', (await exists(join(sessionsRoot, 'session-d'))) === false)
const left = await call(routes, 'GET', 'list')
check('bin is empty afterwards', left.body.entries.length === 0, JSON.stringify(left.body.entries))
check('purge keeps a project directory that still has sessions', (await exists(sessionsRoot)) === true)
check('purge never removes the sessions root', (await exists(join(home, 'sessions'))) === true)

/* A project directory holding exactly one session must disappear with that session. */
const otherProject = join(home, 'sessions', '--C-other--')
headers.push({ id: 'session-x', cwd: 'C:\\other', createdAt: 6, version: 4, isSeeded: false })
await write(join(otherProject, 'session-x', 'session.jsonl.zstd'), 'other-bytes')
archived.add('session-x')
await persistArchiveSet()
const purgedX = await call(routes, 'POST', 'purge', { sessionIds: ['session-x'] })
check('purge removes an emptied project directory', purgedX.body.results?.[0]?.ok === true && (await exists(otherProject)) === false, JSON.stringify(purgedX.body).slice(0, 300))

const olderThan = await call(routes, 'POST', 'purge', { all: true, olderThanDays: 30 })
check('empty purge is a no-op', olderThan.body.ok === true && olderThan.body.results.length === 0, JSON.stringify(olderThan.body))

/* --------------------------------------------------- run: backend locate() */

headers.push({ id: 'session-e', cwd: 'C:\\project', createdAt: 5, version: 4, isSeeded: false })
await write(join(sessionsRoot, 'session-e', 'session.jsonl.zstd'), 'located-bytes')
archived.add('session-e')
await persistArchiveSet()
const locatedIds = []
const second = makeCtx({
  sessionPersistence: {
    ...ctx.sessionPersistence,
    locate({ id }) {
      locatedIds.push(id)
      return { path: join(sessionsRoot, id, 'session.jsonl.zstd') }
    },
  },
})
const secondPlugin = await import(`${PACKAGE_URL}?locate=1`)
secondPlugin.apply(second.ctx, { home })
const locatedList = await call(second.routes, 'GET', 'list')
check('locate() is preferred when the backend has it', locatedList.body.locator === 'backend-locate' && locatedIds.includes('session-e'), JSON.stringify({ locator: locatedList.body.locator, locatedIds }))
check('locate() still resolves a size', locatedList.body.entries.some((entry) => entry.id === 'session-e' && entry.logBytes > 0), JSON.stringify(locatedList.body.entries))

/* --------------------------------------------------------------- teardown */

const failed = checks.filter((entry) => !entry.ok)
const filesLeft = await readdir(sessionsRoot).catch(() => [])
console.log('\nsession dirs left:', filesLeft)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
await rm(root, { recursive: true, force: true })
if (failed.length > 0) {
  console.log('FAILED:', failed.map((entry) => entry.name).join(' | '))
  process.exitCode = 1
}
