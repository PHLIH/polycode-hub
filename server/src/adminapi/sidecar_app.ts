// sidecar 管理面的后端接线：把 sidecar 包暴露为 /admin/api/sidecar/*（薄适配，
// 对齐 Go internal/adminapi/sidecar_api.go）。以 Hono 子应用注入 createAdminApi。

import { existsSync } from 'node:fs'
import { Hono, type Context } from 'hono'
import { SidecarCancelledError, validatePort, type FetchLike, type Sidecar, type SidecarPhase } from '../sidecar/sidecar.ts'
import { maskProxyURI, resolveSidecarDownloadFetch } from '../sidecar/httpproxy.ts'

// sidecar 只关心「zcode-plan-local」这一个 Provider 的 baseUrl 与 egress 引用，
// 按对外名查（名字比内部 id 更适合这类固定目标）。
export interface SidecarStoreAdapter {
  getByName(name: string): { baseUrl?: string; egress?: string } | undefined
  put(p: { baseUrl?: string; egress?: string }): void
}

// 顶层 egress 定义（下载代理的来源之一）：与 adminapi/store.EgressStore.list()
// 同形，这里只声明用得到的字段，避免 adminapi 反向依赖 store 的实现细节。
export interface SidecarEgressLister {
  list(): { id: string; kind: string; addr: string }[]
}

function err(c: Context, status: 400 | 404 | 500, msg: string): Response {
  return c.json({ error: { type: status === 404 ? 'not_found_error' : status === 400 ? 'invalid_request_error' : 'api_error', message: msg } }, status)
}

// isLoopbackHost：自定义引擎地址只允许指向本机。
function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true
  // 仅识别 IPv4/IPv6 回环字面量（127./::1，Go net.ParseIP + IsLoopback 的常见子集）
  return /^(127\.|::1$)/.test(host)
}

// sidecarInstalled 判定二进制是否已落地。
//
// 复用 Sidecar.findBinary 而不是自己拼路径：它按 binName（Windows 带 .exe）
// 查 workDir → sidecarDir → binDir，与 install 落地的名字同一口径。
// 历史缺陷：这里曾经独立硬编码 `${dir}/zcode-proxy`，于是在 Windows 上装完
// 也永远报 installed:false——页面一直显示「未安装 —— 一键下载官方引擎…」，
// 引擎停下时永远回不到「已安装，未运行」。与 sidecar.ts 里那批 .exe 缺陷同源，
// 当时漏改了这一处。
function sidecarInstalled(s: Sidecar): boolean {
  try {
    s.findBinary(s.workDir)
    return true
  } catch {
    return false
  }
}

// —— 安装作业态：服务端才是「安装中」的唯一真相源 ——
//
// 前端原来把 busy 存在组件 ref 里，而 App.vue 用的是没有 keep-alive 的
// <component :is>，每次切页都卸载重建 → 状态归零。后果有两层：
//   1. 页面显示「一键安装」，而服务端其实还在下载（普通 fetch 不随组件卸载 abort）；
//   2. 用户再点一次就发出第二个 POST /ensure，两个 ensureReady 并发下载，
//      而半成品路径是固定的 dest+'.part'，两个流写同一个文件会互相踩踏。
// 所以进度与阶段记在这里，GET / 对外暴露，POST /ensure 遇到在跑的任务直接复用。
interface InstallJob {
  running: boolean
  phase: SidecarPhase
  received: number
  total: number
  startedAt: number
  finishedAt: number
  ok: boolean
  error: string
  proxy: string // 本次尝试实际使用的下载代理（已脱敏）
  proxySource: string
  // cancelled 用户主动取消/暂停（不是失败）。前端据此不渲染成红报错；
  // 「已暂停/已取消」的确认提示由 pause/cancel 动作就地给出。
  cancelled?: boolean
  promise: Promise<void> | null
}

