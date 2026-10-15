// Zen 指纹刷新：本机 opencode 日志里的新鲜会话 → 写回 Provider 静态头。
//
// 为什么需要：免费档指纹里的 x-opencode-session 会过期（会话是按次运行产生的，
// 放着不用就失效）；网关静态头里存的是采用那一刻的值，不会自动变新。
// 只要用户本机还跑过 opencode（日志里有新鲜会话），这里就能自动续上；
// 用户很久没打开过客户端 → 日志里也没有新鲜会话 → 如实返回 next 指引，
// 必须先跑一次客户端（程序无中生有不了登录态）。
//
// 本模块 import-safe（cli 与测试都能引，不启动服务）：只做“读日志 + 写 store”。

import { readFileSync } from 'node:fs'
import {
  discoverAllOpenCodeFingerprints, discoverOpenCodeFingerprint, latestSessionMessageId,
  type OpenCodeFingerprint,
} from './index.ts'
import {
  findHeaderKey, isZenBaseUrl, mintZenRequestId, mintZenSessionPool, parseZenSessionPool,
  validZenRequestId, writeZenSessionPool,
  ZEN_POOL_MAX, ZEN_REQUEST_HEADER, ZEN_SESSION_HEADER, ZEN_SESSION_ID_HEADER, ZEN_UA_DEFAULT,
  type Provider,
} from '../model/index.ts'
import type { FingerprintRefreshReport } from '../adminapi/types.ts'

// 会话池头与读写工具由 model 层定义（discover 写入、router 轮换取用），
// 这里重导出以保持既有 import 路径可用。
export { ZEN_SESSION_POOL_HEADER, parseZenSessionPool, writeZenSessionPool } from '../model/index.ts'

// 需要的最小 store 形状（SQLite/Memory 两实现都满足；测试可传桩）。
export interface ZenProviderStore {
  get(id: number): Provider | undefined
  list(): Provider[]
  put(p: Provider): void
}

// 长闲置指引（唯一文案：刷新端点、代理错误日志、前端共用同一句，不多写版本）。
export const NO_LOCAL_FINGERPRINT_NEXT =
  '本机没有新鲜的 opencode 会话（很久没打开过客户端时登录态无法自动续）——' +
  '先在本机跑一次 opencode（如 opencode run "hi"），产生新鲜会话后再点刷新'

