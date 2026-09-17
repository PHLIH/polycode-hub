#!/usr/bin/env node
// 服务入口：子命令 serve（默认）| scan | adopt | zcode …（一级命令见文件底部 argv 分发；
// zcode 下再分 login / sidecar，sidecar 动作见 runZCode）。
import { existsSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createAdminUI } from './gateway/adminui.ts'
import { loadOrDefault, type Config } from './config/index.ts'
import { Scheduler } from './router/scheduler.ts'
import { Upstream, egressProxyURI } from './router/upstream.ts'
import { Proxy } from './gateway/proxy.ts'
import { Probe } from './gateway/probe.ts'
import { AccountPool } from './pool/account.ts'
import type { Account, Provider } from './model/index.ts'
import { Store as UsageStore } from './usage/store.ts'
import {
  SQLiteEgressStore, SQLiteProviderStore, SQLiteAccountStore,
  seedProvidersIfEmpty, seedAccountsIfEmpty,
} from './adminapi/store.ts'
import { createAdminApi } from './adminapi/api.ts'
import type { Finding } from './adminapi/types.ts'
import { createSidecarApp } from './adminapi/sidecar_app.ts'
import { createProjectsApp } from './adminapi/projects_app.ts'
import { Sidecar } from './sidecar/sidecar.ts'
import { Manager } from './projects/manager.ts'
import { Store as ProjectsStore } from './projects/store.ts'
import { openLog, startDetached } from './projects/process.ts'
import {
  Scanner, defaultConfig, discoverWorkBuddyModelsFrom, workBuddyDataDirs,
  discoverOpenCodeFingerprint, type ZenCallProbe,
} from './discover/index.ts'

// 目录候选的安全取值（配置可能未提供该字段）。
const workBuddyDataNullsafe = (dirs: string[] | undefined): string[] => dirs ?? []
import { homedir } from 'node:os'
import { usageStatsSource } from './adminapi/stats.ts'
import { providerValidate } from './model/index.ts'

// 路径语义对齐 Go：配置/数据/凭据一律相对进程 cwd（运行目录即工作目录）；
// 仅 web/dist 锚定包/仓库自身（Go 时代它嵌在二进制里，TS 侧从安装位置现读）。
const here = dirname(fileURLToPath(import.meta.url))
const distRoot = [join(here, '..', '..', '..'), join(here, '..', '..')]
  .find((d) => existsSync(join(d, 'web', 'dist'))) ?? join(here, '..', '..', '..')
const cwd = process.cwd()

// 三协议编解码器自注册到 ir 注册表（对齐 Go main.go 的空导入；漏掉则首个请求即 500）。
import './codec/anthropicmessages.ts'
import './codec/openaicompletions.ts'
import './codec/openairesponses.ts'

export function fatal(err: Error): never {
  console.error('致命错误:', err.message)
  process.exit(1)
}

// 管理口令策略（按暴露程度分级）：配了直接用；没配 + 回环监听放行（Ollama 同款）；
// 没配 + 对外监听拒绝启动。
function ensureAdminKey(cfg: Config): void {
  if (cfg.gateway.adminKey) return
  const host = cfg.gateway.host.replace(/^\[|\]$/g, '')
  const loopback = host === 'localhost' || host.startsWith('127.') || host === '::1'
  if (!loopback) {
    fatal(new Error(`监听地址 ${cfg.gateway.host} 对外暴露，管理口令不能为空（请配置 gateway.admin_key）`))
  }
  console.warn('管理面无鉴权（仅回环监听可访问）；如需暴露到局域网/公网，请配置 gateway.admin_key')
}

// discover.Scanner → adminapi.DiscoverSource 适配（对齐 Go main.go discoverSource）。
class DiscoverSourceAdapter {
  private s: Scanner
  constructor(s: Scanner) { this.s = s }
  scan(): Promise<Finding[]> {
    // scan 是 async（zen 探针走 fetch）；管理面端点 await 消费。
    // discover.Finding 与 adminapi.Finding JSON 形状一致，直接透传。
    return this.s.scan() as unknown as Promise<Finding[]>
  }
}