function idleJob(): InstallJob {
  return {
    running: false, phase: 'resolving', received: 0, total: 0,
    startedAt: 0, finishedAt: 0, ok: false, error: '',
    proxy: '', proxySource: '', promise: null,
  }
}

// shouldReuseLogin 按「有没有在飞的**同 provider** 会话」决定复用还是开新。
//
// 从 startLogin 里抽成纯函数，是为了让测试能直接锁住判定规则本身——而不是像
// 之前那样在测试里重新实现一个 mock（mock 与生产实现各说各话，变异测试
// 根本拦不住 regression，上一个提交就犯了这个错）。
//
// urlValue 是会话最终给出的授权链接：undefined = 还没定型（正常在飞），
// '' = beginLogin 的 15 秒竞速已判空（引擎迟迟没打印 URL）。后者是**死会话**：
// 复用它只会永远返回空链接（用户在引擎等授权的 5 分钟里点多少次都是同一个
// 「未能取得授权链接」），必须放行去 kill 旧会话、开新的（子代理审查抓到的 P2）。
export type LoginWant = 'zai' | 'bigmodel'
export function shouldReuseLogin(
  session: { provider: string; urlValue?: string } | null,
  want: LoginWant,
): boolean {
  return session !== null && session.provider === want && session.urlValue !== ''
}

