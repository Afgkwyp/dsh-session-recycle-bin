/**
 * session-recycle-bin — Client half.
 *
 * 四个面，全部走宿主半的同源精确路由：
 *
 * - **会话头部垃圾桶按钮**（`conversation.session.header.utilities`）——把当前会话
 *   移入回收站。该 seat 的条目不接收 owner 值，当前会话从 `ctx.sessions.list`
 *   快照里读；读不到时退回站点属性。
 * - **侧栏「⋯」菜单的「删除会话」**（`sidebar.workspaces.session.menu.item`，
 *   order 500，排在 pin/rename/fork/archive/session-id 之后）——行身份由 slot
 *   契约直接给出（`sessionId` / `displayTitle`），菜单自己用注入的
 *   `useMenuOpenState` 收起。
 * - **确认框**（`shell.overlay`）——菜单项随菜单卸载，所以对话框不能挂在菜单里；
 *   待处理请求放在模块级 store 中，由 overlay 条目渲染。
 * - **设置页「会话回收站」**（`settings.section`）——归档会话集中管理：多选还原、
 *   永久删除、清空、清理 30 天前，并显示日志体积与位置。
 *
 * 说明：Harness 的 Client 包不在此引入（会被 HMR 与类型检查之外的版本变化打碎）；
 * 这里的标记、类名与主题 token 都按插件自己的前缀复刻本机已有的宿主控件外观。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-recycle-bin',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 本插件拥有的 locale 命名空间。 */
    const NS = 'sessionRecycleBin'
    /** 菜单行 seat。 */
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    /** 会话头部右侧工具 seat。 */
    const HEADER_SLOT = 'conversation.session.header.utilities'
    /** 全帧浮层 seat。 */
    const OVERLAY_SLOT = 'shell.overlay'
    /** 设置页 seat。 */
    const SETTINGS_SLOT = 'settings.section'
    /** 同源围栏请求头，宿主半强制要求。 */
    const GUARD_HEADER = 'x-dsh-session-recycle-bin'
    /** 菜单行顺序：官方 pin/rename/fork/archive/session-id 已占到 450。 */
    const DELETE_ORDER = 500
    /** 头部按钮顺序（工具行最右）。 */
    const HEADER_ORDER = 80
    /** 设置页顺序：排在官方分区之后。 */
    const SETTINGS_ORDER = 900
    /** 「清理 30 天前」的天数。 */
    const RETENTION_DAYS = 30

    /* ------------------------------------------------------------- 文案 */

    const DICTIONARIES = {
      zh: {
        'menu.deleteSession': '删除会话',
        'header.deleteTooltip': '删除会话（移入回收站）',
        'confirm.title': '删除此会话？',
        'confirm.desc': '将把「{title}」移入回收站：它会从侧栏消失，但日志仍保留在磁盘上，可在「设置 → 会话回收站」里还原或永久删除。',
        'confirm.running': '该会话仍在运行，需要先停止它的工作。',
        'confirm.action': '移入回收站',
        'confirm.stopping': '正在停止它的工作…',
        'confirm.pending': '正在移入回收站…',
        'confirm.stopAndArchive': '停止并删除',
        'confirm.done': '已移入回收站。',
        'purge.title': '永久删除 {count} 个会话？',
        'purge.titleOne': '永久删除「{title}」？',
        'purge.titleAll': '清空回收站（{count} 个会话）？',
        'purge.titleOlder': '删除 {days} 天前的归档会话？',
        'purge.desc': '将真正删除这些会话在磁盘上的日志、子代理会话与缓存数据。此操作不可撤销。',
        'purge.descOne': '将真正删除「{title}」在磁盘上的日志、子代理会话与缓存数据。此操作不可撤销。',
        'purge.descAll': '将真正删除回收站里全部 {count} 个会话的日志、子代理会话与缓存数据。此操作不可撤销。',
        'purge.descOlder': '将删除归档时间早于 {days} 天的会话日志、子代理会话与缓存数据；没有删除记录的按日志最后修改时间判断，两者都拿不到时间的会话会保留。此操作不可撤销。',
        'purge.skippedUnknown': '另有 {count} 个会话缺少可用时间信息，已保留。',
        'purge.action': '永久删除',
        'purge.pending': '正在删除…',
        'purge.done': '已永久删除 {count} 个会话，释放 {size}。',
        'purge.partial': '{count} 个会话未能删除：{ids}',
        'row.confirmTitle': '永久删除「{title}」？',
        'row.confirmDesc': '将删除磁盘上的日志、{count} 个子代理会话与缓存数据，不可撤销。',
        'row.confirmDescNoSub': '将删除磁盘上的日志与缓存数据，不可撤销。',
        'page.navLabel': '会话回收站',
        'page.title': '会话回收站',
        'page.desc': '归档会话集中管理：删除的会话先放进这里，可随时还原；确认不要了再真正删掉磁盘上的日志。',
        'page.refresh': '刷新',
        'page.loading': '正在读取回收站…',
        'page.empty': '回收站是空的。删除会话后会出现在这里。',
        'page.count': '{count} 个会话 · 日志 {size}',
        'page.location': '数据目录：{path}',
        'page.locatorTag': '日志定位：{mode}',
        'page.locatorBackend': '后端接口',
        'page.locatorScan': '磁盘目录扫描',
        'page.selectAll': '全选',
        'page.selected': '已选 {count} 个',
        'page.restore': '还原',
        'page.purge': '永久删除',
        'page.emptyBin': '清空回收站',
        'page.purgeOlder': '删除 30 天前的会话',
        'page.restoring': '正在还原…',
        'page.restored': '已还原 {count} 个会话。',
        'page.restoreFailed': '还原失败：{message}',
        'page.failed': '操作失败：{message}',
        'page.running': '运行中',
        'page.noLog': '日志缺失',
        'page.unknownTime': '时间未知',
        'page.subagents': '{count} 个子代理',
        'cancel': '取消',
        'close': '关闭',
        'confirm.failed': '操作失败：{message}',
      },
      en: {
        'menu.deleteSession': 'Delete session',
        'header.deleteTooltip': 'Delete session (move to recycle bin)',
        'confirm.title': 'Delete this session?',
        'confirm.desc': '“{title}” moves to the recycle bin: it leaves the sidebar but its log stays on disk, so you can restore it or delete it for good under Settings → Session recycle bin.',
        'confirm.running': 'This session is still running; stop its work first.',
        'confirm.action': 'Move to recycle bin',
        'confirm.stopping': 'Stopping its work…',
        'confirm.pending': 'Moving to the recycle bin…',
        'confirm.stopAndArchive': 'Stop and delete',
        'confirm.done': 'Moved to the recycle bin.',
        'purge.title': 'Permanently delete {count} session(s)?',
        'purge.titleOne': 'Permanently delete “{title}”?',
        'purge.titleAll': 'Empty the recycle bin ({count} session(s))?',
        'purge.titleOlder': 'Delete sessions archived more than {days} days ago?',
        'purge.desc': 'This removes their logs, subagent sessions and cached data from disk. It cannot be undone.',
        'purge.descOne': 'This removes “{title}” — its log, subagent sessions and cached data — from disk. It cannot be undone.',
        'purge.descAll': 'This removes the logs, subagent sessions and cached data of all {count} session(s) in the recycle bin. It cannot be undone.',
        'purge.descOlder': 'This removes the logs, subagent sessions and cached data of sessions archived more than {days} days ago. When no deletion record exists, the log’s last-modified time is used; sessions with neither are kept. It cannot be undone.',
        'purge.skippedUnknown': '{count} session(s) had no usable time information and were kept.',
        'purge.action': 'Delete permanently',
        'purge.pending': 'Deleting…',
        'purge.done': 'Permanently deleted {count} session(s), freeing {size}.',
        'purge.partial': '{count} session(s) could not be deleted: {ids}',
        'row.confirmTitle': 'Permanently delete “{title}”?',
        'row.confirmDesc': 'Removes its log, {count} subagent session(s) and cached data from disk. This cannot be undone.',
        'row.confirmDescNoSub': 'Removes its log and cached data from disk. This cannot be undone.',
        'page.navLabel': 'Recycle bin',
        'page.title': 'Session recycle bin',
        'page.desc': 'Archived sessions in one place: deleted sessions land here first and can be restored any time; delete their logs only once you are sure.',
        'page.refresh': 'Refresh',
        'page.loading': 'Reading the recycle bin…',
        'page.empty': 'The recycle bin is empty. Deleted sessions show up here.',
        'page.count': '{count} session(s) · {size} of logs',
        'page.location': 'Data directory: {path}',
        'page.locatorTag': 'Log lookup: {mode}',
        'page.locatorBackend': 'backend interface',
        'page.locatorScan': 'on-disk directory scan',
        'page.selectAll': 'Select all',
        'page.selected': '{count} selected',
        'page.restore': 'Restore',
        'page.purge': 'Delete permanently',
        'page.emptyBin': 'Empty recycle bin',
        'page.purgeOlder': 'Delete sessions older than 30 days',
        'page.restoring': 'Restoring…',
        'page.restored': 'Restored {count} session(s).',
        'page.restoreFailed': 'Restore failed: {message}',
        'page.failed': 'The operation failed: {message}',
        'page.running': 'Running',
        'page.noLog': 'Log missing',
        'page.unknownTime': 'unknown time',
        'page.subagents': '{count} subagent(s)',
        'cancel': 'Cancel',
        'close': 'Close',
        'confirm.failed': 'The operation failed: {message}',
      },
    }

    /** 没有 locale 注入时的兜底取值（默认中文）。 */
    function fallbackText(key, vars) {
      const template = DICTIONARIES.zh[key] ?? key
      return interpolate(template, vars)
    }

    function interpolate(template, vars) {
      if (vars === undefined || vars === null) return template
      return String(template).replace(/\{(\w+)\}/g, (whole, name) => {
        const value = vars[name]
        return value === undefined || value === null ? whole : String(value)
      })
    }

    /** 条目 props 里的 `t`，缺失时退回本地字典。 */
    function propsT(props) {
      return typeof props?.t === 'function' ? props.t : fallbackText
    }

    /* ------------------------------------------------------------- 样式 */

    /**
     * 按钮 = 官方 `ui-primitives` 的 Button 原子（`Button.module.css`）按本插件前缀
     * 复刻：相同的尺寸/圆角/间距/悬停与禁用语义，只走 `--dsw-alias-*` 主题变量。
     */
    const BUTTON_CSS = [
      '.srb-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;',
      'border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font-size:14px;line-height:22px;',
      'color:var(--dsw-alias-label-primary);background:transparent;padding:0 14px}',
      '.srb-btn:disabled{cursor:not-allowed;opacity:.4}',
      '.srb-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,',
      'var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.srb-btnMd{height:36px}',
      '.srb-btnSm{height:28px;font-size:12px;line-height:18px;padding:0 10px;border-radius:var(--dsw-radius-sm)}',
      '.srb-btnPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.srb-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.srb-btnGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.srb-btnGhost:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
      '.srb-btnOutline{border:.5px solid var(--dsw-alias-border-l3);background:transparent}',
      '.srb-btnOutline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.srb-btnToolbar{background:var(--dsw-alias-button-tool-bar-fill)}',
      '.srb-btnToolbar:hover:not(:disabled){background:var(--dsw-alias-button-tool-bar-hover)}',
      '.srb-btnIcon{display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;flex:none}',
      '.srb-btnDanger{color:var(--dsw-alias-state-error-primary)}',
      '.srb-btnDanger:disabled{color:var(--dsw-alias-label-tertiary)}',
      '.srb-btnDangerFill{background:var(--dsw-alias-state-error-primary);',
      'color:var(--dsw-alias-label-primary-foreground)}',
      '.srb-btnDangerFill:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);opacity:.9}',
    ].join('')

    const ICON_CSS = [
      '.srb-iconButton{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;',
      'padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;',
      'color:var(--dsw-alias-label-secondary)}',
      '.srb-iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.srb-iconButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,',
      'var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.srb-iconButton:disabled{cursor:not-allowed;opacity:.4}',
      '.srb-iconButton.srb-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);',
      'background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover))}',
    ].join('')

    const MENU_CSS = [
      '.srb-menuWrap{display:flex;flex-direction:column}',
      '.srb-menuSeparator{height:.5px;margin:3px 2px;background:var(--dsw-alias-border-l2)}',
      '.srb-menuItem{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;',
      'border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;',
      'font-size:13px;line-height:20px;text-align:left;color:var(--dsw-alias-label-primary)}',
      '.srb-menuItem.srb-danger{color:var(--dsw-alias-state-error-primary)}',
      '.srb-menuItem:hover:not(:disabled),.srb-menuItem:focus-visible:not(:disabled){',
      'background:var(--dsw-alias-interactive-bg-hover);outline:none}',
      '.srb-menuItem.srb-danger:hover:not(:disabled),.srb-menuItem.srb-danger:focus-visible:not(:disabled){',
      'background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover))}',
      '.srb-menuIcon{flex:none;display:inline-flex;align-items:center;color:inherit}',
      '.srb-menuLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    ].join('')

    const DIALOG_CSS = [
      BUTTON_CSS,
      '.srb-root{pointer-events:auto;position:fixed;inset:0;z-index:2000;display:flex;align-items:center;',
      'justify-content:center;padding:24px}',
      '.srb-mask{position:absolute;inset:0;backdrop-filter:var(--dsw-mask-blur)}',
      '.srb-mask::after{content:"";position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1)}',
      '.srb-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;',
      'width:min(440px,100%);padding:0 0 24px;overflow:hidden;border-radius:var(--dsw-radius-panel);',
      'background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary)}',
      '.srb-dialog:focus{outline:none}',
      '.srb-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}',
      '.srb-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.srb-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;',
      'border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;',
      'color:var(--dsw-alias-label-secondary)}',
      '.srb-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.srb-content{display:flex;flex-direction:column;min-width:0}',
      '.srb-description{margin:0;padding:0 24px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.srb-status{padding:12px 24px 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.srb-error{padding:12px 24px 0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
      '.srb-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}',
    ].join('')

    const PAGE_CSS = [
      BUTTON_CSS,
      '.srb-page{box-sizing:border-box;display:flex;flex-direction:column;gap:16px;width:100%;max-width:880px;',
      'padding:8px 0 32px;color:var(--dsw-alias-label-primary)}',
      '.srb-pageHead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}',
      '.srb-pageTitle{margin:0;font-size:16px;line-height:24px;font-weight:500}',
      '.srb-pageDesc{margin:6px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);max-width:60ch}',
      '.srb-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 10px;',
      'border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2)}',
      '.srb-spacer{flex:1 1 auto;min-width:8px}',
      '.srb-toolGroup{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.srb-toolGroupEnd{margin-left:auto}',
      '.srb-toolDivider{flex:none;width:.5px;height:18px;background:var(--dsw-alias-border-l2);margin:0 2px}',
      '.srb-muted{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.srb-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}',
      '.srb-check input{flex:0 0 auto;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:inherit}',
      '.srb-check input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,',
      'var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.srb-check:has(input:disabled){cursor:default;opacity:.5}',
      '.srb-rowCheck{flex:0 0 auto;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.srb-rowCheck:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,',
      'var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.srb-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow:hidden;',
      'background:var(--dsw-alias-bg-layer-1)}',
      '.srb-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-top:.5px solid var(--dsw-alias-border-l2);',
      'background:transparent;transition:background .12s ease}',
      '.srb-row:first-child{border-top:none}',
      '.srb-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.srb-rowMain{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}',
      '.srb-rowTitle{font-size:13px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;color:var(--dsw-alias-label-primary)}',
      '.srb-rowMeta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.srb-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;margin-left:6px;',
      'border-radius:999px;font-size:11px;line-height:18px;color:var(--dsw-alias-state-business-primary);',
      'background:var(--dsw-alias-interactive-bg-hover)}',
      '.srb-tagSub{display:inline-flex;align-items:center;height:18px;padding:0 6px;margin-left:6px;',
      'border-radius:999px;font-size:11px;line-height:18px;font-weight:400;',
      'color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.srb-rowConfirm{display:flex;flex-direction:column;gap:8px;margin-top:6px;padding:8px 10px;',
      'border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-state-error-primary)}',
      '.srb-rowConfirmText{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
      '.srb-rowConfirmActions{display:flex;align-items:center;justify-content:flex-end;gap:6px}',
      '.srb-rowActions{display:flex;align-items:center;gap:6px;flex:none}',
      '.srb-empty{margin:0;padding:24px 12px;text-align:center;font-size:13px;line-height:20px;',
      'color:var(--dsw-alias-label-secondary);border:.5px dashed var(--dsw-alias-border-l3);',
      'border-radius:var(--dsw-radius-md)}',
      '.srb-notice{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.srb-noticeError{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
      '.srb-confirm{display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border-radius:var(--dsw-radius-md);',
      'border:.5px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1)}',
      '.srb-confirmBody{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 auto}',
      '.srb-confirmTitle{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-state-error-primary)}',
      '.srb-confirmDesc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.srb-confirmActions{display:flex;align-items:center;gap:6px;flex:none}',
      '.srb-link{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
    ].join('')

    /* ------------------------------------------------------------- 图标 */

    function TrashIcon({ size = 14 }) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M2.5 4.2h11M6.2 2.2h3.6M4.2 4.2l.55 8.4a1.2 1.2 0 0 0 1.2 1.1h4.1a1.2 1.2 0 0 0 1.2-1.1l.55-8.4M6.7 6.6v5.2M9.3 6.6v5.2',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function CloseIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
      )
    }

    function RefreshIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M13.2 6.4A5.5 5.5 0 1 0 13.5 9',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M13.4 3.2v3.4H10',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function RestoreIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M6.4 4.2 3 7.6l3.4 3.4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M3.2 7.6h5.6a3.8 3.8 0 0 1 0 7.6H6.9',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /* ------------------------------------------------------------- 按钮 */

    /**
     * 官方 Button 原子的组件形态：`variant` 对应 `--dsw-alias-button-*` 填充族，
     * `size` 是 36px 的 md 与 28px 的 sm，`icon` 是可选的 16px 前导图标。
     * @param {{ variant?: 'primary'|'ghost'|'outline'|'toolbar', size?: 'md'|'sm',
     *   danger?: boolean, fill?: boolean, icon?: any, children?: any }} props
     */
    function SrbButton({ variant = 'ghost', size = 'md', danger = false, fill = false, icon = null, children, buttonRef = null, ...rest }) {
      const variantClass = variant === 'primary'
        ? 'srb-btnPrimary'
        : variant === 'outline'
          ? 'srb-btnOutline'
          : variant === 'toolbar'
            ? 'srb-btnToolbar'
            : 'srb-btnGhost'
      const className = [
        'srb-btn',
        variantClass,
        size === 'sm' ? 'srb-btnSm' : 'srb-btnMd',
        danger === true ? 'srb-btnDanger' : null,
        fill === true ? 'srb-btnDangerFill' : null,
      ].filter((part) => part !== null).join(' ')
      return h(
        'button',
        { type: 'button', className, ref: buttonRef, ...rest },
        icon === null ? null : h('span', { className: 'srb-btnIcon' }, icon),
        children,
      )
    }

    /* ----------------------------------------------------------- 宿主调用 */

    /** 解析出的路径前缀（`/api/...` 或 `/...`），首次成功后固定。 */
    let hostBase = null
    /** 模块级上下文（在 apply 中捕获），用于读宿主客户端服务。 */
    let runtimeCtx = null

    const HOST_BASES = [
      `/api/session-recycle-bin.`,
      `/session-recycle-bin.`,
    ]

    /**
     * 调用宿主半的一条路由；首次调用会探测两种路径前缀。
     * @param {string} name 路由名（list / archive / restore / purge / health）
     * @param {any} [body] POST 请求体
     * @param {'GET' | 'POST'} [method] 方法
     * @returns {Promise<any>}
     */
    async function callHost(name, body, method = 'POST') {
      const bases = hostBase === null ? HOST_BASES : [hostBase]
      let lastError = null
      for (const base of bases) {
        try {
          const response = await fetch(`${base}${name}`, {
            method,
            headers: {
              [GUARD_HEADER]: '1',
              ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            },
            ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
          })
          if (response.status === 404 && hostBase === null) {
            lastError = new Error('host-route-not-found')
            continue
          }
          const payload = await response.json().catch(() => null)
          if (payload === null || typeof payload !== 'object') throw new Error(`HTTP ${response.status}`)
          hostBase = base
          return payload
        } catch (error) {
          lastError = error
        }
      }
      throw lastError ?? new Error('host-unreachable')
    }

    /* ------------------------------------------------------------ 状态存储 */

    /** 待处理的确认请求；菜单项随菜单卸载，所以请求借住在这里。 */
    let pending = null
    const pendingListeners = new Set()

    function setPending(next) {
      pending = next
      for (const notify of [...pendingListeners]) notify()
    }

    function usePending() {
      const [, bump] = React.useReducer((count) => count + 1, 0)
      React.useEffect(() => {
        pendingListeners.add(bump)
        return () => {
          pendingListeners.delete(bump)
        }
      }, [])
      return pending
    }

    /** 回收站内容变化（归档/还原/永久删除）的订阅者，设置页据此自动刷新。 */
    const changeListeners = new Set()

    function notifyChanged() {
      for (const listener of [...changeListeners]) listener()
    }

    /* --------------------------------------------------------- 当前会话定位 */

    /** 从会话列表快照里读当前会话 id（头部 seat 不给 owner 值）。 */
    function currentSessionId() {
      const sessions = runtimeCtx?.get?.('sessions')
      try {
        const snapshot = sessions?.list?.getSnapshot?.()
        if (typeof snapshot?.current === 'string' && snapshot.current.length > 0) return snapshot.current
      } catch {
        /* 快照不可用时退回 undefined */
      }
      return undefined
    }

    /** 尽最大努力从 props 里取会话 id，最后退回当前会话。 */
    function resolveSessionId(props) {
      const candidates = [
        props?.sessionId,
        props?.session?.id,
        props?.session?.sessionId,
        props?.header?.id,
      ]
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 0) return candidate
      }
      return currentSessionId()
    }

    /** 归档后，如果主区域正停在那个会话上，回到空状态。 */
    function leaveArchivedView(sessionId) {
      const ui = runtimeCtx?.get?.('uiWorkspace')
      if (ui === undefined || ui === null) return
      try {
        if (ui.mainReference?.sessionId !== sessionId) return
        if (typeof ui.clearMain === 'function') ui.clearMain()
        else if (typeof ui.startSession === 'function') ui.startSession()
      } catch {
        /* 视图清理失败不影响归档结果 */
      }
    }

    /* ------------------------------------------------------------ 菜单行 */

    function DeleteSessionMenuItem(props) {
      const t = propsT(props)
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined
      const displayTitle = typeof props?.displayTitle === 'string' ? props.displayTitle : ''
      const useMenuOpenState = props?.useMenuOpenState
      const setMenuOpen = typeof useMenuOpenState === 'function' ? useMenuOpenState()[1] : undefined

      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, MENU_CSS),
        h(
          'div',
          { className: 'srb-menuWrap', key: 'row' },
          h('div', { className: 'srb-menuSeparator', role: 'separator' }),
          h(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              className: 'srb-menuItem srb-danger',
              disabled: sessionId === undefined,
              onClick: () => {
                if (sessionId === undefined) return
                setMenuOpen?.(false)
                setPending({ kind: 'archive', sessionId, displayTitle, source: 'menu' })
              },
            },
            h('span', { className: 'srb-menuIcon' }, h(TrashIcon, null)),
            h('span', { className: 'srb-menuLabel' }, t('menu.deleteSession')),
          ),
        ),
      )
    }

    /* --------------------------------------------------------- 会话头部按钮 */

    function DeleteSessionHeaderButton(props) {
      const t = propsT(props)
      const sessionId = resolveSessionId(props)
      const label = t('header.deleteTooltip')

      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, ICON_CSS),
        h(
          'button',
          {
            key: 'button',
            type: 'button',
            className: 'srb-iconButton srb-danger',
            title: label,
            'aria-label': label,
            disabled: sessionId === undefined,
            onClick: () => {
              if (sessionId === undefined) return
              setPending({ kind: 'archive', sessionId, displayTitle: '', source: 'header' })
            },
          },
          h(TrashIcon, { size: 15 }),
        ),
      )
    }

    /* -------------------------------------------------------------- 对话框 */

    /** 焦点进入对话框、Esc 关闭、Tab 循环与关闭后焦点归还。 */
    function useDialogFocus(dialogRef, busyRef, close) {
      React.useEffect(() => {
        const element = dialogRef.current
        if (element === null) return undefined
        const previous = document.activeElement
        element.focus()
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !event.shiftKey) {
            event.preventDefault()
            if (!busyRef.current) close()
            return
          }
          if (event.key !== 'Tab') return
          const focusable = element.querySelectorAll(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]',
          )
          if (focusable.length === 0) {
            event.preventDefault()
            element.focus()
            return
          }
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          if (previous instanceof HTMLElement && document.contains(previous)) previous.focus({ preventScroll: true })
        }
      }, [])
    }

    /** 对话框外壳：标题、内容、底部按钮。 */
    function DialogShell({ title, busy, busyText, error, result, children, buttons, onClose, dialogRef }) {
      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, DIALOG_CSS),
        h(
          'div',
          { className: 'srb-root', role: 'presentation', key: 'layer' },
          h('div', { className: 'srb-mask', 'aria-hidden': 'true', onClick: busy ? undefined : onClose }),
          h(
            'div',
            {
              ref: dialogRef,
              tabIndex: -1,
              className: 'srb-dialog',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': title,
            },
            h(
              'div',
              { className: 'srb-content' },
              h(
                'div',
                { className: 'srb-header' },
                h('h2', { className: 'srb-title' }, title),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'srb-close',
                    'aria-label': 'close',
                    disabled: busy,
                    onClick: onClose,
                  },
                  h(CloseIcon, null),
                ),
              ),
              children,
              busy ? h('div', { className: 'srb-status', role: 'status' }, busyText) : null,
              error === null ? null : h('div', { className: 'srb-error', role: 'alert' }, error),
              result === null ? null : h('p', { className: 'srb-description', style: { paddingTop: 12 } }, result),
            ),
            h('div', { className: 'srb-footer' }, buttons),
          ),
        ),
      )
    }

    /** 归档（软删除）确认框。 */
    function ArchiveDialog({ request, t }) {
      const dialogRef = React.useRef(null)
      const busyRef = React.useRef(false)
      const [busy, setBusy] = React.useState(false)
      const [stopping, setStopping] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [needsStop, setNeedsStop] = React.useState(false)
      const [done, setDone] = React.useState(false)
      busyRef.current = busy

      const close = () => {
        if (busyRef.current) return
        setPending(null)
      }
      useDialogFocus(dialogRef, busyRef, close)

      const title = t('confirm.title')
      const label = request.displayTitle !== '' ? request.displayTitle : request.sessionId
      const description = t('confirm.desc', { title: label })

      const archive = (stop) => {
        setBusy(true)
        setStopping(stop)
        setError(null)
        callHost('archive', { sessionId: request.sessionId, title: request.displayTitle, stop }, 'POST')
          .then((payload) => {
            setBusy(false)
            setStopping(false)
            if (payload.ok === true) {
              leaveArchivedView(request.sessionId)
              setDone(true)
              notifyChanged()
              setPending(null)
              return
            }
            if (payload.code === 'session-active') {
              setNeedsStop(true)
              setError(t('confirm.running'))
              return
            }
            setError(typeof payload.message === 'string' ? payload.message : t('confirm.failed', { message: payload.code ?? 'unknown' }))
          })
          .catch((reason) => {
            setBusy(false)
            setStopping(false)
            setError(t('confirm.failed', { message: reason instanceof Error ? reason.message : String(reason) }))
          })
      }

      return h(DialogShell, {
        title,
        busy,
        busyText: stopping ? t('confirm.stopping') : t('confirm.pending'),
        error,
        result: done ? t('confirm.done') : null,
        onClose: close,
        dialogRef,
        children: h('p', { className: 'srb-description' }, description),
        buttons: h(
          React.Fragment,
          null,
          h(SrbButton, { variant: 'outline', disabled: busy, onClick: close }, t('cancel')),
          needsStop
            ? h(
                SrbButton,
                { variant: 'outline', danger: true, disabled: busy, onClick: () => archive(true) },
                t('confirm.stopAndArchive'),
              )
            : h(
                SrbButton,
                { variant: 'outline', danger: true, disabled: busy, onClick: () => archive(false) },
                t('confirm.action'),
              ),
        ),
      })
    }

    /**
     * 设置页里的批量永久删除确认卡（多选 / 清空 / 按天清理）。
     *
     * 刻意**内联渲染**在设置页内容里，而不是 `shell.overlay` 浮层：设置面板本身是
     * 一个位于浮层之上的模态层，浮层里的对话框会被它挡住（实测）。内联卡片处在这
     * 个层里面，永远可见，也不依赖任何宿主的 z-index。
     * 单条会话的删除走行内确认（见 RowPurgeConfirm），不会用这张卡。
     */
    function PurgeConfirmCard({ request, t, busy, error, onCancel, onConfirm }) {
      const cardRef = React.useRef(null)
      const confirmRef = React.useRef(null)
      React.useEffect(() => {
        cardRef.current?.scrollIntoView?.({ block: 'nearest' })
        confirmRef.current?.focus?.()
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || busy) return
          event.preventDefault()
          onCancel()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [busy])

      const titles = Array.isArray(request.titles) ? request.titles.filter((title) => typeof title === 'string' && title.length > 0) : []
      const count = request.mode === 'ids' ? request.ids.length : (Number.isFinite(request.count) ? request.count : 0)
      const single = request.mode === 'ids' && count === 1 ? titles[0] : undefined
      const title = request.mode === 'all'
        ? t('purge.titleAll', { count })
        : request.mode === 'older'
          ? t('purge.titleOlder', { days: request.days })
          : single === undefined
            ? t('purge.title', { count })
            : t('purge.titleOne', { title: single })
      const description = request.mode === 'all'
        ? t('purge.descAll', { count })
        : request.mode === 'older'
          ? t('purge.descOlder', { days: request.days })
          : single === undefined
            ? t('purge.desc')
            : t('purge.descOne', { title: single })

      return h(
        'div',
        { ref: cardRef, className: 'srb-confirm', role: 'alertdialog', 'aria-label': title },
        h(
          'div',
          { className: 'srb-confirmBody' },
          h('div', { className: 'srb-confirmTitle' }, title),
          h('p', { className: 'srb-confirmDesc' }, description),
          error === null ? null : h('p', { className: 'srb-noticeError', role: 'alert' }, error),
        ),
        h(
          'div',
          { className: 'srb-confirmActions' },
          h(SrbButton, { variant: 'ghost', size: 'sm', disabled: busy, onClick: onCancel }, t('cancel')),
          h(
            SrbButton,
            {
              variant: 'outline',
              size: 'sm',
              danger: true,
              icon: h(TrashIcon, { size: 14 }),
              disabled: busy,
              onClick: onConfirm,
              buttonRef: confirmRef,
            },
            busy ? t('purge.pending') : t('purge.action'),
          ),
        ),
      )
    }

    /**
     * 行内确认卡：只删一条会话时使用。目标标题就在这一行里，
     * 不移动页面布局、不把列表推走，也不会误删成别的行。
     */
    function RowPurgeConfirm({ entry, t, busy, onCancel, onConfirm }) {
      const confirmRef = React.useRef(null)
      React.useEffect(() => {
        confirmRef.current?.focus?.()
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || busy) return
          event.preventDefault()
          onCancel()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [busy])

      const description = entry.subagentCount > 0
        ? t('row.confirmDesc', { count: entry.subagentCount })
        : t('row.confirmDescNoSub')

      return h(
        'div',
        { className: 'srb-rowConfirm', role: 'alertdialog', 'aria-label': t('row.confirmTitle', { title: entry.title }) },
        h('p', { className: 'srb-rowConfirmText' }, t('row.confirmTitle', { title: entry.title })),
        h('p', { className: 'srb-confirmDesc' }, description),
        h(
          'div',
          { className: 'srb-rowConfirmActions' },
          h(SrbButton, { variant: 'ghost', size: 'sm', disabled: busy, onClick: onCancel }, t('cancel')),
          h(
            SrbButton,
            {
              variant: 'outline',
              size: 'sm',
              danger: true,
              icon: h(TrashIcon, { size: 14 }),
              disabled: busy,
              onClick: onConfirm,
              buttonRef: confirmRef,
            },
            busy ? t('purge.pending') : t('purge.action'),
          ),
        ),
      )
    }

    /** 浮层入口：只负责「删除会话」的归档确认（该上下文里浮层位于最上层）。 */
    function RecycleBinOverlay(props) {
      const t = propsT(props)
      const request = usePending()
      if (request === null || request.kind !== 'archive') return null
      return h(ArchiveDialog, { key: `archive:${request.sessionId}`, request, t })
    }

    /* ------------------------------------------------------------- 设置页 */

    function RecycleBinSettingsPage(props) {
      const t = propsT(props)
      const [state, setState] = React.useState({ phase: 'loading', entries: [], totalBytes: 0, home: null, locator: null, error: null })
      const [selected, setSelected] = React.useState(() => new Set())
      const [notice, setNotice] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [confirm, setConfirm] = React.useState(null)
      const [rowConfirm, setRowConfirm] = React.useState(null)
      const [purgeError, setPurgeError] = React.useState(null)
      const [purging, setPurging] = React.useState(false)
      const aliveRef = React.useRef(true)

      const reload = React.useCallback(() => {
        callHost('list', undefined, 'GET')
          .then((payload) => {
            if (!aliveRef.current) return
            if (payload.ok !== true) {
              setState({ phase: 'error', entries: [], totalBytes: 0, home: null, error: payload.message ?? payload.code ?? 'error' })
              return
            }
            const entries = Array.isArray(payload.entries) ? payload.entries : []
            setState({ phase: 'ready', entries, totalBytes: payload.totalBytes ?? 0, home: payload.home ?? null, locator: payload.locator ?? null, error: null })
            setSelected((previous) => {
              const next = new Set()
              for (const id of previous) if (entries.some((entry) => entry.id === id)) next.add(id)
              return next
            })
          })
          .catch((reason) => {
            if (!aliveRef.current) return
            setState({ phase: 'error', entries: [], totalBytes: 0, home: null, error: reason instanceof Error ? reason.message : String(reason) })
          })
      }, [])

      React.useEffect(() => {
        aliveRef.current = true
        reload()
        return () => {
          aliveRef.current = false
        }
      }, [reload])

      React.useEffect(() => {
        const listener = () => reload()
        changeListeners.add(listener)
        return () => {
          changeListeners.delete(listener)
        }
      }, [reload])

      const entries = state.entries
      const allSelected = entries.length > 0 && entries.every((entry) => selected.has(entry.id))
      const selectedIds = [...selected]

      const toggle = (id) => {
        setSelected((previous) => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      const toggleAll = () => {
        setSelected(allSelected ? new Set() : new Set(entries.map((entry) => entry.id)))
      }

      const restore = (ids) => {
        if (ids.length === 0) return
        setBusy(true)
        setError(null)
        callHost('restore', { sessionIds: ids }, 'POST')
          .then((payload) => {
            setBusy(false)
            if (payload.ok !== true) {
              setError(t('page.restoreFailed', { message: payload.message ?? payload.code ?? 'error' }))
              return
            }
            const results = Array.isArray(payload.results) ? payload.results : []
            const failed = results.filter((entry) => entry.ok !== true)
            setNotice(t('page.restored', { count: results.length - failed.length }))
            if (failed.length > 0) setError(t('page.restoreFailed', { message: failed.map((entry) => entry.id).join('、') }))
            setSelected(new Set())
            reload()
          })
          .catch((reason) => {
            setBusy(false)
            setError(t('page.restoreFailed', { message: reason instanceof Error ? reason.message : String(reason) }))
          })
      }

      /** 打开批量 / 清空 / 按天清理的顶部确认卡。 */
      const requestPurge = (request) => {
        setRowConfirm(null)
        setPurgeError(null)
        setConfirm(request)
      }

      /** 打开单条会话的行内确认（目标标题就在该行里）。 */
      const requestRowPurge = (entry) => {
        setConfirm(null)
        setPurgeError(null)
        setRowConfirm(entry)
      }

      /** 取消当前确认；执行中不允许取消。 */
      const cancelConfirm = () => {
        if (purging) return
        setConfirm(null)
        setRowConfirm(null)
        setPurgeError(null)
      }

      /**
       * 执行永久删除。
       * @param {{ mode: 'ids' | 'all' | 'older', ids?: string[], days?: number, titles?: string[] }} target
       */
      const runPurge = (target) => {
        const request = target
        if (request === null || request === undefined || purging) return
        setPurging(true)
        setPurgeError(null)
        const body = request.mode === 'ids'
          ? { sessionIds: request.ids }
          : request.mode === 'older'
            ? { all: true, olderThanDays: request.days }
            : { all: true }
        callHost('purge', body, 'POST')
          .then((payload) => {
            setPurging(false)
            if (payload.ok !== true) {
              setPurgeError(typeof payload.message === 'string' ? payload.message : t('confirm.failed', { message: payload.code ?? 'unknown' }))
              return
            }
            const results = Array.isArray(payload.results) ? payload.results : []
            const failed = results.filter((entry) => entry.ok !== true)
            const skippedUnknownAge = Number.isFinite(payload.skipped?.unknownAge) ? payload.skipped.unknownAge : 0
            setConfirm(null)
            setRowConfirm(null)
            setSelected(new Set())
            if (failed.length > 0) {
              setNotice(null)
              setError(t('purge.partial', { count: failed.length, ids: failed.map((entry) => entry.id).join('、') }))
            } else {
              setError(null)
              const done = t('purge.done', { count: results.length, size: formatBytes(payload.purgedBytes ?? 0) })
              setNotice(skippedUnknownAge > 0 ? `${done} ${t('purge.skippedUnknown', { count: skippedUnknownAge })}` : done)
            }
            notifyChanged()
            reload()
          })
          .catch((reason) => {
            setPurging(false)
            setPurgeError(t('confirm.failed', { message: reason instanceof Error ? reason.message : String(reason) }))
          })
      }

      const row = (entry) => {
        const checked = selected.has(entry.id)
        const confirming = rowConfirm !== null && rowConfirm.id === entry.id
        /* 任何确认打开或正在删除时，其它行的操作都锁住，避免确认目标被静默换掉。 */
        const locked = busy || purging || confirm !== null || (rowConfirm !== null && !confirming)
        const meta = [
          entry.workspacePath === null ? null : shortenPath(entry.workspacePath),
          entry.deletedAt === null ? t('page.unknownTime') : formatTime(entry.deletedAt),
          entry.logBytes > 0 ? formatBytes(entry.logBytes) : t('page.noLog'),
        ].filter((part) => part !== null).join(' · ')
        return h(
          'li',
          { key: entry.id, className: 'srb-row' },
          confirming
            ? null
            : h('input', {
                type: 'checkbox',
                className: 'srb-rowCheck',
                checked,
                'aria-label': entry.title,
                onChange: () => toggle(entry.id),
              }),
          h(
            'div',
            { className: 'srb-rowMain' },
            h(
              'span',
              { className: 'srb-rowTitle', title: entry.title },
              entry.title,
              entry.running === true ? h('span', { className: 'srb-tag' }, t('page.running')) : null,
              entry.subagentCount > 0
                ? h('span', { className: 'srb-tagSub' }, t('page.subagents', { count: entry.subagentCount }))
                : null,
            ),
            h('span', { className: 'srb-rowMeta', title: meta }, meta),
            confirming
              ? h(RowPurgeConfirm, {
                  entry,
                  t,
                  busy: purging,
                  onCancel: cancelConfirm,
                  onConfirm: () => runPurge({ mode: 'ids', ids: [entry.id], titles: [entry.title] }),
                })
              : null,
          ),
          confirming
            ? null
            : h(
                'div',
                { className: 'srb-rowActions' },
                h(
                  SrbButton,
                  {
                    variant: 'outline',
                    size: 'sm',
                    icon: h(RestoreIcon, null),
                    disabled: locked,
                    onClick: () => restore([entry.id]),
                  },
                  t('page.restore'),
                ),
                h(
                  SrbButton,
                  {
                    variant: 'outline',
                    size: 'sm',
                    danger: true,
                    icon: h(TrashIcon, { size: 14 }),
                    disabled: locked,
                    onClick: () => requestRowPurge(entry),
                  },
                  t('page.purge'),
                ),
              ),
        )
      }

      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, PAGE_CSS),
        h(
          'section',
          { className: 'srb-page', key: 'page', 'aria-label': t('page.title') },
          h(
            'div',
            { className: 'srb-pageHead' },
            h(
              'div',
              null,
              h('h2', { className: 'srb-pageTitle' }, t('page.title')),
              h('p', { className: 'srb-pageDesc' }, t('page.desc')),
            ),
            h(
              SrbButton,
              {
                variant: 'outline',
                size: 'sm',
                icon: h(RefreshIcon, null),
                disabled: busy,
                onClick: reload,
                'aria-label': t('page.refresh'),
              },
              t('page.refresh'),
            ),
          ),
          confirm === null
            ? null
            : h(PurgeConfirmCard, {
                request: confirm,
                t,
                busy: purging,
                error: purgeError,
                onCancel: cancelConfirm,
                onConfirm: () => runPurge(confirm),
              }),
          state.phase === 'loading' ? h('p', { className: 'srb-notice' }, t('page.loading')) : null,
          state.phase === 'error'
            ? h('p', { className: 'srb-noticeError' }, t('page.failed', { message: state.error ?? 'error' }))
            : null,
          state.phase === 'ready'
            ? h(
                'div',
                { className: 'srb-toolbar' },
                h(
                  'label',
                  { className: 'srb-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: allSelected,
                    onChange: toggleAll,
                    disabled: entries.length === 0 || busy || purging || confirm !== null || rowConfirm !== null,
                  }),
                  t('page.selectAll'),
                ),
                h(
                  'span',
                  { className: 'srb-muted' },
                  selectedIds.length > 0
                    ? t('page.selected', { count: selectedIds.length })
                    : t('page.count', { count: entries.length, size: formatBytes(state.totalBytes) }),
                ),
                h('span', { className: 'srb-spacer' }),
                h(
                  'span',
                  { className: 'srb-toolGroup' },
                  h(
                    SrbButton,
                    {
                      variant: 'outline',
                      size: 'sm',
                      icon: h(RestoreIcon, null),
                      disabled: busy || purging || selectedIds.length === 0 || confirm !== null || rowConfirm !== null,
                      onClick: () => restore(selectedIds),
                    },
                    busy ? t('page.restoring') : t('page.restore'),
                  ),
                  h(
                    SrbButton,
                    {
                      variant: 'outline',
                      size: 'sm',
                      danger: true,
                      icon: h(TrashIcon, { size: 14 }),
                      disabled: busy || purging || selectedIds.length === 0 || confirm !== null || rowConfirm !== null,
                      onClick: () => requestPurge({
                        mode: 'ids',
                        ids: selectedIds,
                        titles: entries.filter((entry) => selected.has(entry.id)).map((entry) => entry.title),
                      }),
                    },
                    t('page.purge'),
                  ),
                ),
                h('span', { className: 'srb-toolDivider' }),
                h(
                  'span',
                  { className: 'srb-toolGroup' },
                  h(
                    SrbButton,
                    {
                      variant: 'ghost',
                      size: 'sm',
                      danger: true,
                      disabled: busy || purging || entries.length === 0 || confirm !== null || rowConfirm !== null,
                      onClick: () => requestPurge({ mode: 'older', days: RETENTION_DAYS }),
                    },
                    t('page.purgeOlder'),
                  ),
                  h(
                    SrbButton,
                    {
                      variant: 'ghost',
                      size: 'sm',
                      danger: true,
                      disabled: busy || purging || entries.length === 0 || confirm !== null || rowConfirm !== null,
                      onClick: () => requestPurge({ mode: 'all', count: entries.length }),
                    },
                    t('page.emptyBin'),
                  ),
                ),
              )
            : null,
          notice === null ? null : h('p', { className: 'srb-notice', role: 'status' }, notice),
          error === null ? null : h('p', { className: 'srb-noticeError', role: 'alert' }, error),
          state.phase === 'ready'
            ? entries.length === 0
              ? h('p', { className: 'srb-empty' }, t('page.empty'))
              : h('ul', { className: 'srb-list' }, entries.map(row))
            : null,
          state.home === null
            ? null
            : h(
                'p',
                {
                  className: 'srb-link',
                  title: state.locator === null
                    ? undefined
                    : t('page.locatorTag', {
                        mode: state.locator === 'backend-locate' ? t('page.locatorBackend') : t('page.locatorScan'),
                      }),
                },
                t('page.location', { path: state.home }),
              ),
        ),
      )
    }

    /* ------------------------------------------------------------- 格式化 */

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
    }

    function formatTime(iso) {
      const at = Date.parse(iso)
      if (!Number.isFinite(at)) return iso
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function shortenPath(path) {
      if (typeof path !== 'string' || path.length === 0) return ''
      const parts = path.split(/[\\/]+/).filter((part) => part.length > 0)
      if (parts.length <= 2) return path
      return `…${'\\'}${parts.slice(-2).join('\\')}`
    }

    /* -------------------------------------------------------------- 插件 */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        runtimeCtx = ctx
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'session-recycle-bin: dictionaries')

        /** 设置页分区名：locale 服务可用时随界面语言变化。 */
        const boundT = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : fallbackText

        ctx.slots.inject(MENU_SLOT, () =>
          ctx.slots.register(
            { name: MENU_SLOT, id: 'session-recycle-bin-delete', order: DELETE_ORDER, locale: NS },
            DeleteSessionMenuItem,
          ),
        )

        ctx.slots.inject(HEADER_SLOT, () =>
          ctx.slots.register(
            { name: HEADER_SLOT, id: 'session-recycle-bin-trash', order: HEADER_ORDER, locale: NS },
            DeleteSessionHeaderButton,
          ),
        )

        ctx.slots.inject(OVERLAY_SLOT, () =>
          ctx.slots.register({ name: OVERLAY_SLOT, id: 'session-recycle-bin', order: 60, locale: NS }, RecycleBinOverlay),
        )

        ctx.slots.inject(SETTINGS_SLOT, () =>
          ctx.slots.register(
            {
              name: SETTINGS_SLOT,
              id: 'session-recycle-bin',
              order: SETTINGS_ORDER,
              label: () => boundT('page.navLabel'),
              locale: NS,
            },
            RecycleBinSettingsPage,
          ),
        )
      },
    }
  },
})