// 刷新单个 Provider。非 zen 上游直接返回 updated=false（不是错误）。
// 成功写回后调 notify（调度热重载），调用方无需再同步。
export function refreshZenProvider(
  store: ZenProviderStore, notify: () => void,
  providerId: number, openCodeDirs: string[],
): FingerprintRefreshReport {
  const p = store.get(providerId)
  if (!p) throw new Error(`provider #${providerId} 不存在`)
  const base: FingerprintRefreshReport = {
    providerId: p.providerId, providerName: p.name,
    updated: false, sessionChanged: false, detail: '',
  }
  if (!isZenBaseUrl(p.baseUrl)) {
    return { ...base, detail: `非 Zen 上游（${p.baseUrl}），无需刷新指纹` }
  }
  // 会话池：本机近期真实用过的全部会话（旧→新），最新那个当主会话。
  // 本机一个都没有（用户没装过 opencode）时**不再报错让用户去跑客户端**：
  // 现铸一池顶上。上游只校验形状与低12位下界、不验真伪（见
  // model.mintZenSessionId 的实测），所以现铸与真值等效，这一步可以彻底免掉。
  // 仍保留一条路径差异：本机有真会话时优先用真的（它带真实 modelID 归因，
  // 且在用户真在用客户端时窗口最新鲜）。
  const pool = discoverAllOpenCodeFingerprints(openCodeDirs)
  if (pool.length === 0) return refreshZenWithMinted(store, notify, p, base)
  const fp: OpenCodeFingerprint = pool[pool.length - 1]!
  const h: Record<string, string> = { ...(p.headers ?? {}) }
  const curKey = findHeaderKey(h, ZEN_SESSION_HEADER)
  const cur = (curKey !== undefined ? h[curKey] : undefined) ?? ''
  // msg 取该会话在日志里最后一次的（一次会话内稳定）；没有则沿用静态值，
  // 还没有才现铸（上游只校验形状不校验真伪，见 model.mintZenRequestId）。
  let msg = readSessionMessage(fp.logPath, fp.sessionID)
  if (!msg) {
    // 静态值必须先过**严格形状**校验再沿用：旧实现往库里写过 28 位残值，
    // 那种值带出去恒 403；它该被现铸值覆盖，而不是当作新鲜值保留。
    const staticReqKey = findHeaderKey(h, ZEN_REQUEST_HEADER)
    const sv = ((staticReqKey !== undefined ? h[staticReqKey] : undefined) ?? '').trim()
    if (validZenRequestId(sv)) msg = sv
  }
  if (!msg) msg = mintZenRequestId()
  // UA 同步（网关权威后客户端 UA 不再补充，静态 UA 必须自己跟上版本，
  // 否则 opencode 一升级、静态 UA 落后就可能被上游按版本卡）：
  // 缺 UA，或版本号与本次识别到的不一致 → 写回识别到的真串。
  const uaKey = findHeaderKey(h, 'user-agent')
  const curUA = ((uaKey !== undefined ? h[uaKey] : undefined) ?? '').trim()
  const uaStale = uaVersion(curUA) !== fp.version
  // 池内容（新→旧）：最近用的会话排首位，首打就用它（配额窗口最干净）；
  // 撞 429 才在请求副本内顺序换下一个重打（见 router/upstream.ts streamWith）。
  // 刻意不用“逐请求预防性轮换”：每请求换一个只会把所有会话的窗口同时打满，
  // 还破坏上游按会话的亲和性。
  const poolIDs = pool.map((x) => x.sessionID).reverse()
  const oldPool = parseZenSessionPool(h)
  const poolChanged = oldPool.join(',') !== poolIDs.join(',')
  const primary = poolIDs[0] ?? fp.sessionID
  // 孪生头是否缺失/过期：存量 Provider 里没有这个头（它是 2026-10-15 才补录的），
  // 不把它算进「要不要刷新」的话，那些行永远补不上，UA 一旦升级到 1.19.0 就全量 403。
  const sidKey = findHeaderKey(h, ZEN_SESSION_ID_HEADER)
  const curSid = ((sidKey !== undefined ? h[sidKey] : undefined) ?? '').trim()
  const sidStale = curSid !== primary
  if (cur === primary && !sidStale && hasValidRequest(h) && !uaStale && !poolChanged) {
    return { ...base, detail: `已是最新（与本机会话 ${primary} 一致，池 ${poolIDs.length} 个），无需刷新` }
  }
  // sessionChanged 只描述「主会话变了」这一件事（它驱动调度器的会话热重载）。
  // 补孪生头不是会话变更，不往这里塞——两件事混在一起，调用方就再也分不清
  // 「该重载会话」还是「只是补了个头」。
  const sessionChanged = cur !== primary
  setHeader(h, ZEN_SESSION_HEADER, primary)
  // 孪生头必须同步：UA ≥ 1.19.0 时上游必查它，且要求与 session 同值。
  // 刷新只换 session 不换它 → 两个头不一致 → 403（实测）。
  setHeader(h, ZEN_SESSION_ID_HEADER, primary)
  setHeader(h, ZEN_REQUEST_HEADER, msg)
  writeZenSessionPool(h, poolIDs)
  let uaNote = ''
  if (uaStale) {
    setHeader(h, 'User-Agent', fp.userAgent)
    uaNote = `；UA 已同步为 ${fp.userAgent}`
  }
  // 旧版 x-session-id 若还在（历史配置），同步跟上——它是晋升路径的输入。
  if (findHeaderKey(h, 'x-session-id') !== undefined) setHeader(h, 'x-session-id', primary)
  // x-session-affinity 是毒头（带则恒 403，见 applyZenFingerprint）：顺手清掉，
  // 否则历史配置里存着的这一行会一直把请求毒死，用户看不出是配置里多了一行。
  const affKey = findHeaderKey(h, 'x-session-affinity')
  if (affKey !== undefined) delete h[affKey]
  p.headers = h
  store.put(p)
  notify()
  return {
    ...base, updated: true, sessionChanged,
    detail: `已更新为本机会话 ${primary}（来自 ${fp.logPath}` +
      `${fp.modelID ? `，该会话用过 ${fp.modelID}` : ''}）` +
      `${poolIDs.length > 1 ? `；会话池 ${poolIDs.length} 个可轮换` : ''}${uaNote}`,
  }
}

