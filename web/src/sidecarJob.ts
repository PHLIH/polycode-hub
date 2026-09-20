// ZCode 本地引擎（sidecar）的共享状态 + 安装进度。
//
// 为什么单独抽一个模块：
//   App.vue 切页用的是没有 keep-alive 的 <component :is>，视图组件切走即卸载、
//   切回即重建。原来「安装中」存在组件 ref 里（Providers 的 qiBusy、Discover 的
//   scBusy），于是切页回来按钮变回「一键安装」——而服务端其实还在下载（普通
//   fetch 不随组件卸载 abort）。页面显示的状态和事实分叉，用户再点一次就会发出
//   第二个 POST /ensure（两个 ensureReady 并发往同一个 dest+'.part' 写）。
//
// 所以这里做两件事：
//   1. 状态放模块级：同一时刻所有视图读的是同一份，切页不丢；
//   2. 真相源放服务端：只要 install.running 为真就按 1 秒轮询 GET /admin/api/sidecar，
//      切页、刷新、开第二个标签页都能接上同一次安装（服务端对并发 ensure 做了单飞）。
//
// 进度本身由后端侧边车 install() 的 onProgress 提供：阶段 + 已收字节/总字节，
// 所以页面能显示「正在下载引擎 45%（30.1 / 66.4 MB · 已用 1 分 12 秒）」，
// 而不是一个静止的「安装中…」。

