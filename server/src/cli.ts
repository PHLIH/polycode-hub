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
import { Store as UsageStore, backfillSemantics } from './usage/store.ts'
import {
  SQLiteEgressStore, SQLiteProviderStore, SQLiteAccountStore,
  seedProvidersIfEmpty, seedAccountsIfEmpty, migrateWorkBuddyAttributionHeaders,
} from './adminapi/store.ts'
import { createAdminApi } from './adminapi/api.ts'
// 来源体检：Host 检查（防 DNS rebinding）+ 回环主机判据（下文两处口令守卫共用）。
import { hostGuard, isLoopbackHost } from './source_guard.ts'
import type { Finding } from './adminapi/types.ts'
import { createSidecarApp } from './adminapi/sidecar_app.ts'
import { createProjectsApp } from './adminapi/projects_app.ts'
import { Sidecar } from './sidecar/sidecar.ts'
import { SidecarGuard } from './sidecar/guard.ts'
import { maskProxyURI, resolveSidecarDownloadFetch } from './sidecar/httpproxy.ts'
import { Manager } from './projects/manager.ts'
import { Store as ProjectsStore } from './projects/store.ts'
import { openLog, quoteArg, startDetached } from './projects/process.ts'
import {
  Scanner, defaultConfig, discoverWorkBuddyModelsFrom, workBuddyDataDirs,
  discoverOpenCodeFingerprint, discoverAllOpenCodeFingerprints, zenProbeRequest,
  type ZenCallProbe,
} from './discover/index.ts'
import { refreshAllZenProviders, refreshZenProvider } from './discover/zen_refresh.ts'
import { isZenBaseUrl, mintZenRequestId, parseZenSessionPool, writeZenSessionPool } from './model/index.ts'

// 目录候选的安全取值（配置可能未提供该字段）。
const workBuddyDataNullsafe = (dirs: string[] | undefined): string[] => dirs ?? []
import { homedir } from 'node:os'
import { usageStatsSource } from './adminapi/stats.ts'
import { providerValidate } from './model/index.ts'
// adopt 子命令与发现页「采用」共用同一条可导入判据（单一真相源，避免口径漂移）。
import { notAdoptableReason } from './adminapi/discover_api.ts'

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

// 回环监听判定：口径不在这里维护——管理口令、网关口令两处启动守卫与来源体检
// 的 Host 检查共用 source_guard.isLoopbackHost（判据漂移过一次的地方，
// 再多写一遍迟早再漂一次）。

// 管理口令策略（按暴露程度分级）：配了直接用；没配 + 回环监听放行（Ollama 同款）；
// 没配 + 对外监听拒绝启动。
function ensureAdminKey(cfg: Config): void {
  if (cfg.gateway.adminKey) return
  if (!isLoopbackHost(cfg.gateway.host)) {
    fatal(new Error(`监听地址 ${cfg.gateway.host} 对外暴露，管理口令不能为空（请配置 gateway.admin_key）`))
  }
  console.warn('管理面无鉴权（仅回环监听可访问）；如需暴露到局域网/公网，请配置 gateway.admin_key')
}

// 网关口令策略（与 ensureAdminKey 同一套分级，判据共用 isLoopbackHost）：
// gateway_key 为空时 /v1/* 转发完全不鉴权（见 gateway/proxy.ts 的校验）——
// 回环监听时空口令只有本机可触达，放行 + 提醒即可；但 host 绑到 0.0.0.0/局域网后，
// 网关就变成任何人可用的开放 LLM 中继，会烧掉所有已配置的上游凭据，
// 所以「对外监听 + 空 key」必须像管理口令一样直接拒绝启动。
function ensureGatewayKey(cfg: Config): void {
  if (cfg.gateway.gatewayKey) return
  if (!isLoopbackHost(cfg.gateway.host)) {
    fatal(new Error(`监听地址 ${cfg.gateway.host} 对外暴露，网关口令不能为空（请配置 gateway.gateway_key）`))
  }
  console.warn('转发无鉴权（gateway_key 为空，仅回环监听可访问）；如需暴露到局域网/公网，请配置 gateway.gateway_key')
}