export function createSidecarApp(
  svc: Sidecar,
  providers: SidecarStoreAdapter,
  changed: () => void,
  fetchImpl: typeof fetch = fetch,
  egresses?: SidecarEgressLister,
): Hono {
  const app = new Hono()
  const dir = () => svc.workDir
  let job: InstallJob = idleJob()

  // downloadProxy 决议本次下载用的代理（复用项目 egress 配置，不写死地址）：
  // 优先 zcode-plan-local Provider 的 egress 引用 → 仅一项时自动采用 → 环境变量
  // → darwin scutil / windows 注册表读系统代理 → 直连。egress 表来自管理面注入
  // （DB 真相源）。
  // 显式 ?egress=<id> 由「必须命中」的语义决定（不存在就报错，不静默换出口）。
  function downloadProxy(egressId = ''): { proxyURI: string | null; source: string; fetch: FetchLike } {
    const p = providers.getByName('zcode-plan-local')
    return resolveSidecarDownloadFetch({
      egressId,
      providerEgressId: p?.egress ?? '',
      egressList: egresses?.list() ?? [],
    })
  }

  // ensureJob 启动（或复用）一次安装作业。
  // 返回值就是该次安装的 promise：并发的第二个请求拿到同一个 promise，
  // 因此只会下载一次（响应结构与以前完全一致，只是不再重复起第二次下载）。
  //
  // 暂停 vs 取消（用户明确区分，此前两者混为一谈）：
  //   · 暂停 pause  —— 停止本次下载，**保留 .part**，下次点安装从断点续传。
  //   · 取消 cancel —— 停止并**删除 .part**，下次从 0 开始（干净重来）。
  // 以前只有一个「取消」且实际是暂停语义，用户点了却保留半截文件，名不副实。
  let jobAbort: AbortController | null = null

  function pauseJob(): boolean {
    if (!job.running || jobAbort === null) return false
    jobAbort.abort()
    return true
  }

  // cancelJob 比暂停多一步：把已下的一半删掉。
  //
  // 顺序很重要：先 abort，再**等作业真正收尾**，最后才删。
  // 旧实现 abort 之后立刻同步删除。在 Windows 上，正在被写入的 .part 会因文件
  // 被占用而 unlink 失败（EPERM），而 discardPartial 静默吞异常——接口照样回
  // cancelled:true、日志照样打「清除半成品 0 字节」，文件却还在，下次安装又带着
  // Range 从一半续起，正是这个 commit 声称修好的现象。先等收尾（fd 已关）再删，
  // 就没有这个窗口了。
  async function cancelJob(): Promise<boolean> {
    if (!job.running || jobAbort === null) return false
    jobAbort.abort()
    // 等作业 promise 落定：下载循环观察到 abort 后会退出并关闭 fd。
    // catch 兜住取消本身引起的 reject——取消路径不关心作业成败。
    if (job.promise !== null) await job.promise.catch(() => {})
    const removed = svc.discardPartial(dir())
    console.log(`sidecar: 已取消安装，清除半成品 ${removed} 字节（下次从 0 开始）`)
    return true
  }

  // 登录流程：网页点「登录授权」→ 后端拉起引擎 OAuth → 拿到 URL 回给前端，
  // 前端把它展示成兜底链接（引擎 4.6.8 起自己会弹默认浏览器，网页绝不能再
  // window.open 一次——那正是「点一次登录弹两个一模一样的授权页」的来源）。
  //
  // 用户原话：「为啥不能手动弹出登录界面呢？」——以前只有 CLI 一条路
  // （`polycode-hub zcode sidecar login`），管理台上除了报错文案里的那句
  // 指引什么都没有，登录这一步等于把用户赶出网页。
  //
  // 真实缺陷（用户报告「我点一次授权登入你给我开两个一样的窗口」）：
  // 这里原先是 `finally { loginPending = null }` —— URL 一拿到（约 0.2 秒）就把
  // 守卫清掉了，**而 OAuth 会话本身要活 5 分钟**。于是两次点击之间只要隔了 0.2 秒
  // 以上，就会各自起一个引擎进程、各自开一个窗口（实测连点 3 次 = 3 个
  // zcode-proxy 进程、3 个不同的 state）。两个窗口看起来一模一样，但只有最后一个
  // 的会话是「活的」——这正是用户看到的「两个一样的窗口」。
  //
  // 修法：把「刚拿到 URL」和「会话结束」分开。会话在飞（尚未授权完成）期间一律复用，
  // 只有引擎进程真的退出（授权成功/超时）才允许开下一次。
  interface LoginSession { url: Promise<string>; done: Promise<number>; provider: string; child?: { kill: () => void }; urlValue?: string }
  let loginSession: LoginSession | null = null

  function startLogin(provider?: string): Promise<{ url: string; provider: string }> {
    // provider 可由前端指定（网页上给 z.ai / 智谱二选一）；不指定就按本机
    // ZCode 客户端里实际登录的那个猜，省得用户自己判断该点哪个。
    const want = provider === 'zai' || provider === 'bigmodel' ? provider : svc.detectProvider()
    // 复用**仅限同一个 provider**，且会话必须是活的（urlValue !== ''）。
    //
    // 真实缺陷（用户报告「你只修好了 zai 的，bigmodel 也有这个问题」）：
    // 守卫只看「有没有会话在飞」，不看是哪个 provider。于是用户把下拉切到
    // bigmodel 再点，服务端仍把上一轮 zai 的链接原样返回 —— 界面显示选了智谱，
    // 拿到的却是 z.ai 的授权页（服务端还挺诚实地回 provider=zai），
    // 用户对着错误的页面登录，怎么登都不对。
    // 换 provider 是有意的行为，必须开新会话；只有**同一个** provider 才复用。
    // 判定规则在 shouldReuseLogin 里（导出供测试直接锁住，而不是在测试里重写 mock）。
    if (shouldReuseLogin(loginSession, want)) {
      const s = loginSession as LoginSession
      return s.url.then((u) => ({ url: u, provider: s.provider }))
    }
    // 换了 provider（或旧会话已判死）：先把上一个会话结束掉。不杀的话它会
    // 活满 5 分钟，留着白占进程、还可能抢写同一份凭据。
    if (loginSession !== null) {
      try { loginSession.child?.kill() } catch { /* 已经退了 */ }
      loginSession = null
    }
    const { url, done, child } = svc.beginLogin(dir(), want)
    const session: LoginSession = { url, done, provider: want, child }
    loginSession = session
    // urlValue 记录这个会话最终给出的链接（见 shouldReuseLogin）：15 秒竞速
    // 判空即标记死会话，后续点击不再复用。
    void url.then((u) => { if (loginSession === session) session.urlValue = u })
    // 引擎进程退出（授权成功 / 5 分钟超时 / 被杀）才释放守卫 —— 不是 URL 一拿到就放。
    const clear = (): void => { if (loginSession === session) loginSession = null }
    void done.then(clear, clear)
    return url.then((u) => ({ url: u, provider: want }))
  }

  function ensureJob(dl: ReturnType<typeof downloadProxy>): Promise<void> {
    if (job.running && job.promise !== null) return job.promise
    const ac = new AbortController()
    jobAbort = ac
    const cur: InstallJob = {
      running: true, phase: 'resolving', received: 0, total: 0,
      startedAt: Date.now(), finishedAt: 0, ok: false, error: '',
      proxy: maskProxyURI(dl.proxyURI), proxySource: dl.source, promise: null,
    }
    job = cur
    const p = (async () => {
      try {
        await svc.ensureReady(dir(), {
          fetch: dl.fetch,
          proxySource: dl.source,
          signal: ac.signal,
          onProgress: (pr) => {
            // 只写当前作业：上一轮的延迟回调万一晚到，不能污染新一轮的进度。
            if (job !== cur) return
            cur.phase = pr.phase
            cur.received = pr.received
            cur.total = pr.total
          },
        })
        cur.ok = true
      } catch (e) {
        // 取消不是失败：标记成 cancelled，页面不渲染成红报错（暂停/取消各自的
        // 确认提示由动作就地给出）。判定优先认 SidecarCancelledError——生产代码
        // 所有主动取消路径都抛它；aborted + AbortError 只是兜底。不能只看
        // ac.signal.aborted：用户刚点完暂停、紧接着下载因「摘要不匹配」等真实
        // 原因失败时，错误会被吞成「已取消」，真实故障对用户隐身。
        if (e instanceof SidecarCancelledError) {
          cur.cancelled = true
          cur.error = ''
        } else if (ac.signal.aborted === true && (e as Error).name === 'AbortError') {
          cur.cancelled = true
          cur.error = ''
        } else {
          cur.error = (e as Error).message
        }
        throw e
      } finally {
        cur.running = false
        cur.finishedAt = Date.now()
        if (jobAbort === ac) jobAbort = null
      }
    })()
    cur.promise = p
    // 未处理的拒绝会冒泡成 unhandledRejection（HTTP 层已经在 err() 里回过 500）。
    p.catch(() => {})
    return p
  }

  // GET / → 状态 + 安装/配置信息。
  app.get('/', async (c) => {
    const p = providers.getByName('zcode-plan-local')
    const endpoint = p?.baseUrl ?? ''
    const builtin = `http://127.0.0.1:${svc.port}`
    // 下载会走哪个代理（脱敏）：前端据此显示「下载走 clash（127.0.0.1:7897）」，
    // 让「装了老半天」有个可解释的出处，而不是一个转圈。
    const dl = downloadProxy()
    return c.json({
      running: await svc.running(),
      status: await svc.status(),
      installed: sidecarInstalled(svc),
      port: svc.port,
      workDir: dir(),
      credFile: svc.credKey,
      hasKey: existsSync(svc.credKey),
      endpoint,
      custom: endpoint !== '' && endpoint !== builtin,
      downloadProxy: maskProxyURI(dl.proxyURI),
      downloadProxySource: dl.source,
      // install 是「当前 / 最近一次」安装的作业态。running=true 时前端画进度条；
      // 结束后保留 ok/error，切页或刷新回来的用户仍能看到结果与处置建议，
      // 而不是只错过一个已经消失的 toast。
      install: {
        running: job.running,
        phase: job.phase,
        received: job.received,
        total: job.total,
        startedAt: job.startedAt,
        elapsedMs: job.startedAt === 0 ? 0
          : (job.running ? Date.now() : job.finishedAt) - job.startedAt,
        ok: job.ok,
        error: job.error,
        cancelled: job.cancelled === true,
        downloadProxy: job.proxy,
        downloadProxySource: job.proxySource,
      },
    })
  })

  // POST /{action} → start|stop|login|pause|cancel|setup|uninstall|ensure|port|endpoint。
  // install 涉及交互式下载指引，仍走 CLI（页面上给指引），不进 HTTP。
  app.post('/:action', async (c) => {
    const action = c.req.param('action')
    switch (action) {
      case 'start':
        try { await svc.start(dir()) } catch (e) { return err(c, 500, '启动失败: ' + (e as Error).message) }
        return c.json({ ok: true, status: await svc.status() })
      case 'stop':
        try { await svc.stop() } catch (e) { return err(c, 500, '停止失败: ' + (e as Error).message) }
        return c.json({ ok: true, status: await svc.status() })
      case 'login':
        // 登录授权：返回引擎给的 OAuth 授权链接。引擎自己会弹默认浏览器，
        // 前端只把链接当「没弹出来时的兜底入口」展示，不自动打开。
        // 不在这里 await「用户授权完成」——那要几分钟，HTTP 请求挂不住；
        // 由前端在用户授权后自行点「启动」验证结果。
        // ?provider=zai|bigmodel 可选；不传就按本机客户端已登录的那个猜。
        try {
          const q = c.req.query('provider')
          const { url, provider } = await startLogin(q)
          if (url === '') {
            return err(c, 500, `未能取得授权链接（provider=${provider}；引擎未输出 OAuth 地址，或未安装引擎）。`)
          }
          return c.json({ ok: true, url, provider })
        } catch (e) {
          return err(c, 500, '登录失败: ' + (e as Error).message)
        }
      case 'pause':
        // 暂停：停止本次下载，**保留**已下的部分，下次点安装从断点续传。
        // 幂等：没有在跑的作业时返回 paused=false（用户连点不该报错）。
        return c.json({ ok: true, paused: pauseJob() })
      case 'cancel':
        // 取消：停止并**删除**已下的半成品，下次从 0 开始。
        // 与 pause 的唯一区别就是这个删除动作。
        //
        // 历史 bug（本函数第一版就踩了）：这里曾写成
        //   case 'cancel':
        //   case 'pause':
        // 于是 'cancel' 直接落进 pause 分支、永远走不到删除逻辑——「取消」
        // 实际只做了暂停，.part 一直留着，用户取消后仍从一半续传（正是用户
        // 反馈的现象）。相邻的 case 必须各带各的 return，不能 fall-through。
        return c.json({ ok: true, cancelled: await cancelJob() })
      case 'setup': {
        let key: string
        try { key = svc.setupConfig(dir()) } catch (e) { return err(c, 500, '配置失败: ' + (e as Error).message) }
        // key 不回显全文（凭据红线）：只告知前缀
        return c.json({ ok: true,
          message: '已生成安全配置与随机 key（落 config/credentials/zcode-proxy-key，0600）',
          keyPrefix: key.slice(0, 12) + '…' })
      }
      case 'uninstall': {
        // 危险操作：必须显式确认 + 是否连工作目录（config/日志）一起清
        if (c.req.query('confirm') !== 'true') {
          return err(c, 400, '卸载需确认：加 ?confirm=true（可选 &removeWorkDir=true 连配置/日志一起清）')
        }
        try {
          const removed = await svc.uninstall(c.req.query('removeWorkDir') === 'true')
          return c.json({ ok: true, removed })
        } catch (e) {
          return err(c, 500, '卸载失败: ' + (e as Error).message)
        }
      }
      case 'ensure': {
        // ensure 需要下载二进制（可能耗时），宽限 5 分钟。
        // 下载走代理（复用项目 egress 配置）：以前这里用全局 fetch 直连，
        // 国内网络下 github release（~66MB）几乎必然超时，页面只能一直转
        // 「安装中…（首次需下载）」——真实缺陷。
        // 可加 ?egress=<id> 显式指定出口（不存在/不支持 → 400 点名）。
        let dl: ReturnType<typeof downloadProxy>
        try {
          dl = downloadProxy(c.req.query('egress') ?? '')
        } catch (e) {
          return err(c, 400, (e as Error).message)
        }
        // 单飞：已有任务在跑就复用同一个 promise，不重复下载（见 ensureJob）。
        const p = ensureJob(dl)
        try {
          await p
          return c.json({
            ok: true, status: await svc.status(),
            downloadProxy: maskProxyURI(dl.proxyURI), downloadProxySource: dl.source,
          })
        } catch (e) {
          return err(c, 500, `就绪失败: ${(e as Error).message}（下载代理：${maskProxyURI(dl.proxyURI)}，来源 ${dl.source}）`)
        }
      }
      case 'port': {
        // 手动改 sidecar 监听端口。顺序关键：Running()/Stop() 必须在 SetPort 之前。
        const body = await c.req.json().catch(() => undefined) as { port?: string } | undefined
        const port = body?.port
        if (!port) return err(c, 400, '请求体须为 {"port":"9090"}')
        try {
          validatePort(port)
        } catch (e) {
          return err(c, 400, (e as Error).message)
        }
        let restarted = false
        if (await svc.running()) {
          try {
            await svc.stop()
            svc.setPort(dir(), port)
            await svc.start(dir())
          } catch (e) {
            return err(c, 500, `端口已写入但引擎重启失败（可点「启动」重试）: ${(e as Error).message}`)
          }
          restarted = true
        } else {
          try {
            svc.setPort(dir(), port)
          } catch (e) {
            return err(c, 400, (e as Error).message)
          }
        }
        const p = providers.getByName('zcode-plan-local')
        if (p && p.baseUrl !== `http://127.0.0.1:${port}`) {
          providers.put({ ...p, baseUrl: `http://127.0.0.1:${port}` })
          changed()
        }
        return c.json({ ok: true, port, restarted })
      }
      case 'endpoint': {
        // 自定义/兜底引擎地址：只改 provider baseUrl，不碰引擎进程；test=true 仅探活。
        const body = await c.req.json().catch(() => undefined) as
          { url?: string; test?: boolean; builtin?: boolean } | undefined
        if (!body) return err(c, 400, '请求体须为 {"url":"http://127.0.0.1:8080"}')
        let url = body.url ?? ''
        let test = body.test === true
        if (body.builtin) {
          url = `http://127.0.0.1:${svc.port}`
          test = false
        }
        let host: string
        try {
          const u = new URL(url)
          if (u.protocol !== 'http:' || u.hostname === '') throw new Error('bad')
          host = u.hostname
        } catch {
          return err(c, 400, '地址须为 http://127.0.0.1:端口 或 http://localhost:端口（免费凭据不允许指向公网）')
        }
        if (!isLoopbackHost(host)) {
          return err(c, 400, '地址须为 http://127.0.0.1:端口 或 http://localhost:端口（免费凭据不允许指向公网）')
        }
        if (test) {
          let alive = false
          try {
            const res = await fetchImpl(url.replace(/\/+$/, '') + '/health', { signal: AbortSignal.timeout(3000) })
            alive = res.status > 0
          } catch { alive = false }
          return c.json({ ok: alive, url })
        }
        const p = providers.getByName('zcode-plan-local')
        if (!p) return err(c, 404, 'provider zcode-plan-local 不存在')
        providers.put({ ...p, baseUrl: url.replace(/\/+$/, '') })
        changed()
        return c.json({ ok: true, url: url.replace(/\/+$/, '') })
      }
      default:
        return err(c, 404, '未知动作 ' + action +
          '（支持: start|stop|login|pause|cancel|setup|uninstall|ensure|port|endpoint；install 走 CLI: polycode-hub zcode sidecar …）')
    }
  })

  return app
}
