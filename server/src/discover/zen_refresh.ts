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
  findHeaderKey, isZenBaseUrl, mintZenRequestId, validZenToken, parseZenSessionPool,
  writeZenSessionPool,
  ZEN_REQUEST_HEADER, ZEN_SESSION_HEADER,
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
  // 兼容旧行为：没有任何会话时按老路径返回指引。
  const pool = discoverAllOpenCodeFingerprints(openCodeDirs)
  const fp: OpenCodeFingerprint | undefined = pool[pool.length - 1]
  if (!fp) {
    const none = discoverOpenCodeFingerprint(openCodeDirs)
    return none
      ? { ...base, detail: '本机没有可用的 opencode 会话' }
      : { ...base, detail: '本机没有可用的 opencode 会话', next: NO_LOCAL_FINGERPRINT_NEXT }
  }
  const h: Record<string, string> = { ...(p.headers ?? {}) }
  const curKey = findHeaderKey(h, ZEN_SESSION_HEADER)
  const cur = (curKey !== undefined ? h[curKey] : undefined) ?? ''
  // msg 取该会话在日志里最后一次的（一次会话内稳定）；没有则沿用静态值，
  // 还没有才现铸（格式与观测一致；唯一性有收益，时间绑定则听天由命）。
  let msg = readSessionMessage(fp.logPath, fp.sessionID)
  if (!msg) {
    // 静态值先过白名单再沿用：脏值只脏发送头、不再写回库（upstream 发包侧同样现铸兜底）。
    const staticReqKey = findHeaderKey(h, ZEN_REQUEST_HEADER)
    const sv = ((staticReqKey !== undefined ? h[staticReqKey] : undefined) ?? '').trim()
    if (validZenToken(sv)) msg = sv
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
  if (cur === primary && hasValidRequest(h) && !uaStale && !poolChanged) {
    return { ...base, detail: `已是最新（与本机会话 ${primary} 一致，池 ${poolIDs.length} 个），无需刷新` }
  }
  const sessionChanged = cur !== primary
  setHeader(h, ZEN_SESSION_HEADER, primary)
  setHeader(h, ZEN_REQUEST_HEADER, msg)
  writeZenSessionPool(h, poolIDs)
  let uaNote = ''
  if (uaStale) {
    setHeader(h, 'User-Agent', fp.userAgent)
    uaNote = `；UA 已同步为 ${fp.userAgent}`
  }
  // 旧版 x-session-id/affinity 若还在（历史配置），同步跟上——它们是晋升路径的输入。
  if (findHeaderKey(h, 'x-session-id') !== undefined) setHeader(h, 'x-session-id', primary)
  if (findHeaderKey(h, 'x-session-affinity') !== undefined) setHeader(h, 'x-session-affinity', primary)
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
  return validZenToken(v.trim())
}

function setHeader(h: Record<string, string>, name: string, value: string): void {
  const k = findHeaderKey(h, name)
  if (k !== undefined) h[k] = value
  else h[name] = value
}