// discover.Scanner → adminapi.DiscoverSource 适配（对齐 Go main.go discoverSource）。
class DiscoverSourceAdapter {
  private s: Scanner
  constructor(s: Scanner) { this.s = s }
  scan(force = false): Promise<Finding[]> {
    // scan 是 async（zen 探针走 fetch）；管理面端点 await 消费。
    // discover.Finding 与 adminapi.Finding JSON 形状一致，直接透传。
    // force 透传给 Scanner：绕过 TTL 缓存，用于用户显式「重新探测」。
    return this.s.scan(force) as unknown as Promise<Finding[]>
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
  ensureGatewayKey(cfg) // 转发面的口令与管理口令同等敏感：对外监听 + 空 key = 开放中继
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
  // 会话补位候选：淘汰坏会话后补新用。惰性求值（调用时才读配置）——
  // openCodeDirs 在后面才解析，这里不能提前捕获。
  const up = new Upstream({
    onProtocolLearned: (providerId, modelId, protocol) => {
      // 外部调用自动记录：转发时新探到的协议写回该模型的 api（DB 落盘），
      // 下次转发/测试直接用，不再试错。模型已被删除时 get 返回空，直接跳过
      // （删模型时进程缓存同步清，见 api.ts DELETE models/:model）。
      // 写前重读比对（B-P1-1）：并发两请求探到不同协议时后写覆盖先写，
      // 值都是某次真实成功的协议，不影响正确性；已有值则跳过，少一次写库。
      const p = providers.get(providerId)
      if (!p) return
      const m = p.models.find((x) => x.id === modelId)
      if (!m || m.api === protocol) return
      m.api = protocol
      providers.put(p)
      syncStores()
    },
    // 补位写透到库（A-P0-2）：淘汰+refill 只改内存 active，不写库下次 sync
    // 即被剔除。这里把运行时池落回库内池头（去抖：内容一致则跳过写库）。
    onZenPoolFlushed: (providerId, sessions) => {
      const p = providers.get(providerId)
      if (!p) return
      const h: Record<string, string> = { ...(p.headers ?? {}) }
      const before = parseZenSessionPool(h).join(',')
      writeZenSessionPool(h, sessions)
      if (parseZenSessionPool(h).join(',') === before) return // 一致：跳过写库
      p.headers = h
      providers.put(p)
      syncStores()
    },
    refillCandidates: () => {
      try {
        const dirs = defaultConfig().openCodeDirs ?? []
        return discoverAllOpenCodeFingerprints(dirs).map((x) => x.sessionID)
      } catch { return [] }
    },
  })
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
  // WorkBuddy 使用端归因头迁移（存量修复）：模板只影响新建，已入库的行要在这里补，
  // 否则管理台改好的头一重启就没了。见 store 里该函数的注释。
  {
    const n = migrateWorkBuddyAttributionHeaders(providers)
    if (n > 0) console.log(`WorkBuddy 归因头迁移：${n} 个 Provider 已补使用端归因头（用量页「使用端」列将显示 WorkBuddy）`)
  }
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
  seedAccountsIfEmpty(accounts, cfg.accounts, accounts.seedLedger())

  // 用量表的历史行：provider_id 由「Provider 名」迁到数字内部 id。
  // 必须在 Provider 入库之后跑（名字→id 的权威来源就是这张表）。
  // 查不到对应 Provider 的历史行标 -1，但 provider_name 快照保住了展示。
  const named = new Map(providers.list().map((p) => [p.name, p.providerId] as const))
  const fixed = usageStore.resolveProviderIds((n) => named.get(n))
  if (fixed > 0) console.log(`用量归因迁移：${fixed} 个历史 Provider 名已绑定到内部 id`)

  // 历史行缓存语义回填（CACHE-SEMANTICS）：协议是权威——模型级声明 > Provider 级
  // 声明，anthropic-messages → separate，其余 → subset。已删 Provider 的配置也参与
  // （list 不过滤 deleted），否则删源后历史行全靠启发式猜。必须在 Provider 入库后跑。
  // 键必须是 (providerId, modelId)：同一 Provider 下不同模型可声明不同协议
  // （senseaudio 就是 openai-completions/anthropic-messages/openai-responses 三混）。
  // 早期版本用 providerId 单键，"最后一个带 api 的模型"会覆盖整个 Provider，
  // 混合源里的 anthropic 模型被整体判成 subset——而转发路径 resolveProtocol 是
  // 按 modelID 精确解析的，两边口径分裂（实时转发算 separate、历史回填算 subset）。
  const protoByModel = new Map<string, string>()
  const protoByProvider = new Map<number, string>()
  for (const p of providers.list()) {
    if (p.api) protoByProvider.set(p.providerId, p.api)
    for (const m of p.models) {
      if (m.api) protoByModel.set(`${p.providerId}\u0000${m.id}`, m.api)
    }
  }
  const semFixed = usageStore.backfillSemantics(
    (pid, mid) => protoByModel.get(`${pid}\u0000${mid}`) ?? protoByProvider.get(pid))
  if (semFixed > 0) console.log(`用量缓存语义回填：${semFixed} 行已按协议/启发式标记 sem`)

  // WorkBuddy 模型痕迹：多平台数据根合并（此前写死 $HOME/.workbuddy，Windows 恒空）。
  const wbGoos = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const wbHome = homedir()
  const wbProfile = wbGoos === 'windows' ? (process.env.USERPROFILE || wbHome) : wbHome
  const wbModelDirs = workBuddyDataDirs(wbGoos, wbHome, wbProfile)
  const probe = new Probe(sched, up, usageStore, acctPool,
    // 两个发行版（workbuddy / workbuddy-ai）共用同一份本机模型痕迹：
    // 痕迹是从客户端数据目录扫出来的「这台机器用过的模型」，不区分版本文件。
    // 只认 'workbuddy' 会让海外版 Provider 恒无模型目录（勾不到任何模型 → 调用 404）。
    (providerName) => providerName === 'workbuddy' || providerName === 'workbuddy-ai'
      ? discoverWorkBuddyModelsFrom(wbModelDirs)
      : [])

  // sidecar 管理（网关工作目录推算；端口从 config.yaml 恢复）。
  const sidecarSvc = new Sidecar(join(cwd, 'config', 'credentials', 'zcode-proxy-key'))
  sidecarSvc.workDir = join(cwd, 'config', 'zcode-proxy')
  sidecarSvc.loadPort(sidecarSvc.workDir)

  // sidecar 保活守护：引擎掉线后自动拉起。
  //
  // 为什么必须有（真实故障，2026-09-19 取证）：引擎会因外部 SIGTERM 停掉
  // （管理台停止/改端口/卸载，或别的网关实例的动作——killSidecarSpec 匹配
  // 本用户所有 sidecar），而此前**没有任何机制把它拉回来**。实测引擎停下后
  // 连查 70 秒 running 恒为 false，永不恢复；更糟的是默认模型会被别的上游
  // 静默接走并返回 200，用户连「它死了」都看不出来。
  //
  // enabled 判据用「是否已安装」：没装引擎的用户不该被反复尝试拉起而刷日志。
  const sidecarGuard = new SidecarGuard(sidecarSvc, {
    enabled: () => {
      try {
        return existsSync(sidecarSvc.findBinary(sidecarSvc.workDir))
      } catch {
        return false
      }
    },
  })

  // 本地项目管理器（与代理无关的独立板块）。
  //
  // selfRestart：让用户能从管理台重启网关自己（网关本身也是项目列表里的一项）。
  // 必须在**本进程退出之后**才能重新启动，否则新进程会撞上还没释放的端口
  // （EADDRINUSE 直接死掉，用户看到的就是"重启完再也起不来"）。
  // 做法：派一个脱离本进程的 shell，先等端口真正空出来，再原地拉起同一条命令。
  //
  // 为什么不能只 sleep 固定秒数：旧实现写死 `sleep 2`，而退出耗时不确定——
  // 还在服务的 SSE 流、SQLite WAL 收尾、巡检线程都可能让监听套接字晚于 2 秒才释放。
  // 一旦超时，新进程立刻 EADDRINUSE 死掉，而且它是 detached 的、没人再拉它，
  // 表现就是「点了重启，网关再也没起来」。改成轮询端口 + 上限兜底：
  // 常见情况 1 秒内就位；真等到上限仍未释放也照常启动，让新进程自己把
  // 「端口被占」报成一句人话（见下方 listen 失败分支），不再留原始栈。
  const projectsMgr = new Manager(new ProjectsStore(join(cwd, 'config', 'projects')), {
    selfRestart: () => {
      try {
        const fd = openLog(join(cwd, 'config', 'projects', 'self-restart.log'))
        const port = cfg.gateway.port
        // 等端口释放的逻辑写成一段**独立 Node 脚本**，而不是 shell 片段。
        // 为什么不用 shell：startDetached 在 Windows 上走 `cmd /c`，而
        // `while [ ] / $(( )) / ||` 那套是 POSIX 语法，cmd.exe 根本不认——
        // 上一版把等待写成 sh 片段，在 Windows 上等于没有等待（语法直接报错）。
        // 交给 Node 就没有方言问题：本进程已经在跑 Node，用同一个可执行文件。
        const waiter = `
          const net = require('net')
          const { spawn } = require('child_process')
          const port = ${JSON.stringify(port)}
          const argv = ${JSON.stringify(process.argv.slice(1))}
          const exe = ${JSON.stringify(process.execPath)}
          const cwd = ${JSON.stringify(cwd)}
          const deadline = Date.now() + 30000
          function free(cb) {
            const s = net.connect({ port, host: '127.0.0.1' })
            let done = false
            const fin = (ok) => { if (!done) { done = true; s.destroy(); cb(ok) } }
            s.once('connect', () => fin(false))   // 还连得上 = 旧进程仍在监听
            s.once('error', () => fin(true))      // 连不上 = 已释放
            setTimeout(() => fin(false), 1000)
          }
          ;(function poll() {
            free((isFree) => {
              if (isFree || Date.now() > deadline) {
                // 起新进程：与旧实现同样 detached + argv 原样复用
                const c = spawn(exe, argv, { cwd, detached: true, stdio: 'ignore' })
                c.unref()
                return
              }
              setTimeout(poll, 500)
            })
          })()
        `
        const cmd = `${quoteArg(process.execPath)} -e ${quoteArg(waiter)}`
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

  // Zen 指纹自愈（自动续期）：本机 opencode 日志是新鲜会话的唯一来源。
  //   · 启动刷新一次（尽力而为：没日志/没会话不阻断启动，只打日志）；
  //   · 转发中遇到 FINGERPRINT 失败 → 刷新后同候选重试一次（见 Proxy）；
  //   · 管理台可手动触发（POST /admin/api/providers/:pid/refresh-fingerprint）。
  // 本地无新鲜会话（用户很久没打开过客户端）时返回 null/指引——登录态无中生有不了，
  // 必须先跑一次客户端（opencode run "hi"），这是唯一需要人工的一步。
  const bootCfg = defaultConfig()
  const openCodeDirs = bootCfg.openCodeDirs ?? []
  const refreshOne = (providerId: number) =>
    refreshZenProvider(providers, syncStores, providerId, openCodeDirs)
  for (const rep of refreshAllZenProviders(providers, syncStores, openCodeDirs)) {
    console.log(`指纹启动刷新 ${rep.providerName}(#${rep.providerId}): ${rep.detail}`)
  }
  syncStores() // 刷新可能改了 Provider 静态头，再同步一次让调度即时生效
  px.setFingerprintRefresher(async (pv) => {
    const cur = providers.get(pv.providerId)
    if (!cur || !isZenBaseUrl(cur.baseUrl)) return null
    const rep = refreshOne(cur.providerId)
    if (!rep.updated) return null
    return providers.get(cur.providerId) ?? null
  })

  // zen 可调用性验证：发现页的探针必须真打一次，否则 GET /v1/models（免指纹）会把
  // 「网络通」误报成 ready，用户到手才发现 403 FreeTierError（真实假阳性）。
  const zenCallProbe: ZenCallProbe = async (model) => {
    const draft = defaultConfig()
    // 项目出口代理：探针与真实转发必须走同一个出口（见下方 p.egress 的注释）。
    // 与 sidecar 下载的决议口径一致——表里仅一项时自动采用（单 clash 最常见，多项不猜）。
    // 只在「没有已配置 zen Provider」的草稿分支用得到：有已配置 Provider 时它自带的
    // egress 就是用户为这个源指定的出口，那份优先。
    const projectEgressId = egresses.list().length === 1 ? egresses.list()[0]!.id : ''
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
    // 头集合与真机对齐（2026-09-18 取证）：x-opencode-* 四件套必带，
    // 旧 x-session-id/affinity 附带兼容（真机不发但多带无害）。
    const fp = discoverOpenCodeFingerprint(
      workBuddyDataNullsafe(draft.openCodeDirs))
    const autoHeaders: Record<string, string> = fp
      ? {
        'User-Agent': fp.userAgent,
        'x-opencode-client': 'cli',
        'x-opencode-project': 'global',
        'x-opencode-session': fp.sessionID,
        'x-opencode-request': mintZenRequestId(),
        'x-session-id': fp.sessionID,
        'x-session-affinity': fp.sessionID,
      }
      : {}
    const p: Provider = configured
      ? { ...configured, models: [{ id: model, manual: false, enabled: true, ...(configured.models.find((m) => m.id === model)?.api ? { api: configured.models.find((m) => m.id === model)!.api } : {}) }], probeModel: model }
      : {
        providerId: 0, name: 'opencode-zen-probe', state: 'active', displayName: 'probe',
        accessKind: 'reverse', risk: 'high', riskNote: 'probe', stability: 'beta',
        api: 'openai-completions', baseUrl: (draft.zenBaseURL ?? 'https://opencode.ai/zen') + '/v1',
        credential: { apiKeyEnv: 'ZEN_KEY' },
        headers: autoHeaders,
        // 出口代理：还没配过 zen Provider 的用户走这条草稿分支，**必须把项目已配的
        // 出口带上**。否则探针直连、真实转发走代理，两者的地区判定可以完全相反——
        // 探针把「有代理就能用的模型」报成「地区不可用」，用户照提示去配代理，
        // 而代理其实早就配好了（探测结论与真实链路不一致，是最难自证的一类假阴性）。
        // 与 sidecar 下载同源：项目 egress 表（表里仅一项时自动采用），
        // 即「用户在管理台配的出口就是这里用的出口」。
        ...(projectEgressId ? { egress: projectEgressId } : {}),
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
      // 探针必须带 tools —— 免费档的身份闸门看的是「请求长得像不像官方客户端的
      // agent 请求」，不只是指纹头。2026-09-20 用抓包拿到的真实 opencode 会话实测：
      // 同一会话同一秒，裸请求（只有一条 user 消息）恒 403 FreeTierError，
      // 加上 tools:[bash,read] 立刻 200 出字。形状定义与理由见 ZEN_PROBE_TOOLS。
      const req = zenProbeRequest(model)
      // 拿到 2xx 响应即算可调用——**不等首块**。
      //
      // streamWithTimeout 的契约：非 2xx 抛 UpstreamError，2xx 才返回 stream。
      // 所以「返回了」本身就证明上游接受了这个请求（指纹/鉴权/协议都对），
      // 而首块要等模型真正开始生成——实测 mimo 出首块要 7.4s，白等这一下
      // 就是用户感受到的「扫描好慢」。探针只验「没被拒」，不验生成速度。
      const stream = await probeUp.streamWithTimeout(p, req, AbortSignal.timeout(20_000))
      await stream.cancel().catch(() => {})
      return { ok: true }
    } catch (e) {
      const err = e as { kind?: string; message?: string }
      return { ok: false, kind: err.kind, error: err.message ?? String(e) }
    }
  }

  // discover 扫描器提出来：监听成功后要拿它预热缓存（见下方 scan() 调用），
  // 让「服务刚重启 → 第一次进 Provider/发现页」直接命中缓存，
  // 而不是由第一个页面请求同步等一次 2~8 秒的 zen 联网探测。
  const scanner = new Scanner({ ...defaultConfig(), zenCallProbe })
  const admin = createAdminApi({
    adminKey: cfg.gateway.adminKey,
    // 概览页接入区：前端据此决定 API Key 那行是「随便填」还是「去配 gateway_key」。
    // 只传布尔 + 默认模型名，不传 key 本体（管理口令都防泄漏，何况转发面密钥）。
    gateway: {
      authRequired: cfg.gateway.gatewayKey !== '',
      defaultModel: cfg.gateway.defaultModel,
    },
    egresses,
    providers,
    accounts,
    stats: usageStatsSource(usageStore),
    discover: new DiscoverSourceAdapter(scanner),
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
    fingerprint: { refreshFingerprint: async (pid) => refreshOne(pid) },
    lister: { listProviderModels: (pid) => probe.listProviderModels(pid) },
    modelProber: { probeModels: (pid, models) => probe.probeModels(pid, models) },
    notify: syncStores,
    sidecar: createSidecarApp(sidecarSvc, providers, syncStores, fetch, egresses, sidecarGuard),
    projects: createProjectsApp(projectsMgr, { defaultModel: cfg.gateway.defaultModel }),
  })

  const app = new Hono()
  // 来源体检 · Host 检查（防 DNS rebinding）：全局中间件，/v1 转发面与 /admin 管理面
  // 都挂（恶意域名 rebinding 到 127.0.0.1 后即同源，两个面都可能被直读/直写）。
  // 只在纯裸跑（admin_key 与 gateway_key 都为空）时启用——为什么不能改成全局启用，
  // 见 source_guard.ts 文件头注释（一句话：配了 key 的部署常有合法非回环 Host）。
  app.use('*', hostGuard({ adminKey: cfg.gateway.adminKey, gatewayKey: cfg.gateway.gatewayKey }))
  px.registerRoutes(app)
  app.route('/', admin)
  // 产物路径在模块加载时按「哪个候选目录含 web/dist」探测定下（见文件顶部 distRoot），
  // 探测发生在 dist 缺失时就会落到兜底值。这里直接报实际挂载的目录，避免指错路径。
  const distDir = join(distRoot, 'web', 'dist')
  app.route('/', createAdminUI(distDir))

  const server = serve({ fetch: app.fetch, port: cfg.gateway.port, hostname: cfg.gateway.host })

  // 绑定失败必须显式处理，否则 Node 会以「未处理的 'error' 事件」直接抛栈退出：
  // 用户看到的是 node:events:497 的一坨内部栈（EADDRINUSE），而不是「端口被谁占了、
  // 该怎么办」。真实故障：自我重启/update.sh/管理台「启动」并发时，旧进程尚未释放
  // port，新进程撞上 EADDRINUSE——日志里落下 18 次原始栈，且**先打印了「已启动」**
  // （下面那行在拿不到绑定结果时就执行了），于是「报成功但服务没起来」。
  // 现在：先等绑定结果，失败就给一句人话 + 非零退出，成功才报「已启动」。
  const bound = new Promise<boolean>((resolve) => {
    let settled = false
    server.on('listening', () => { if (!settled) { settled = true; resolve(true) } })
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) {
        // 绑定成功之后的错误不能吞：修复前的代码没有监听器，这类错误会作为
        // 「未处理的 'error' 事件」大声崩掉进程。若在这里静默 return，就从
        // 「崩得响」退化成「半死不活」——服务已经不听使唤，日志里却什么都没有。
        // 如实打出来（带够定位信息），进程去留交给进程管理器判断。
        console.error(
          `网关运行期错误（监听已建立后）：${err.code ?? 'unknown'} ${err.message}`
            + (err.stack ? `\n${err.stack}` : ''),
        )
        return
      }
      settled = true
      if (err.code === 'EADDRINUSE') {
        console.error(
          `启动失败：端口 ${cfg.gateway.host}:${cfg.gateway.port} 已被占用。\n` +
            `      多半是上一个网关进程还没退干净（自我重启/update.sh 并发时会撞上）。\n` +
            `      处理：lsof -tiTCP:${cfg.gateway.port} -sTCP:LISTEN 看是谁，停掉它再启动；\n` +
            `      或换端口：POLYCODE_PORT=其它端口 或 --port 其它端口。`,
        )
      } else {
        console.error(`启动失败：监听 ${cfg.gateway.host}:${cfg.gateway.port} 出错（${err.code ?? 'unknown'}）：${err.message}`)
      }
      resolve(false)
    })
  })
  if (!(await bound)) process.exit(1)

  console.log(`polycode-hub 已启动 http://${cfg.gateway.host}:${cfg.gateway.port}/admin/`)
  // 预热 discover 扫描缓存（后台跑，不阻塞启动）：zen 联网验证固有 2~8 秒，
  // 不预热的话，服务启动后第一个进 Provider/发现页的人要同步等这一次。
  // 失败静默——scan 内部会生成 unreachable 的 finding，这里只是提前触发。
  void scanner.scan().catch(() => {})
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
  // sidecar 保活守护（定时器已 unref）：
  // 开工先立刻 tick 一次——网关重启后引擎若是死的，不该等满一个周期才动手。
  void sidecarGuard.tick()
  const stopGuard = sidecarGuard.run()
  // 优雅退出（SIGINT/SIGTERM）：按序收摊，而不是打一行日志就 process.exit(0)。
  // 旧实现 `void server.close()` 后立即 exit —— close 回调永不执行，在途请求
  // （包括正在转发中的 SSE 流）被硬杀，SIGTERM 优雅退出形同虚设；
  // usageStore / admin.db 的 DatabaseSync 句柄也从不 close，WAL checkpoint
  // 只能等下次打开才恢复。
  //
  // 收摊顺序（每步的理由见行内注释）：
  //   1. 停巡检/保活 → 2. 发起 server.close()（停止接新连接）
  //   → 3. 掐掉空闲 keep-alive 连接让 drain 能完成 → 4. await close 完成
  //   → 5. 关掉所有持有 DatabaseSync 的 store（触发 WAL 落盘）
  //   → 6. 打「已退出」→ process.exit(0)。
  //
  // 幂等：第一次信号走完整收摊；第二次信号（用户按两次 = 不等了）直接强退。
  // 兜底：8 秒看门狗，任何一步卡住（如某条流迟迟不结束）仍会退出，
  // 防止「优雅」退化成「挂死」；正常路径两处都 clearTimeout。
  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      console.log(`再次收到 ${signal}，强制退出`)
      process.exit(0)
    }
    shuttingDown = true
    const forceExit = setTimeout(() => {
      console.warn('优雅退出超时（8s 未完成），强制结束进程')
      process.exit(0)
    }, 8000)
    void (async () => {
      stopSweeper() // 先停巡检，再关服务，避免退出期间还在改状态文件
      stopGuard()   // 停保活：退出过程中不该再拉起引擎
      // server.close() 的回调要等**在途请求全部结束**才触发，所以先发起、
      // 走完第 3 步再 await —— 直接 void 掉就等于没人等它（旧实现的病根）。
      const closing = new Promise<void>((resolve) => { server.close(() => resolve()) })
      // 只关**空闲**的 keep-alive 连接：close() 会等这些连接被回收，而空闲连接
      // 可能长期挂着，不掐掉 drain 永远完不成；在途请求所在的连接是「忙」的，
      // 不受影响，跑完才放行。绝不能用 closeAllConnections —— 那会硬杀正在跑的
      // 请求/SSE 流，退回旧实现的毛病。ServerType 是 http/http2 联合类型，
      // http2 分支没有这个方法，故按可选成员访问（本项目实际走 http）。
      ;(server as { closeIdleConnections?: () => void }).closeIdleConnections?.()
      await closing
      // 三个 store 各自 open() 时都 new 了独立的 DatabaseSync（见 adminapi/store.ts
      // 的 openAdminDB），句柄并不共享 —— 所以逐个关、每个只关一次即可，
      // 不存在重复 close 同一句柄的问题；accounts.seedLedger() 复用 accounts 的
      // 句柄且自身不暴露 close，故不单独关。SQLiteEgressStore 没有暴露 close()
      // （store.ts 不在本次修改范围），它那一个句柄交给进程退出兜底。
      usageStore.close()
      providers.close()
      accounts.close()
      clearTimeout(forceExit)
      console.log('已退出')
      process.exit(0)
    })().catch((e) => {
      // 收尾任一步抛错（如 store 已被别处关过）也不能把进程挂住：
      // 打出来、清看门狗、照样退出，退出码仍为 0（服务已停止是既成事实）。
      console.error('优雅退出收尾出错:', e)
      clearTimeout(forceExit)
      process.exit(0)
    })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
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
  // 与发现页「采用」共用同一条判据（不许两处各写一份：口径漂移过一次了）。
  // 本机发现了就允许导入，联网探测没通不拦（见 notAdoptableReason 注释）。
  const blocked = notAdoptableReason(found)
  if (blocked) fatal(new Error(blocked))
  if (found.status !== 'ready') {
    console.warn(`注意：${found.harness} 探测未通过（${found.status}）——仍按你的要求导入，之后可能需换出口/补指纹`)
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
    if (action === 'install' || action === 'ensure') {
      // 下载走代理（不写死地址）：决议顺序见 resolveSidecarDownloadFetch——
      // 显式 --proxy → 显式 --egress <id> → 项目 egress 表（zcode-plan-local
      // 的 egress 引用，或表里仅一项时自动采用）→ HTTPS_PROXY → 系统代理 → 直连。
      // 项目 egress 表是「复用项目配置」的主路径：用户在管理台配的出口就是这里用的出口。
      const cfg = loadOrDefault(process.env.POLYCODE_CONFIG ?? join(cwd, 'config', 'apps.yaml'))
      let explicitProxy = ''
      let egressId = ''
      for (let i = 2; i < args.length - 1; i++) {
        if (args[i] === '--proxy') explicitProxy = args[i + 1] ?? ''
        if (args[i] === '--egress') egressId = args[i + 1] ?? ''
      }
      // egress 表以 DB 为准（与 serve 同源），DB 不可用时回落配置文件里的定义。
      let egressList: { id: string; kind: string; addr: string }[] = cfg.egresses
      try {
        const store = await SQLiteEgressStore.open(join(cwd, cfg.dataDir, 'admin.db'))
        const fromDB = store.list()
        if (fromDB.length > 0) egressList = fromDB
      } catch { /* 库不可用 → 用配置文件里的定义 */ }
      const provider = await (async () => {
        try {
          const providers = await SQLiteProviderStore.open(join(cwd, cfg.dataDir, 'admin.db'))
          return providers.getByName('zcode-plan-local')
        } catch { return undefined }
      })()
      let dl: ReturnType<typeof resolveSidecarDownloadFetch>
      try {
        dl = resolveSidecarDownloadFetch({
          explicitProxy, egressId,
          providerEgressId: provider?.egress ?? '',
          egressList,
        })
      } catch (e) {
        fatal(e as Error) // 显式指定的 egress 不存在/不支持：点名报错，不静默换出口
      }
      console.log(`下载走代理: ${maskProxyURI(dl.proxyURI)}（来源 ${dl.source}）`)
      // 终端也要能看见进度：87MB 在弱网下会被反复掐断，续传时进度必须
      // 一路往上走。只打「安装中…」的话，用户分不清是在续传还是已经死了。
      let lastLine = 0
      const onProgress = (p: { phase: string; received: number; total: number }): void => {
        const now = Date.now()
        if (now - lastLine < 2000 && p.phase === 'downloading') return
        lastLine = now
        if (p.phase !== 'downloading') { console.log(`  ${p.phase}…`); return }
        const mb = (n: number): string => (n / 1048576).toFixed(1)
        const pct = p.total > 0 ? ` ${Math.round((p.received / p.total) * 100)}%` : ''
        console.log(`  下载中${pct} ${mb(p.received)}/${mb(p.total)} MB（断线会自动续传）`)
      }
      if (action === 'install') {
        const p = await sc.install(args.includes('--force'), { fetch: dl.fetch, onProgress, proxySource: dl.source })
        console.log('已安装:', p)
        return
      }
      // proxySource 必须传：零推进双向回退要靠它判断「当前在哪条路、还有没有
      // 另一条可换」。漏传会让 CLI 的下载把回退整个禁用（子代理审查抓到的 P1）。
      await sc.ensureReady(sc.workDir, { fetch: dl.fetch, onProgress, proxySource: dl.source })
      console.log('sidecar 就绪:', await sc.status())
      console.log('网关凭据:', sc.credKey)
      return
    }
    switch (action) {
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