// 本机一个 opencode 会话都采不到时的刷新路径：现铸一池会话 + 兜底 UA。
//
// 为什么可以把「先用一次客户端」这一步免掉：上游对 ses_ 只校验形状
// （`ses_` + 12 位小写 hex + 14 位 base62）与一个数值下界（前 12 位 hex 的
// 低 12 位 ≥ 0xfc0），**不验真伪、不验时效**——现铸值 × 3 个免费模型各打 5 次
// 全 200，40 次「每次全新现铸」40/40，单会话连打 60 次未出窗口。
// UA 同理有硬性最低版本（< 1.18.0 → 426），所以不能留空，用 ZEN_UA_DEFAULT。
//
// 取舍：现铸的会话**覆盖**库里的旧会话（若旧值形状不合）——旧值不合就是恒 403，
// 不如换成已知可用的。库里有合规真会话时不会走到这里（调用方已提前分支）。
function refreshZenWithMinted(
  store: ZenProviderStore, notify: () => void, p: Provider, base: FingerprintRefreshReport,
): FingerprintRefreshReport {
  const h: Record<string, string> = { ...(p.headers ?? {}) }
  const minted = mintZenSessionPool(ZEN_POOL_MAX)
  const primary = minted[0]!
  setHeader(h, ZEN_SESSION_HEADER, primary)
  setHeader(h, ZEN_SESSION_ID_HEADER, primary)
  setHeader(h, 'x-session-id', primary)
  // request 头也一并现铸：库里存的旧 28 位残值不合形状，留着它比不带更糟（必 403）。
  setHeader(h, ZEN_REQUEST_HEADER, mintZenRequestId())
  writeZenSessionPool(h, minted)
  // UA：静态已配且版本达标的不动（显式配置优先），否则写兜底值。
  const uaKey = findHeaderKey(h, 'user-agent')
  const curUA = ((uaKey !== undefined ? h[uaKey] : undefined) ?? '').trim()
  let uaNote = ''
  if (!/^opencode\/[^\s/]+\//.test(curUA) && !uaVersion(curUA)) {
    setHeader(h, 'User-Agent', ZEN_UA_DEFAULT)
    uaNote = `；UA 补为 ${ZEN_UA_DEFAULT}`
  }
  const affKey = findHeaderKey(h, 'x-session-affinity')
  if (affKey !== undefined) delete h[affKey]
  p.headers = h
  store.put(p)
  notify()
  return {
    ...base, updated: true, sessionChanged: true,
    detail: `本机无 opencode 会话，已现铸 ${minted.length} 个会话（上游只校验形状与下界，不验真伪）${uaNote}`,
  }
}

// 从 UA 里取 opencode 版本号（`opencode/1.18.29 …` 首段）；取不到返回 ''。
// 缺 UA 时同样返回 ''——调用方按“与识别版本不一致”处理，顺带覆盖缺失。
function uaVersion(ua: string): string {
  const m = /^opencode\/([^\s]+)/.exec(ua.trim())
  return m ? m[1]! : ''
}

// 刷新全部 Zen Provider（启动时调用）：逐个尽力而为，单个失败不影响其他，
// 返回每个的结果（调用方只打日志，不阻断启动）。
export function refreshAllZenProviders(
  store: ZenProviderStore, notify: () => void, openCodeDirs: string[],
): FingerprintRefreshReport[] {
  const out: FingerprintRefreshReport[] = []
  for (const p of store.list()) {
    if (p.state === 'deleted' || !isZenBaseUrl(p.baseUrl)) continue
    try {
      out.push(refreshZenProvider(store, notify, p.providerId, openCodeDirs))
    } catch (e) {
      out.push({
        providerId: p.providerId, providerName: p.name,
        updated: false, sessionChanged: false,
        detail: `刷新失败: ${(e as Error).message}`,
      })
    }
  }
  return out
}

function readSessionMessage(logPath: string, sessionID: string): string | undefined {
  let text: string
  try {
    text = readFileSync(logPath, 'utf8')
  } catch {
    return undefined
  }
  return latestSessionMessageId(text, sessionID)
}

function hasValidRequest(h: Record<string, string>): boolean {
  const k = findHeaderKey(h, ZEN_REQUEST_HEADER)
  const v = (k !== undefined ? h[k] : undefined) ?? ''
  // 严格形状（不是 validZenToken）：库里存着旧实现写的 28 位残值时，
  // 这里要判「不合格」才能触发刷新把它换成现铸值。
  return validZenRequestId(v)
}

function setHeader(h: Record<string, string>, name: string, value: string): void {
  const k = findHeaderKey(h, name)
  if (k !== undefined) h[k] = value
  else h[name] = value
}