export async function runServe(args: string[]): Promise<void> {
  let configPath = process.env.POLYCODE_CONFIG ?? join(cwd, 'config', 'apps.yaml')
  let portOverride = 0
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--config') configPath = args[i + 1]!
    // --port 必须显式校验：Number('abc') 得 NaN，而 `NaN > 0` 为 false，
    // 旧写法会**静默忽略**这个参数、悄悄用配置文件里的端口 ——
    // 用户以为改了端口，实际没改，且没有任何提示。
    if (args[i] === '--port') {
      const n = Number(args[i + 1])
      if (!Number.isInteger(n) || n <= 0 || n > 65535) {
        fatal(new Error(`--port 须为 1-65535 的整数（收到 "${args[i + 1]}"）`))
      }
      portOverride = n
    }
  }
  const cfg = loadOrDefault(configPath)
  ensureAdminKey(cfg)
  if (portOverride > 0) cfg.gateway.port = portOverride
  console.log(`配置加载完成 providers=${cfg.providers.length} accounts=${cfg.accounts.length} listen=${cfg.gateway.host}:${cfg.gateway.port}`)

  // B2 用量落盘：打开失败即致命（用量是 P0 核心能力，不静默降级）。
  const usageStore = await UsageStore.open(join(cwd, cfg.dataDir, 'usage.db'))

  const sched = new Scheduler(cfg.providers, cfg.gateway.riskMax)
  // egress 出口代理（EGRESS-SPIKE 方案 A，模型级粒度）：DB 是真相源，
  // config/apps.yaml 的定义只在首启（库空）种一次，之后由管理面主导。
  const egresses = await SQLiteEgressStore.open(join(cwd, cfg.dataDir, 'admin.db'))
  for (const e of cfg.egresses) {
    if (!egresses.get(e.id)) egresses.put(e)
  }
  const up = new Upstream()
  const syncEgresses = () => {
    up.setEgresses(Object.fromEntries(egresses.list().map((e) => [e.id, egressProxyURI(e)])))
  }
  syncEgresses()
  const px = new Proxy(cfg, sched, up, usageStore)

  const adminDB = join(cwd, cfg.dataDir, 'admin.db')
  const providers = await SQLiteProviderStore.open(adminDB)
  const accounts = await SQLiteAccountStore.open(adminDB)

  // 账号池常驻（为空也建）：Admin 增删改经通知热重载，无需重启。
  // 惩罚（连败/冷却/耗尽）落盘：不落盘的话重启即失忆，UI 上的失败计数永远是 0。
  // 回写规则：
  //   cooldown —— 只写惩罚字段，status 仍归管理面（DB 里存 available/disabled）；
  //   exhausted —— 必须把 status 一起写进去。额度用尽不会自己好，重启后得停在
  //                耗尽态，否则一夜之间所有号又爬起来空转；
  //   恢复（重置/测试成功）—— 把 DB 里的 exhausted 抹回 available，否则永远解不开。
  //   disabled —— 操作者显式停用，任何自动惩罚都不得覆盖；池内若已按成功清惩罚，
  //               也不能据此把 DB 的 disabled 改成 available（只有「启用」能解）。
  const writePenalty = (a: Account) => {
    const cur = accounts.get(a.id)
    if (!cur) return
    const next = { ...cur, fails: a.fails, cooldownUntil: a.cooldownUntil }
    // disabled 是操作者意图，惩罚回写不改写它（避免「测试通过→静默启用」式漂移）。
    if (cur.status === 'disabled') next.status = 'disabled'
    else if (a.status === 'exhausted') next.status = 'exhausted'
    else if (cur.status === 'exhausted' && a.status === 'available') next.status = 'available'
    accounts.put(next)
  }
  // 显式重置（操作者点「重置」）允许解除 disabled：这是唯一能把号从停用态放出来的自动路径。
  const writeReset = (a: Account) => {
    const cur = accounts.get(a.id)
    if (!cur) return
    accounts.put({ ...cur, status: a.status, fails: a.fails, cooldownUntil: a.cooldownUntil })
  }
  const acctPool = new AccountPool(cfg.accounts, writePenalty, writeReset)
  px.setAccountPool(acctPool)

  seedProvidersIfEmpty(providers, cfg.providers)
  // 账号归属解析：YAML 里写的是 Provider 名，落库要的是数字 providerId。
  // 必须在 provider 入库（拿到自增 id）之后做。
  {
    const idByName = new Map(providers.list().map((p) => [p.name, p.providerId] as const))
    for (const a of cfg.accounts) {
      const named = (a as { providerName?: string }).providerName
      if (!named) continue
      const id = idByName.get(named)
      if (id === undefined) {
        console.error(`账号 ${a.id} 归属的 Provider「${named}」不存在，该账号不会参与轮询`)
        continue
      }
      a.providerId = id
      delete (a as { providerName?: string }).providerName
    }
  }
  seedAccountsIfEmpty(accounts, cfg.accounts)

  // 用量表的历史行：provider_id 由「Provider 名」迁到数字内部 id。
  // 必须在 Provider 入库之后跑（名字→id 的权威来源就是这张表）。
  // 查不到对应 Provider 的历史行标 -1，但 provider_name 快照保住了展示。
  const named = new Map(providers.list().map((p) => [p.name, p.providerId] as const))
  const fixed = usageStore.resolveProviderIds((n) => named.get(n))
  if (fixed > 0) console.log(`用量归因迁移：${fixed} 个历史 Provider 名已绑定到内部 id`)

  // WorkBuddy 模型痕迹：多平台数据根合并（此前写死 $HOME/.workbuddy，Windows 恒空）。
  const wbGoos = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const wbHome = homedir()
  const wbProfile = wbGoos === 'windows' ? (process.env.USERPROFILE || wbHome) : wbHome
  const wbModelDirs = workBuddyDataDirs(wbGoos, wbHome, wbProfile)
  const probe = new Probe(sched, up, usageStore, acctPool,
    (providerName) => providerName === 'workbuddy'
      ? discoverWorkBuddyModelsFrom(wbModelDirs)
      : [])

  // sidecar 管理（网关工作目录推算；端口从 config.yaml 恢复）。
  const sidecarSvc = new Sidecar(join(cwd, 'config', 'credentials', 'zcode-proxy-key'))
  sidecarSvc.workDir = join(cwd, 'config', 'zcode-proxy')
  sidecarSvc.loadPort(sidecarSvc.workDir)

  // 本地项目管理器（与代理无关的独立板块）。
  //
  // selfRestart：让用户能从管理台重启网关自己（网关本身也是项目列表里的一项）。
  // 必须在**本进程退出之后**才能重新启动，否则新进程会撞上还没释放的端口
  // （EADDRINUSE 直接死掉，用户看到的就是"重启完再也起不来"）。
  // 做法：派一个脱离本进程的 shell，先 sleep 等我们退干净，再原地拉起同一条命令。
  const projectsMgr = new Manager(new ProjectsStore(join(cwd, 'config', 'projects')), {
    selfRestart: () => {
      try {
        const fd = openLog(join(cwd, 'config', 'projects', 'self-restart.log'))
        // argv 原样复用（含 --port 等自定义参数），换个进程重新执行同一条命令。
        // 单引号转义防路径带空格/特殊字符把命令拆坏。
        const args = process.argv.slice(1).map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
        const cmd = `sleep 2; exec '${process.execPath}' ${args.join(' ')}`
        startDetached(cwd, cmd, [], fd)
        return true
      } catch (e) {
        console.error('projects: 安排自我重启失败:', e)
        return false
      }
    },
  })

  // store 是唯一真相源：全量同步调度（惩罚状态按 ID 合并保留）。
  const syncStores = () => {
    sched.reset(providers.list(), cfg.gateway.riskMax)
    acctPool.syncAccounts(accounts.list())
    syncEgresses()
  }
  syncStores() // 启动即同步一次：DB 里有、配置文件没有的也要进调度

  // zen 可调用性验证：发现页的探针必须真打一次，否则 GET /v1/models（免指纹）会把
  // 「网络通」误报成 ready，用户到手才发现 403 FreeTierError（真实假阳性）。
  const zenCallProbe: ZenCallProbe = async (model) => {
    const draft = defaultConfig()
    // 探针必须用「与真实转发同一份配置」，否则会把「探针没带够配置」误报成「源不可用」。
    // 两份来源，优先级从高到低：
    //   ① 已配置的 zen Provider —— 用户配的指纹头、egress 出口全在里面；
    //   ② 草稿 + 自动识别的指纹 —— 还没配过的用户（首次打开发现页）走这条，
    //      指纹从本机 opencode 日志自动读，用户不需要手抄任何东西。
    //
    // 曾经的写法用空 headers 去打：指纹/出口全被忽略，必然 403，报成「模型不可调用」——
    // 典型假阴性（本轮实测踩到两次：先是无 egress，再是无指纹）。
    const configured = providers.list().find((x) => x.state !== 'deleted'
      && (x.name === 'opencode' || x.name === 'zen' || x.baseUrl.includes('opencode.ai')))
    // 与发现页同源：从本机 opencode 日志识别指纹（识别不到则为 null，不伪造）。
    const fp = discoverOpenCodeFingerprint(
      workBuddyDataNullsafe(draft.openCodeDirs))
    const autoHeaders: Record<string, string> = fp
      ? { 'User-Agent': fp.userAgent, 'x-session-id': fp.sessionID, 'x-session-affinity': fp.sessionID }
      : {}
    const p: Provider = configured
      ? { ...configured, models: [{ id: model, manual: false, enabled: true, ...(configured.models.find((m) => m.id === model)?.api ? { api: configured.models.find((m) => m.id === model)!.api } : {}) }], probeModel: model }
      : {
        providerId: 0, name: 'opencode-zen-probe', state: 'active', displayName: 'probe',
        accessKind: 'reverse', risk: 'high', riskNote: 'probe', stability: 'beta',
        api: 'openai-completions', baseUrl: (draft.zenBaseURL ?? 'https://opencode.ai/zen') + '/v1',
        credential: { apiKeyEnv: 'ZEN_KEY' },
        headers: autoHeaders,
        priority: 1,
        models: [{ id: model, manual: false, enabled: true }],
      }
    // 免费档鉴权恒为 Bearer public（ZEN_KEY 的官方取值就是 public）。
    // 把凭据交给 credLookup：真实 ZEN_KEY 优先，未设则回落 public，等价于
    // 「一键导入」时 applyCredentialDefaults 落的那个公共 key。
    // 不能引用不存在的环境变量名——credentialResolve 失败会抛「环境变量未设置」，
    // 探针就变成恒错的假阴性。
    const zenLookup = (name: string): [string, boolean] => {
      if (name !== 'ZEN_KEY') return process.env[name] === undefined ? ['', false] : [process.env[name]!, true]
      return [(process.env.ZEN_KEY ?? 'public'), true]
    }
    const probeUp = up.withOpts({ credLookup: zenLookup })
    try {
      const req: import('./ir/index.ts').IrRequest = {
        model, stream: true, maxTokens: 8,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }
      const stream = await probeUp.streamWithTimeout(p, req, AbortSignal.timeout(20_000))
      // 读到首块即算可调用（不解析内容：探针只验「没被拒」）。
      const reader = stream.getReader()
      await reader.read()
      await reader.cancel().catch(() => {})
      return { ok: true }
    } catch (e) {
      const err = e as { kind?: string; message?: string }
      return { ok: false, kind: err.kind, error: err.message ?? String(e) }
    }
  }

  const admin = createAdminApi({
    adminKey: cfg.gateway.adminKey,
    egresses,
    providers,
    accounts,
    stats: usageStatsSource(usageStore),
    discover: new DiscoverSourceAdapter(new Scanner({ ...defaultConfig(), zenCallProbe })),
    resetter: { resetAccount: (id: string) => acctPool.resetAccount(id) },
    // 池内惩罚（冷却/连败）是运行时状态，列表页要显示就得现问池子。
    accountRuntime: {
      runtime: (id) => {
        const a = acctPool.get(id)
        return a ? { status: a.status, fails: a.fails, cooldownUntil: a.cooldownUntil } : undefined
      },
    },
    accountProber: { probeAccount: (id, model) => probe.probeAccount(id, model) },
    prober: { probeProvider: (pid) => probe.probeProvider(pid) },
    lister: { listProviderModels: (pid) => probe.listProviderModels(pid) },
    modelProber: { probeModels: (pid, models) => probe.probeModels(pid, models) },
    notify: syncStores,
    sidecar: createSidecarApp(sidecarSvc, providers, syncStores),
    projects: createProjectsApp(projectsMgr, { defaultModel: cfg.gateway.defaultModel }),
  })

  const app = new Hono()
  px.registerRoutes(app)
  app.route('/', admin)
  // 产物路径在模块加载时按「哪个候选目录含 web/dist」探测定下（见文件顶部 distRoot），
  // 探测发生在 dist 缺失时就会落到兜底值。这里直接报实际挂载的目录，避免指错路径。
  const distDir = join(distRoot, 'web', 'dist')
  app.route('/', createAdminUI(distDir))

  const server = serve({ fetch: app.fetch, port: cfg.gateway.port, hostname: cfg.gateway.host })
  console.log(`polycode-hub 已启动 http://${cfg.gateway.host}:${cfg.gateway.port}/admin/`)
  // 前端产物不入库（web/dist 由构建生成，见 .gitignore），clone 后没构建过就会落到这里：
  // 服务照常起、API 照常通，但 /admin 全 404——不报错的话极难排查（同 update.sh
  // 记录过的「报成功但跑旧代码」一类）。所以显式告警，并给出修复命令。
  if (!existsSync(join(distDir, 'index.html'))) {
    console.warn(
      `警告：前端产物缺失，/admin 将返回 404（API 不受影响）。\n` +
        `      查找路径：${distDir}\n` +
        `      修复：npm run setup（或 npm run build:web）后重启`,
    )
  }

  // 项目管理巡检（超时自动关/死进程清账）+ 优雅退出。
  // 用 manager 自带的 runSweeper（它 unref 了定时器并返回取消函数），
  // 不在 cli 里另写一份 setInterval——两处实现漂移过一次。
  const stopSweeper = projectsMgr.runSweeper(60_000)
  const shutdown = () => {
    stopSweeper() // 先停巡检，再关服务，避免退出期间还在改状态文件
    console.log('已退出')
    void server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// ---- scan 子命令 ----

async function runScan(args: string[]): Promise<void> {
  const asJSON = args.includes('--json')
  const findings = await new Scanner(defaultConfig()).scan()
  if (asJSON) {
    console.log(JSON.stringify({ findings }, null, 2))
    return
  }
  for (const f of findings) {
    console.log(`[${f.status}] ${f.harness}: ${f.detail}`)
    for (const a of f.actions ?? []) console.log(`    → ${a}`)
  }
}

// ---- adopt 子命令 ----

async function runAdopt(args: string[]): Promise<void> {
  let configPath = process.env.POLYCODE_CONFIG ?? join(cwd, 'config', 'apps.yaml')
  let id = ''
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config') configPath = args[++i]!
    else if (args[i] === '--id') id = args[++i]!
    else rest.push(args[i]!)
  }
  if (rest.length < 1) fatal(new Error('用法: adopt [--id ID] <finding-key>（如 workbuddy / opencode-zen）'))
  const cfg = loadOrDefault(configPath)
  const providers = await SQLiteProviderStore.open(join(cwd, cfg.dataDir, 'admin.db'))
  seedProvidersIfEmpty(providers, cfg.providers)
  const findings = await new Scanner(defaultConfig()).scan()
  const found = findings.find((f) => f.key === rest[0])
  if (!found) fatal(new Error(`未发现 "${rest[0]}"，先跑 scan 看看`))
  if (found.status !== 'ready') {
    fatal(new Error(`${found.harness} 未就绪（${found.status}）：${(found.actions ?? []).join('；')}`))
  }
  const p = { ...found.suggestedProvider! }
  if (id) p.name = id
  p.providerId = 0
  const invalid = providerValidate(p)
  if (invalid) fatal(new Error(invalid))
  const same = providers.getByName(p.name)
  if (same && same.state !== 'deleted') fatal(new Error(`provider ${p.name} 已存在`))
  providers.put(p)
  console.log(`已采用: ${p.name} (#${p.providerId}, ${found.harness})`)
}

