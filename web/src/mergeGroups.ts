// 归因表手动合并：纯函数（Dashboard.vue 的合并组逻辑抽出来，可单测）。
// 口径与 Dashboard.vue byModel 一致：数字字段相加；命中率按总命中/总输入重算；
// TPS/TTFT 按 sampled 加权平均。

export interface MergeRow {
  providerId: string
  sourceId: string
  modelId: string
  requests?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  errors?: number
  cacheHitRate?: number | null
  avgTps?: number | null
  avgTtftMs?: number | null
  sampled?: number
}

export interface MergeGroup {
  id: string // group-开头的本地 id
  name: string // 用户起的组名
  keys: string[] // providerId/modelId 组合键
}

export const rowKey = (r: Pick<MergeRow, 'providerId' | 'modelId'>): string =>
  `${r.providerId}/${r.modelId}`

/** 反推一行的输入侧分母（命中数 / 命中率；率为 0 或 null 时分母为 0）。 */
export function denomOf(r: Pick<MergeRow, 'cacheReadTokens' | 'cacheHitRate'>): number {
  const rate = r.cacheHitRate
  return rate != null && rate > 0 ? (r.cacheReadTokens || 0) / rate : 0
}

const NUM_FIELDS = ['requests', 'inputTokens', 'outputTokens', 'cacheReadTokens',
  'cacheCreationTokens', 'reasoningTokens', 'totalTokens', 'errors'] as const

/** 多行合成一行：数字相加，命中率按总命中/总输入，TPS 按 sampled 加权。 */
export function mergeRows(rows: MergeRow[], name: string): MergeRow {
  const acc: MergeRow = {
    providerId: name, sourceId: '', modelId: '',
    requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 0, errors: 0,
    cacheHitRate: null, avgTps: null, avgTtftMs: null, sampled: 0,
  }
  let num = 0
  let denom = 0
  let tpsNum = 0
  let tpsDen = 0
  let ttftNum = 0
  let ttftDen = 0
  for (const m of rows) {
    for (const f of NUM_FIELDS) acc[f] = (acc[f] || 0) + (m[f] || 0)
    num += m.cacheReadTokens || 0
    denom += denomOf(m) || m.inputTokens || 0
    acc.sampled = (acc.sampled || 0) + (m.sampled || 0)
    if (m.avgTps != null) { tpsNum += m.avgTps * (m.sampled || 0); tpsDen += m.sampled || 0 }
    if (m.avgTtftMs != null) { ttftNum += m.avgTtftMs * (m.sampled || 0); ttftDen += m.sampled || 0 }
  }
  // 命中率 = 总命中 / 总输入（与后端 hitRate 同口径 read/input；denomOf 反推即 input）
  acc.cacheHitRate = denom > 0 ? num / denom : null
  acc.avgTps = tpsDen > 0 ? tpsNum / tpsDen : null
  acc.avgTtftMs = ttftDen > 0 ? ttftNum / ttftDen : null
  return acc
}

/**
 * 对行列表应用手动合并组：组内多行合成一行（ members 挂明细供展开）。
 * 未分组的行原样返回。组顺序 = 组内首行出现的位置。
 * 返回 { rows, unmatched }：unmatched 是没在行列表里找到 ≥2 个成员的组 id 列表
 * （调用方据此提示用户，避免静默失败）。
 */
export interface GroupedRow extends MergeRow {
  _groupId?: string
  _members?: MergeRow[]
}

export function applyGroups(rows: MergeRow[], groups: MergeGroup[]): GroupedRow[] {
  return applyGroupsReport(rows, groups).rows
}

export function applyGroupsReport(
  rows: MergeRow[], groups: MergeGroup[],
): { rows: GroupedRow[]; unmatched: string[] } {
  if (!groups.length) return { rows: [...rows], unmatched: [] }
  const present = new Set(rows.map(rowKey))
  const unmatched = groups.filter((g) => g.keys.filter((k) => present.has(k)).length <= 1).map((g) => g.id)
  const keyToGroup = new Map<string, MergeGroup>()
  for (const g of groups) for (const k of g.keys) keyToGroup.set(k, g)
  // 同一 key 被两个组引用时，先声明的组赢（后声明的组忽略该 key，不静默吞行）
  const out: GroupedRow[] = []
  const done = new Set<string>()
  for (const r of rows) {
    const g = keyToGroup.get(rowKey(r))
    if (!g || done.has(g.id)) {
      if (!g) out.push({ ...r })
      continue
    }
    done.add(g.id)
    const members = rows.filter((x) => g.keys.includes(rowKey(x))).map((x) => ({ ...x }))
    if (members.length <= 1) {
      for (const m of members) out.push(m)
      continue
    }
    out.push({ ...mergeRows(members, g.name), _groupId: g.id, _members: members })
  }
  return { rows: out, unmatched }
}