import { computed, onMounted, onUnmounted, ref, type ComputedRef, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from './api.js'
import { detailOf, errorOf, percentOf, phaseLabelOf, proxyOf } from './sidecarProgress'
import type { InstallJobLike } from './sidecarProgress'

const POLL_MS = 1000

export type InstallJobView = InstallJobLike

export interface SidecarView {
  running: boolean
  status: string
  // probe 是三态探活结果：up=可用 / hung=端口在监听但不响应（卡死）/
  // down=没启动。卡死时「启动」必然被端口拦下，必须先「停止」。
  probe?: 'up' | 'hung' | 'down'
  installed: boolean
  port: string
  workDir: string
  credFile: string
  hasKey: boolean
  endpoint: string
  custom: boolean
  downloadProxy: string
  downloadProxySource: string
  install: InstallJobView
}

// —— 模块级单例（跨视图共享，切页不丢） ——
const sc: Ref<SidecarView | null> = ref(null)
// busy 只覆盖「点下去 → 服务端作业接管」这段真空期（POST 在途但 install 还没标 running）。
const busy = ref(false)
// optimistic 表示「用户刚点了安装，服务端的作业态可能还没标 running」。
// 它是让进度条**立刻**出现的那一帧：没有它，点击后的头几百毫秒到几秒里
// install.running 仍是 false，syncPoll 不会起轮询，按钮就还是「一键安装」。
const optimistic = ref(false)
// stale = 最近一次状态拉取失败。用来把「还没读到」（切页瞬间）与
// 「真的读不到」（后端未起/未鉴权）分开——否则每次切页都会闪一句「获取失败」。
const stale = ref(false)
let timer: ReturnType<typeof setInterval> | null = null
let consumers = 0

async function refresh(): Promise<void> {
  try {
    sc.value = await api.sidecarStatus()
    stale.value = false
  } catch {
    // 后端未起/未鉴权：保留上一次已知状态，不要把「网络错」渲染成「未安装」。
    stale.value = true
  }
  syncPoll()
}

function stopPoll(): void {
  if (timer !== null) { clearInterval(timer); timer = null }
}

function syncPoll(): void {
  // 「服务端说在跑」或「用户刚点了、作业态还没标起来」都要轮询。
  // 只看前者的话，点击后到服务端标 running 之间没有轮询，界面就卡在旧状态。
  const running = sc.value?.install?.running === true || optimistic.value
  if (running && timer === null && consumers > 0) {
    timer = setInterval(() => { void refresh() }, POLL_MS)
  } else if (!running) {
    stopPoll()
  }
}

const job = computed<InstallJobView | null>(() => sc.value?.install ?? null)
const running = computed(() => job.value?.running === true)
// installing 是视图真正该看的那个：服务端作业在跑，**或者**用户刚点下、作业态
// 还没标起来。少了后半个条件，从点击到服务端响应之间界面仍是「一键安装」，
// 用户以为没点动——这正是「必须切页才变进度条」的直接成因。
//
// 但 optimistic 必须**只在还没拿到服务端答复之前**起作用。真实缺陷（用户报告
// 「下载完成后，进度条又变成了……正在安装」）：作业其实早就结束了
// （服务端 install.running=false 且 installed=true），而 start() 里的 POST 若迟迟
// 不返回（或视图在中途重新挂载），optimistic 就一直为真，界面于是永远停在
// 「正在安装」，和下面「installed, stopped」「上次安装失败」自相矛盾。
// 所以：一旦拿到作业态且它明确不在跑，就不再算「安装中」。
const installing = computed(() => {
  if (running.value) return true
  // 「作业态已有结论」（成功/失败/取消，finishedAt 已落值）→ 以服务端为准，
  // 不听 optimistic——否则作业结束后、POST 还在途的那段时间，界面会永远停在
  // 「正在安装」，和下面「installed, stopped」「上次安装失败」自相矛盾。
  //
  // 但判据必须是「有没有结论」，**不是「install 字段存在不存在」**：服务端
  // GET / 永远返回非空 install（空闲时是全 0 的初值），按后者判的话 optimistic
  // 永远没有出场机会——点击安装后的头 1 秒（POST 在途、作业还没标 running）
  // 按钮又变回「一键安装」，用户以为没点动（子代理审查抓到的口径错位）。
  const inst = sc.value?.install
  if (inst != null && (inst.ok || inst.error !== '' || inst.cancelled === true || (inst.finishedAt ?? 0) !== 0)) return false
  return optimistic.value
})

// 下面四个 computed 的取值规则都在 sidecarProgress.ts 里（纯函数、有单测）：
// 百分比只在有总数时给、失败原因常驻并标注「上次」、字节与耗时的拼法。
const percent = computed(() => percentOf(job.value))
const phaseText = computed(() => phaseLabelOf(job.value))
const detailText = computed(() => detailOf(job.value))
const errorText = computed(() => errorOf(job.value))
const proxyText = computed(() => proxyOf(job.value))

// start 是「一键安装 / 一键启动」的唯一入口（后端 ensure = 装→配→起）。
// 返回 true 表示这次没有失败（含「接上了已在跑的作业」），调用方据此决定
// 要不要再刷新自己的列表。
//
// 真实缺陷（用户报告：「点下载后按钮不会自动变进度条，得切页再切回来」）：
// 这里原来是一句 `await api.sidecarAction('ensure')` —— POST 要等整个
// 下载+启动跑完才返回（首次 87MB，几分钟），而轮询只在 syncPoll 看到
// install.running 时才启动。点击那一刻读到的是**点击前的旧快照**
// （running=false），于是轮询根本没起来，页面就一直停在「一键安装」；
// 直到用户切页触发 onMounted→refresh 才第一次读到服务端进度。
//
// 修法：POST 与轮询并发——先乐观地把 busy 立起来让按钮立刻变成进度条，
// 再让 POST 在后台跑，同时用一个短周期轮询去接管真实进度。
async function start(): Promise<boolean> {
  if (busy.value) return false
  busy.value = true
  // 乐观态：点击后立刻显示「正在查询最新版本」，不等服务端第一次回包。
  // 没有这一步，POST 在途的那几秒按钮还是「一键安装」，看起来像没点动。
  optimistic.value = true
  try {
    // 先拉一次：服务端可能已经有一个在跑的作业（上次切页前点的），
    // 那就直接接上进度，而不是再发一次 POST。
    await refresh()
    if (sc.value?.install?.running === true) return true
    // 关键：**不要 await 到底**。POST 在后台跑，立刻开始按 1 秒轮询接管进度。
    // POST 自己返回时只代表「这一轮结束了」，真实结果以作业态为准（下面 finally 里读）。
    //
    // settled 必须是独立标记，**不能用「race 结果 === false」当继续条件**：
    // 旧写法 `Promise.race([post, sleep]) === false` 在 POST 一失败就死循环——
    // post 永远以 false 兑现，race 每次立刻取到 false，循环永不退出，
    // finally 到不了 → busy 恒为 true → 两个页面的安装按钮从此全部失效
    // （且新加的「暂停/取消」会 abort 下载让服务端回 500，恰好触发它）。
    let settled: boolean | null = null
    const post = api.sidecarAction('ensure').then(
      () => { settled = true },
      () => { settled = false }, // 失败详情在服务端作业态里，由 errorText 就地显示
    )
    while (settled === null) {
      await Promise.race([post, sleep(POLL_MS)])
      if (settled === null) await refresh()
    }
    if (!settled) return false
    ElMessage.success('ZCode 本地引擎已就绪')
    return true
  } catch {
    // 失败详情在服务端作业态里，refresh 之后由 errorText 就地显示。
    // 这里刻意不弹 toast：toast 会消失，用户切页回来就不知道发生过什么。
    return false
  } finally {
    busy.value = false
    optimistic.value = false
    await refresh()
  }
}

// sleep 是 start 里「等 POST 或等一个轮询周期，谁先到算谁」用的。
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })

export interface UseSidecar {
  sc: Ref<SidecarView | null>
  job: ComputedRef<InstallJobView | null>
  running: ComputedRef<boolean>
  busy: Ref<boolean>
  installing: ComputedRef<boolean>
  stale: Ref<boolean>
  percent: ComputedRef<number | null>
  phaseText: ComputedRef<string>
  detailText: ComputedRef<string>
  errorText: ComputedRef<string>
  proxyText: ComputedRef<string>
  start: () => Promise<boolean>
  // pause 暂停：停止下载但**保留**已下的部分，下次点安装从断点续传。
  pause: () => Promise<boolean>
  // cancel 取消：停止并**删除**已下的半成品，下次从 0 开始。
  // 两者此前混成一个「取消」且实际是暂停语义，用户点了却留下半截文件，名不副实。
  cancel: () => Promise<boolean>
  refresh: () => Promise<void>
}

// useSidecar 在每个视图的 setup 里调用；挂载即接上（必要时自动开始轮询），
// 卸载只停轮询——在途的 POST 与作业态都在服务端，不会因为切页而丢。
//
// 注意「停轮询」的边界：consumers 归零（切走最后一个视图）时停掉定时器，
// 但**保留 sc.value 这份快照**。切回来时先渲染上次已知的进度，再立刻 refresh，
// 于是页面不会先闪一下「一键安装」再跳回进度条——那一下闪烁正是用户说的
// 「切换页面状态变回去了」。状态本身从没丢过（服务端持有），丢的是这一帧。
// pause 暂停：停止本次下载，保留 .part（下次断点续传）。
//
// 不碰 busy/optimistic：abort 会让服务端 ensure 返回 500，start() 的 POST 随之
// 结算并在它自己的 finally 里收尾。这里若无条件清 busy，会在 start() 还在途时
// 暗中拆掉它的重入闸，让第二次点击漏进去（子代理审查指出的状态归属混乱）。
async function pause(): Promise<boolean> {
  try {
    await api.sidecarAction('pause')
  } catch {
    // 暂停失败不弹错：用户要的是「停下来」，最坏也只是没停。
  }
  await refresh()
  return sc.value?.install?.running !== true
}

// cancel 取消：停止并删除 .part（下次从 0 开始）。
// 会让用户丢弃已下的内容，所以调用方**必须二次确认**。
async function cancel(): Promise<boolean> {
  try {
    await api.sidecarAction('cancel')
  } catch {
    // 同上：不弹错，真实状态以下面的 refresh 为准。
  }
  await refresh()
  return sc.value?.install?.running !== true
}

export function useSidecar(): UseSidecar {
  onMounted(() => {
    consumers++
    void refresh()
  })
  onUnmounted(() => {
    consumers = Math.max(0, consumers - 1)
    if (consumers === 0) stopPoll()
  })
  return {
    sc, job, running, busy, installing, stale, percent, phaseText, detailText, errorText, proxyText,
    start, pause, cancel, refresh,
  }
}