// ---- zcode 子命令 ----

async function runZCode(args: string[]): Promise<void> {
  const sub = args[0]
  if (sub === 'login') {
    const { Client } = await import('./zcodeauth/index.ts')
    const client = new Client()
    const flow = await client.startFlow('zai')
    console.log('1. 在浏览器打开以下链接并登录 ZCode（已尝试自动打开）：\n')
    console.log('   ' + flow.authorizeURL + '\n')
    try {
      const { execFile } = await import('node:child_process')
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open'
      const a = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', flow.authorizeURL] : [flow.authorizeURL]
      execFile(cmd, a, () => {})
    } catch {
      console.log('   （自动打开浏览器失败，请手动复制上面链接）')
    }
    console.log('2. 点同意后回到这里等待（5 分钟有效）…')
    const sess = await client.pollFlow(flow, 5 * 60_000)
    if (!sess.accessToken) fatal(new Error('批准响应无 access_token，请重试'))
    const jwt = await client.resolveBusinessToken(sess.accessToken)
    console.log(`\n登录成功。business JWT（只显示一次，不保存，请立即 export）：\n\n   export ZCODE_JWT='${jwt}'\n`)
    if (sess.accessToken) {
      console.log(`附带 zai access_token（plan 通道若认它不认 JWT 时用）：\n\n   export ZCODE_AT='${sess.accessToken}'\n`)
    }
    console.log('然后在 polycode-hub 配置/账号池中使用该环境变量。')
    return
  }
  if (sub === 'sidecar') {
    const action = args[1] ?? 'ensure'
    const sc = new Sidecar(join(cwd, 'config', 'credentials', 'zcode-proxy-key'))
    sc.workDir = join(cwd, 'config', 'zcode-proxy')
    sc.loadPort(sc.workDir)
    switch (action) {
      case 'install': {
        // 下载走代理：--proxy http://127.0.0.1:7897 或环境变量 HTTPS_PROXY（国内网络必备）
        let proxy = ''
        for (let i = 2; i < args.length - 1; i++) {
          if (args[i] === '--proxy') proxy = args[i + 1] ?? ''
        }
        if (!proxy) proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? ''
        if (proxy) {
          const { setGlobalDispatcher, ProxyAgent } = await import('undici')
          setGlobalDispatcher(new ProxyAgent(proxy))
          console.log(`下载走代理: ${proxy}`)
        }
        const p = await sc.install(args.includes('--force'))
        console.log('已安装:', p)
        return
      }
      case 'setup': {
        const key = sc.setupConfig(sc.workDir)
        console.log('已生成安全配置:', join(sc.workDir, 'config.yaml'))
        console.log('proxyApiKey（已存 config/credentials/zcode-proxy-key，无需手抄）:', key)
        return
      }
      case 'start':
        await sc.start(sc.workDir)
        console.log('sidecar 已启动:', await sc.status())
        return
      case 'stop':
        await sc.stop()
        console.log('sidecar已停止:', await sc.status())
        return
      case 'status':
        console.log(await sc.status())
        return
      case 'login':
        await sc.login(sc.workDir)
        return
      case 'ensure':
        await sc.ensureReady(sc.workDir)
        console.log('sidecar 就绪:', await sc.status())
        console.log('网关凭据:', sc.credKey)
        return
      default:
        fatal(new Error(`未知 sidecar 动作 "${action}"（支持: install|setup|start|stop|status|login|ensure）`))
    }
    return
  }
  fatal(new Error('未知子命令 zcode ' + (sub ?? '') + '（支持: zcode login | zcode sidecar install|setup|start|stop|status|login|ensure）'))
}

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'serve'
if (cmd === 'serve') await runServe(argv.slice(1))
else if (cmd === 'scan') await runScan(argv.slice(1))
else if (cmd === 'adopt') await runAdopt(argv.slice(1))
else if (cmd === 'zcode') await runZCode(argv.slice(1))
else fatal(new Error(`未知子命令 "${cmd}"（支持: serve | scan | adopt | zcode login）`))
