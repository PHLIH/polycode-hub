<script setup>
import { ref, computed, onMounted, onUnmounted, reactive } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api.js'
// AI 回填的纯逻辑放 aiFill.ts（可单测；此处只管 DOM 与状态）
import { pickServices, applyAiService } from '../aiFill.ts'

const list = ref([])
const reminders = ref([])
const err = ref('')
const busy = ref('')
let timer = null

// 状态语义（与网关的「终端信号面板」令牌对齐）：绿=运行，琥珀=启动中/端口未就绪，灰=停止，红=异常退出。
// 停止是常态不是事件：常态只留 dot，show=false；只有异常态（退出码/已自动关闭）才出文字，用 warn/bad。
function statusOf(s) {
  if (s.running) return { cls: 'ok', text: '运行中', show: true }
  if (s.starting) return { cls: 'warn', text: '启动中', show: true }
  if (s.autoStopped) return { cls: 'warn', text: '已自动关闭', show: true }
  if (s.exitNote) return { cls: 'bad', text: s.exitNote, show: true }
  // 端口被外部进程占着：服务其实在跑（可能是手起的），但没 pid 管不了。
  // 不能说「运行中」（停止/重启会失败），更不能说「已停止」（那等于骗人说服务挂了）。
  if (s.portBusyByOther) {
    return { cls: 'warn', text: `端口 ${s.port} 被占用`, show: true }
  }
  return { cls: '', text: '已停止', show: false }
}
function portLabel(s) {
  const base = s.port || ''
  if (!base) return ''
  return s.portOverride ? `${base}→${s.portOverride}` : String(base)
}
function runningCount(p) {
  return p.services.filter(s => s.running).length
}

async function load(silent = true) {
  try {
    list.value = await api.projects()
    reminders.value = await api.projectReminders()
    err.value = ''
  } catch (e) {
    if (!silent) ElMessage.error(e.message)
    err.value = e.message
  }
}
onMounted(() => {
  load(false)
  timer = setInterval(load, 8000) // 运行时长/状态轮询
})
onUnmounted(() => clearInterval(timer))

// —— 启停 ——
async function serviceAction(p, s, action) {
  if (busy.value) return
  busy.value = p.id + '/' + s.name
  try {
    if (action === 'start' || action === 'restart') {
      await startWithConflictGuard(p, s, action)
    } else {
      await api.projectServiceAction(p.id, s.name, action)
    }
    await load()
  } finally {
    busy.value = ''
  }
}

// 启动/重启遇 409：端口被占。remappable（配置了 portEnv）才征询映射，用户同意才换端口。
async function startWithConflictGuard(p, s, action) {
  try {
    await api.projectServiceAction(p.id, s.name, action, action === 'start' ? {} : undefined)
    return
  } catch (e) {
    const c = e.data && e.data.conflict
    if (!c) throw e
    const owner = c.owner || '未知进程'
    if (!c.remappable) {
      await ElMessageBox.alert(
        `端口 ${c.port} 被 ${owner} 占用。该服务的端口是写死的，请先停掉占用进程或自行修改项目配置。`,
        '端口冲突', { confirmButtonText: '知道了' })
      return
    }
    try {
      await ElMessageBox.confirm(
        `端口 ${c.port} 被 ${owner} 占用。可以把端口映射到 ${c.suggested} 启动（仅本次生效）。`,
        '端口冲突', { confirmButtonText: `用 ${c.suggested} 启动`, cancelButtonText: '取消', type: 'warning' })
    } catch { return } // 用户不同意 → 不启动
    await api.projectServiceAction(p.id, s.name, action, { port: c.suggested })
  }
}

// 「端口被占用」标签点击 → 查占用者 → 二次确认是否停掉该端口。
// 网关自身端口在后端挡一道（杀自己等于自杀）；无权限/查不到进程后端抛错，前端透出。
async function askKillPort(s) {
  if (busy.value || !s.port) return
  busy.value = `kill/${s.port}`
  try {
    let owner = ''
    try {
      const info = await api.portOwner(s.port)
      if (info && !info.busy) { ElMessage.success(`端口 ${s.port} 已经空了`); await load(); return }
      owner = (info && info.owner) || '未知进程'
    } catch (e) {
      ElMessage.error(e.message)
      return
    }
    try {
      await ElMessageBox.confirm(
        `端口 ${s.port} 被 ${owner} 占用。停掉它上面的进程吗？停错可能影响别的服务。`,
        '是否停掉该端口',
        { confirmButtonText: '停掉', cancelButtonText: '取消', type: 'warning' })
    } catch { return } // 用户取消 → 什么都不做
    try {
      const r = await api.killPort(s.port)
      if (r && r.busy) {
        ElMessage.warning(`已停掉进程，但端口 ${s.port} 仍被占用（可能有新进程抢占）`)
      } else {
        ElMessage.success(`已停掉端口 ${s.port}（${(r && r.owner) || owner}）`)
      }
    } catch (e) {
      ElMessage.error(e.message)
      return
    }
    await load()
  } finally {
    busy.value = ''
  }
}

async function projectAction(p, action) {
  if (busy.value) return
  busy.value = p.id
  try {
    const r = await api.projectAction(p.id, action)
    const n = (r.conflicts || []).length
    if (n) {
      ElMessage.warning(`已启动无冲突的服务；${n} 个服务端口被占，点对应服务单独处理`)
    } else {
      ElMessage.success(action === 'start' ? '已全部启动' : '已全部停止')
    }
    await load()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    busy.value = ''
  }
}

async function removeProject(p) {
  try {
    await ElMessageBox.confirm(`删除「${p.name}」？运行中的服务会先停止。`, '删除项目', { type: 'warning', confirmButtonText: '删除' })
  } catch { return }
  try {
    await api.deleteProject(p.id)
    ElMessage.success('已删除')
    await load()
  } catch (e) { ElMessage.error(e.message) }
}

// —— 新增 / 编辑 ——
const editOpen = ref(false)
const editId = ref('')
// dir 是项目级目录（服务里留空 = 继承它）；readmes/readmePicked/readmeLoading
// 是本次编辑的临时状态，saveForm 前剥掉，不进 projects.json。
const form = reactive({ name: '', dir: '', services: [], readmes: [], readmePicked: [], readmeLoading: false })

// 技术栈预设：不同语言的启动方式差异很大（Python 要激活 venv、Node 要走
// node_modules/.bin 而不是硬编码 PATH、Go/Rust 要先 build）。
// 选一个预设 → 自动填好命令与端口，用户只需改路径。命令仍可手改，预设只是起点。
// 关键：Node 用 npx/本地 bin，不写死 /Users/xxx/node/bin —— 那种路径换台机器就废。
const STACKS = [
  { id: 'node', label: 'Node（npm）', cmd: 'npm run dev', port: 5173, portEnv: 'PORT' },
  { id: 'node-pnpm', label: 'Node（pnpm）', cmd: 'pnpm dev', port: 5173, portEnv: 'PORT' },
  { id: 'vite', label: 'Vite 前端', cmd: 'npx vite', port: 5173, portEnv: 'PORT' },
  { id: 'python-uvicorn', label: 'Python（uvicorn）', cmd: 'python3 -m uvicorn main:app --reload --port 8000', port: 8000, portEnv: 'PORT' },
  { id: 'python-venv', label: 'Python（.venv + uvicorn）', cmd: '.venv/bin/python -m uvicorn main:app --reload --port 8000', port: 8000, portEnv: 'PORT' },
  { id: 'python-flask', label: 'Python（Flask）', cmd: 'python3 app.py', port: 5000, portEnv: 'PORT' },
  { id: 'go', label: 'Go', cmd: 'go run .', port: 8080, portEnv: 'PORT' },
  { id: 'rust', label: 'Rust（cargo）', cmd: 'cargo run', port: 8080, portEnv: 'PORT' },
  { id: 'java-maven', label: 'Java（Maven）', cmd: 'mvn spring-boot:run', port: 8080, portEnv: 'SERVER_PORT' },
  { id: 'dotnet', label: '.NET', cmd: 'dotnet run', port: 5000, portEnv: 'ASPNETCORE_URLS' },
  { id: 'static', label: '静态站点', cmd: 'npx serve -l 3000 .', port: 3000, portEnv: 'PORT' },
  { id: 'custom', label: '自定义', cmd: '', port: 0, portEnv: '' }
]
function stackLabel(id) {
  const s = STACKS.find(x => x.id === id)
  return s ? s.label : '自定义'
}
// 换预设：以新预设为准填命令/端口/端口变量（无条件覆盖，明确动作，不做魔法合并）。
function applyStack(s, id) {
  const t = STACKS.find(x => x.id === id)
  if (!t || id === 'custom') return
  s.cmd = t.cmd
  s.port = t.port
  s.portEnv = t.portEnv
}

// readmes/readmePicked 是"这次让 AI 读什么"的临时状态：不落库（saveForm 会清掉）。
function emptyService() {
  return { name: '', dir: '', cmd: '', port: 0, portEnv: '', maxRuntimeHours: 0, stack: 'node' }
}
function openCreate() {
  editId.value = ''
  form.name = ''
  form.dir = ''
  form.readmes = []
  form.readmePicked = []
  form.readmeLoading = false
  aiFallback.value = false
  form.services = [emptyService()]
  editOpen.value = true
}
function openEdit(p) {
  editId.value = p.id
  form.name = p.name
  // 项目目录：优先用第一个服务的 dir，让"整个项目在同一个文件夹"的常见情况直接显示出来
  form.dir = (p.services.find((s) => s.dir)?.dir) || ''
  form.readmes = []
  form.readmePicked = []
  form.readmeLoading = false
  aiFallback.value = false
  form.services = p.services.map(s => ({ ...emptyService(), ...s, stack: s.stack || guessStack(s) }))
  editOpen.value = true
}
// 老项目没有 stack 字段：按命令反推一个，让下拉不至于空着显示错项。
function guessStack(s) {
  const c = (s.cmd || '').toLowerCase()
  if (c.includes('uvicorn')) return c.includes('.venv') ? 'python-venv' : 'python-uvicorn'
  if (c.includes('cargo')) return 'rust'
  if (c.includes('go run')) return 'go'
  if (c.includes('dotnet')) return 'dotnet'
  if (c.includes('mvn')) return 'java-maven'
  if (c.includes('pnpm')) return 'node-pnpm'
  if (c.includes('vite')) return 'vite'
  if (c.includes('npm')) return 'node'
  return 'custom'
}
function addService() { form.services.push(emptyService()) }
function rmService(i) { form.services.splice(i, 1) }

async function saveForm() {
  if (!form.name.trim()) { ElMessage.warning('项目名不能为空'); return }
  for (const s of form.services) {
    // 只拦真正跑不起来的：缺服务名、缺启动命令。目录留空有默认（进程 cwd）。
    if (!s.name.trim()) { ElMessage.warning('每个服务都要有个名字'); return }
    if (!s.cmd.trim()) { ElMessage.warning(`服务「${s.name}」还没填启动命令`); return }
  }
  // 服务 dir 留空 = 继承项目目录（省一份重复配置）；剥掉本次编辑的临时字段
  const projectDir = form.dir.trim()
  const clean = form.services.map(({ stack, ...svc }) => {
    if (!svc.dir.trim()) svc.dir = projectDir
    return svc
  })
  try {
    if (editId.value) {
      await api.updateProject(editId.value, { name: form.name, services: clean })
      ElMessage.success('已保存')
    } else {
      await api.createProject({ name: form.name, services: clean })
      ElMessage.success('已添加，点启动运行')
    }
    editOpen.value = false
    await load()
  } catch (e) { ElMessage.error(e.message) }
}

// —— AI 录入（提示词复制 + JSON 导入）——
// 提示词按服务目录动态拼接：用户在工作目录旁点 AI，目录自动拼进去，AI 只管看项目填 JSON。
function promptFor(dir) {
  const d = (dir || '').trim()
  return `你是 polycode-hub 项目板块的录入助手。你的任务：看下面这个本机项目目录里有什么、怎么启动，然后输出可直接导入的 JSON。

项目目录：${d || '（用户还没填，先追问目录，不许编）'}

拿到目录后，自己去看：package.json / requirements.txt / go.mod / Cargo.toml / docker-compose.yml 等，推断有几个服务、启动命令和端口。

只输出 JSON，不要解释。单个对象或数组都行，字段如下：
- name：项目名（必填，用目录名即可）
- services：数组（必填，至少一个），每项：
  name（服务名，必填）、dir（工作目录，必填，上面给的目录或其子目录）、cmd（启动命令，必填，从项目实际配置里找）、
  port（端口数字，0=不检测）、portEnv（端口变量，选填，如 PORT）、maxRuntimeHours（最长运行小时，0=不限）

示例（照着这个形状吐）：
{
  "name": "我的博客",
  "services": [
    {"name": "backend", "dir": "${d || '/Users/xxx/Projects/blog'}", "cmd": "npm run dev", "port": 3000, "portEnv": "PORT", "maxRuntimeHours": 0}
  ]
}

用户把这段 JSON 粘贴到 polycode-hub「项目 → 导入」弹窗里，点导入即完成。
`
}
const aiCopied = ref(false)
let aiTimer = null
async function copyPrompt(text) {
  const body = text || promptFor('')
  let ok = false
  try {
    await navigator.clipboard.writeText(body)
    ok = true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = body
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      ok = document.execCommand('copy')
      ta.remove()
    } catch {
      ok = false
    }
  }
  if (!ok) {
    ElMessage.error('复制失败：浏览器禁了剪贴板，请手动复制（导入→AI 录入里有全文）')
    return
  }
  aiCopied.value = true
  clearTimeout(aiTimer)
  aiTimer = setTimeout(() => { aiCopied.value = false }, 1600)
  ElMessage.success('提示词已复制，丢给 AI 填写')
}
onUnmounted(() => clearTimeout(aiTimer))

// —— AI 直填（模型可选 + 目录 + README 多选 + 失败回复制）——
const aiDir = ref('')
const aiModels = ref([])
const aiModel = ref('')
const aiReadmes = ref([]) // [{path,size}]
const aiPicked = ref([]) // 勾选的相对路径
const aiFilling = ref(false)
const aiReadmeLoading = ref(false)
let modelLoaded = false
async function loadAiModels() {
  try {
    const [ms, dflt] = await Promise.all([api.gatewayModels(), api.projectDefaultModel()])
    aiModels.value = ms.map((m) => m.id).filter(Boolean)
    // 默认取网关 default_model（config）；没配或不在列表里才回落首个
    const want = dflt && aiModels.value.includes(dflt) ? dflt : aiModels.value[0]
    if (!aiModel.value || !aiModels.value.includes(aiModel.value)) aiModel.value = want || ''
    modelLoaded = true
  } catch { aiModels.value = [] }
}
async function loadAiReadmes() {
  aiReadmes.value = []
  aiPicked.value = []
  if (!aiDir.value.trim()) return
  aiReadmeLoading.value = true
  try {
    const r = await api.projectReadmes(aiDir.value.trim())
    aiReadmes.value = r.readmes || []
    // 默认全选（根 README 排前，用户可取消）
    aiPicked.value = aiReadmes.value.map((x) => x.path)
  } catch (e) { ElMessage.error(`README 扫描失败：${e.message}`) }
  finally { aiReadmeLoading.value = false }
}
// 复用目录浏览弹窗选 AI 目录（只扫它自己的列表）
function pickAiDir() {
  openBrowse({ get dir() { return aiDir.value }, set dir(v) { aiDir.value = v } }, loadAiReadmes)
}
async function aiFill() {
  if (!aiDir.value.trim()) { ElMessage.warning('先选项目目录'); return }
  if (!aiModel.value) { ElMessage.warning('先选 AI 模型'); return }
  aiFilling.value = true
  try {
    const r = await api.aiFillProject({ dir: aiDir.value.trim(), model: aiModel.value, readmes: aiPicked.value })
    importTab.value = 'json'
    importText.value = typeof r.json === 'string' ? r.json : JSON.stringify(r.json, null, 2)
    formatImport()
    ElMessage.success(r.readmeFound ? `AI 已按 ${r.readmeFound} 个 README 填好，检查后点导入` : 'AI 已填好（未读到 README，按结构推断），检查后点导入')
  } catch (e) {
    // 502/失败 → 降级：切复制提示词（带目录拼好）
    importTab.value = 'ai'
    ElMessage.warning(`AI 直填失败，已切到复制模式：${e.message}`)
  } finally {
    aiFilling.value = false
  }
}

// —— JSON 导入弹窗（JSON 粘贴 + AI 提示词双页签）——
const importOpen = ref(false)
const importTab = ref('json') // json | ai
const importText = ref('')
const importBusy = ref(false)
function openImport() {
  importText.value = ''
  importFmtErr.value = ''
  importTab.value = 'json'
  importOpen.value = true
  loadAiModels() // 预加载模型下拉
}
// 格式化：把框里压成一行的 JSON 展开成缩进 2 格；非法 JSON 就地报错不动原文。
const importFmtErr = ref('')
function formatImport() {
  importFmtErr.value = ''
  try {
    importText.value = JSON.stringify(JSON.parse(importText.value), null, 2)
  } catch {
    importFmtErr.value = 'JSON 格式不对，先检查括号和逗号'
  }
}
async function doImport() {
  let items
  try {
    const v = JSON.parse(importText.value)
    items = Array.isArray(v) ? v : [v]
  } catch {
    ElMessage.error('JSON 解析失败，请检查格式')
    return
  }
  if (!items.length) { ElMessage.warning('没有可导入的项目'); return }
  importBusy.value = true
  let ok = 0
  const fails = []
  for (const it of items) {
    try {
      await api.createProject(it)
      ok++
    } catch (e) { fails.push(e.message) }
  }
  importBusy.value = false
  importOpen.value = false
  await load()
  if (fails.length) ElMessage.warning(`导入 ${ok} 个，失败 ${fails.length} 个：${fails[0]}`)
  else ElMessage.success(`已导入 ${ok} 个项目`)
}
const logOpen = ref(false)
const logTitle = ref('')
const logText = ref('')
const logCtx = ref(null)

async function openLogs(p, s) {
  logCtx.value = { p, s }
  logTitle.value = `${p.name} / ${s.name}`
  logOpen.value = true
  await refreshLogs()
}
async function refreshLogs() {
  if (!logCtx.value) return
  try {
    const r = await api.projectLogs(logCtx.value.p.id, logCtx.value.s.name)
    logText.value = r.log || '（暂无日志）'
  } catch (e) { logText.value = '读取失败：' + e.message }
}
async function clearLogs() {
  if (!logCtx.value) return
  try {
    await api.clearProjectLogs(logCtx.value.p.id, logCtx.value.s.name)
    await refreshLogs()
  } catch (e) { ElMessage.error(e.message) }
}

// —— 项目级目录 + 说明文件 + AI 回填 ——
// 目录是项目级的（一个项目 = 一个文件夹）；服务里的 dir 是选填覆盖，
// 只有服务在子目录里（如 api/、web/）才填，留空继承项目目录。
// 扫描结果挂在 form 上，不写进 projects.json：它是"这次让 AI 读什么"的候选清单。
const rmFilling = ref(false)
const aiFallback = ref(false) // 本项目目录 AI 失败过 → 按钮改显示「复制提示词」

async function ensureModels() {
  if (modelLoaded) return // 取过一次（含"列表为空"这种结果）就不再重试
  await loadAiModels()
}
// 选了目录就扫（3 层内，后端已跳过依赖/隐藏目录）；扫到才显示下拉、扫描中给落点。
const showReadmeRow = computed(() => !!form.readmeLoading || form.readmes.length > 0)
const aiUsable = computed(() => !!form.dir.trim()) // 有目录，AI 才有东西可读

async function scanReadmes() {
  form.readmes = []
  form.readmePicked = []
  aiFallback.value = false
  if (!form.dir.trim()) return
  form.readmeLoading = true
  ensureModels() // 目录一确定 AI 行就要出现，顺手把模型列表取好
  try {
    const r = await api.projectReadmes(form.dir.trim())
    form.readmes = r.readmes || []
    form.readmePicked = form.readmes.map((x) => x.path) // 根 README 排前，可取消
  } catch (e) { ElMessage.error(`说明文件扫描失败：${e.message}`) }
  finally { form.readmeLoading = false }
}

// aiFillProject：读项目目录的说明文件，填出这个项目的服务列表。
// 不动项目名；服务列表整体替换为 AI 给的结果（填完等用户点保存，不落库）。
async function aiFillProjectForm() {
  const dir = form.dir.trim()
  if (!dir) { ElMessage.warning('先填或浏览项目目录'); return }
  await ensureModels()
  if (!aiModel.value) { ElMessage.warning('网关没返回可用模型'); return }
  if (!form.readmes.length) await scanReadmes() // 编辑时目录是带进来的、还没扫过
  rmFilling.value = true
  try {
    const r = await api.aiFillProject({ dir, model: aiModel.value, readmes: form.readmePicked || [] })
    const svcs = pickServices(r.json)
    if (!svcs.length) throw new Error('AI 没给出服务定义')
    // 一个目录里多个服务（api+web）→ 全填，各自带自己的子目录
    form.services = svcs.map((svc) => {
      const s = emptyService()
      // AI 给的 dir 若等于项目目录，留空表示继承（省一份重复配置）
      applyAiService(s, svc, dir)
      if (s.dir === dir) s.dir = ''
      s.stack = guessStack(s)
      return s
    })
    aiFallback.value = false
    ElMessage.success(`填了 ${svcs.length} 个服务，确认无误后点保存`)
  } catch (e) {
    aiFallback.value = true
    ElMessage.warning(`AI 填写失败，点「复制提示词」自己来：${e.message}`)
  } finally { rmFilling.value = false }
}

// 按钮：常态「AI」，失败过就常驻「复制提示词」（用户点了才算降级生效，不自动复制）
function onAiButton() {
  const dir = form.dir.trim()
  if (!dir) { ElMessage.warning('先填或浏览项目目录'); return }
  if (aiFallback.value) { copyPrompt(promptFor(dir)); return }
  aiFillProjectForm()
}
const aiButtonText = computed(() => {
  if (rmFilling.value) return '填写中…'
  return aiFallback.value ? '复制提示词' : 'AI'
})
function fmtSize(n) {
  const b = Number(n) || 0
  if (b < 1024) return b + 'B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + 'K'
  return (b / 1024 / 1024).toFixed(1) + 'M'
}


// —— 目录浏览（工作目录输入旁「浏览」按钮，跨平台：后端列目录）——
const browseOpen = ref(false)
const browseTarget = ref(null) // 指向 form.services[i]，选好直接写回 s.dir
const browseAfter = ref(null) // 选好后的回调（服务行=接着扫 README）
const browsePath = ref('')
const browseParent = ref('')
const browseDirs = ref([])
const browseErr = ref('')
async function loadBrowse(path) {
  browseErr.value = ''
  try {
    const r = await api.browseProjectDir(path || '')
    browsePath.value = r.path || ''
    browseParent.value = r.parent || ''
    browseDirs.value = r.dirs || []
  } catch (e) { browseErr.value = e.message }
}
// after 是选完目录的回调，签名 (target, pickedPath)；失焦/取消不触发。
function openBrowse(s, after) {
  browseTarget.value = s
  browseAfter.value = after || null
  browseOpen.value = true
  // 从已填目录开始，没有就从根开始
  const cur = typeof s?.dir === 'string' ? s.dir : ''
  loadBrowse(cur && cur !== '-' ? cur : '')
}
function browseGo(dir) {
  const base = browsePath.value
  // win32 盘符（C:\）直接用，posix 用 / 拼接
  const next = !base ? dir : (base.endsWith('/') || base.endsWith('\\') ? base + dir : base + '/' + dir)
  loadBrowse(next)
}
function browsePick(dir) {
  browseGo(dir)
}
function browseConfirm() {
  const t = browseTarget.value
  const picked = browsePath.value
  if (t && picked) t.dir = picked
  browseOpen.value = false
  const after = browseAfter.value
  browseAfter.value = null
  if (after) after(t, picked)
}

// 在系统中打开目录（Finder/文件管理器）；没填目录先提示去填。
async function openDir(s) {
  if (!s.dir || s.dir === '-') {
    ElMessage.warning('该服务没填目录，先编辑填上绝对路径')
    return
  }
  try {
    await api.openProjectDir(s.dir)
  } catch (e) { ElMessage.error(`打开失败：${e.message}`) }
}
</script>

<template>
  <div class="page">
    <header class="head">
      <div>
        <h2>项目</h2>
        <p class="sub">本机开发项目的一键启停。电脑不关机也不怕忘——超时自动关、久跑有提醒。</p>
      </div>
      <div class="head-actions">
        <button class="btn" @click="openImport">导入</button>
        <button class="btn primary" @click="openCreate">＋ 添加项目</button>
      </div>
    </header>

    <div v-if="reminders.length" class="remind">
      <div v-for="p in reminders" :key="p.id">「{{ p.name }}」已连续运行超过 24 小时，不用的话记得关。</div>
    </div>

    <div v-if="err && !list.length" class="empty">加载失败：{{ err }}</div>
    <div v-else-if="!list.length" class="empty">
      还没有项目。点右上角「添加项目」，把目录和启动命令填进来，以后就能在这里一键启动。
    </div>

    <template v-else>
      <article v-for="p in list" :key="p.id" class="proj">
      <header class="proj-head">
        <button class="proj-name" :title="`编辑 ${p.name}`" @click="openEdit(p)">{{ p.name }}</button>
        <span class="proj-sum num" :class="runningCount(p) ? 'has-run' : ''">
          {{ runningCount(p) }}/{{ p.services.length }} 运行中
        </span>
        <span class="grow"></span>
        <button class="btn" :disabled="!!busy || runningCount(p) === p.services.length"
          @click="projectAction(p, 'start')">全部启动</button>
        <button class="btn" :disabled="!!busy || !runningCount(p)"
          @click="projectAction(p, 'stop')">全部停止</button>
        <button class="btn ghost danger" :title="`删除 ${p.name}`"
          @click="removeProject(p)">删除</button>
      </header>

      <div v-for="s in p.services" :key="s.name" class="svc">
        <div class="svc-main">
          <span class="dot" :class="statusOf(s).cls"></span>
          <span class="svc-name">{{ s.name }}</span>
          <span class="svc-cmd num" :title="`${s.dir} · ${s.cmd}`">{{ s.cmd }}</span>
        </div>
        <div class="svc-side">
          <span v-if="portLabel(s)" class="port num" :title="s.portOverride ? '已映射：原端口 → 实际端口' : '端口'">{{ portLabel(s) }}</span>
          <span v-if="statusOf(s).show" class="status" :class="[statusOf(s).cls, { clickable: s.portBusyByOther }]"
            :title="s.portBusyByOther ? `端口 ${s.port} 上有服务在跑，但不是由项目管理器启动的（没有进程记录）。点一下查占用者，可停掉该端口再点「启动」接管。` : ''"
            :role="s.portBusyByOther ? 'button' : undefined" :tabindex="s.portBusyByOther ? 0 : undefined"
            @click="s.portBusyByOther && askKillPort(s)"
            @keydown.enter="s.portBusyByOther && askKillPort(s)">
            {{ statusOf(s).text }}</span>
          <span v-if="s.uptime" class="uptime num">{{ s.uptime }}</span>
          <span class="svc-actions">
            <button v-if="s.running" class="btn sm ghost" :disabled="!!busy"
              @click="serviceAction(p, s, 'restart')">重启</button>
            <button v-if="!s.running && !s.starting" class="btn sm" :disabled="busy === p.id + '/' + s.name"
              @click="serviceAction(p, s, 'start')">启动</button>
            <button v-if="s.running || s.starting" class="btn sm" :disabled="busy === p.id + '/' + s.name"
              @click="serviceAction(p, s, 'stop')">停止</button>
            <button class="log-link" :title="s.dir ? `在系统中打开 ${s.dir}` : '先编辑填上目录才能打开'" @click="openDir(s)">打开</button>
            <button class="log-link" :title="`查看 ${s.name} 的日志`" @click="openLogs(p, s)">日志</button>
          </span>
        </div>
      </div>
    </article>
    </template>

    <!-- 新增/编辑 -->
    <div v-if="editOpen" class="mask" @click.self="editOpen = false">
      <div class="dialog">
        <h3>{{ editId ? '编辑项目' : '添加项目' }}</h3>
        <p class="dlg-sub">一个项目 = 一个文件夹。填好目录点 AI，让它读说明文件把服务填出来。</p>
        <label class="fld">项目名
          <input v-model="form.name" placeholder="如：我的博客" />
        </label>
        <label class="fld">项目目录
          <div class="dir-line">
            <input v-model="form.dir" placeholder="这个项目的文件夹，如 /Users/me/blog" class="num"
              @change="scanReadmes" />
            <button class="btn sm ghost" title="浏览本机目录，选好自动扫描说明文件"
              @click="openBrowse(form, scanReadmes)">浏览</button>
            <button class="btn sm ai" :class="{ failed: aiFallback }"
              :title="aiFallback ? 'AI 失败了，点这里复制提示词自己填' : '按选中的说明文件让 AI 填这个项目'"
              :disabled="rmFilling || !aiUsable" @click="onAiButton">{{ aiButtonText }}</button>
          </div>
        </label>
        <!-- 说明文件：扫到才出现（缩进 + 左细线，表明它是项目目录扫出来的） -->
        <div class="rm-row fld" v-if="showReadmeRow">
          <span class="rm-label">说明文件</span>
          <el-select v-model="form.readmePicked" multiple collapse-tags collapse-tags-tooltip
            :disabled="!form.readmes.length" class="rm-sel"
            :placeholder="form.readmeLoading ? '扫描中…' : '选择文件（默认全选）'">
            <el-option v-for="r in form.readmes" :key="r.path" :value="r.path" :label="r.path">
              <span class="rm-opt">
                <span class="rm-opt-path num">{{ r.path }}</span>
                <span class="dim num">{{ fmtSize(r.size) }}</span>
              </span>
            </el-option>
          </el-select>
        </div>
        <!-- AI 设置：有目录才出现，紧贴它的作用对象（项目目录 + 说明文件） -->
        <div class="ai-bar" v-if="aiUsable">
          <span class="ai-bar-key">AI 模型</span>
          <el-select v-model="aiModel" class="ai-model-sel" @focus="ensureModels"
            :placeholder="aiModels.length ? '选一个模型' : '模型列表加载失败'">
            <el-option v-for="m in aiModels" :key="m" :value="m" :label="m" />
          </el-select>
          <span class="ai-bar-hint">读上面勾选的说明文件来填，填完你确认再保存</span>
        </div>
        <div class="svc-editor">
          <div class="svc-editor-head">
            <span class="sec-title">服务</span>
            <span class="hint">端口冲突时，配了「端口映射变量」的服务才能一键换端口</span>
          </div>
          <div v-for="(s, i) in form.services" :key="i" class="svc-card">
            <div class="svc-card-head">
              <span class="svc-idx num">{{ i + 1 }}</span>
              <span class="svc-title">{{ s.name || '未命名服务' }}</span>
              <span class="grow"></span>
              <button class="btn sm ghost danger" @click="rmService(i)">移除</button>
            </div>
            <div class="fgrid">
              <label>名称<input v-model="s.name" placeholder="backend" /></label>
              <label>技术栈
                <el-select v-model="s.stack" @change="applyStack(s, s.stack)" class="cell-sel">
                  <el-option v-for="t in STACKS" :key="t.id" :value="t.id" :label="t.label" />
                </el-select>
              </label>
              <label>端口<input v-model.number="s.port" type="number" min="0" max="65535" placeholder="0 = 不检测" class="num" /></label>
              <label class="span3">启动命令
                <input v-model="s.cmd" placeholder="npm run dev" class="num" />
              </label>
              <label class="span3">工作目录（选填，留空用项目目录）
                <div class="dir-line">
                  <input v-model="s.dir" placeholder="服务在子目录里才填，如 ./api" class="num" />
                  <button class="btn sm ghost" title="浏览本机目录"
                    @click="openBrowse(s)">浏览</button>
                </div>
              </label>
              <label>端口变量<input v-model="s.portEnv" placeholder="PORT" /></label>
              <label>最长运行（小时）<input v-model.number="s.maxRuntimeHours" type="number" min="0" placeholder="0 = 不限" class="num" /></label>
            </div>
          </div>
        </div>
        <button class="btn ghost" @click="addService">＋ 加一个服务</button>
        <div class="dialog-foot">
          <button class="btn ghost" @click="editOpen = false">取消</button>
          <button class="btn primary" @click="saveForm">保存</button>
        </div>
      </div>
    </div>

    <!-- 日志 -->
    <div v-if="logOpen" class="mask" @click.self="logOpen = false">
      <div class="dialog log-dialog">
        <h3>{{ logTitle }} 的日志</h3>
        <pre class="log num">{{ logText }}</pre>
        <div class="dialog-foot">
          <button class="btn ghost" @click="clearLogs">清空</button>
          <button class="btn ghost" @click="refreshLogs">刷新</button>
          <button class="btn primary" @click="logOpen = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- 导入：JSON 粘贴 + AI 提示词双页签 -->
    <div v-if="importOpen" class="mask" @click.self="importOpen = false">
      <div class="dialog">
        <h3>导入项目</h3>
        <div class="imp-tabs">
          <button class="imp-tab" :class="{ on: importTab === 'json' }" @click="importTab = 'json'">JSON 导入</button>
          <button class="imp-tab" :class="{ on: importTab === 'ai' }" @click="importTab = 'ai'">AI 录入</button>
        </div>
        <template v-if="importTab === 'json'">
          <textarea v-model="importText" class="import-box num"
            placeholder='粘贴 AI 填好的项目 JSON（单个对象或数组），例如：&#10;{"name": "我的博客", "services": [{"name": "backend", "dir": "/Users/xxx/Projects/blog", "cmd": "npm run dev", "port": 3000, "portEnv": "PORT"}]}'
            rows="10" spellcheck="false"></textarea>
          <div class="import-bar">
            <button class="btn sm ghost" :disabled="!importText.trim()" @click="formatImport">格式化</button>
            <span v-if="importFmtErr" class="import-err">{{ importFmtErr }}</span>
          </div>
          <div class="dialog-foot">
            <button class="btn ghost" @click="importOpen = false">取消</button>
            <button class="btn primary" :disabled="importBusy || !importText.trim()" @click="doImport">
              {{ importBusy ? '导入中…' : '导入' }}
            </button>
          </div>
        </template>
        <template v-else>
          <div class="ai-fill">
            <label class="fld">AI 模型
              <el-select v-model="aiModel" class="cell-sel" @focus="ensureModels"
                :placeholder="aiModels.length ? '选一个模型' : '模型列表加载失败'">
                <el-option v-for="m in aiModels" :key="m" :value="m" :label="m" />
              </el-select>
            </label>
            <label class="fld">项目目录
              <div class="dir-line">
                <input v-model="aiDir" placeholder="/Users/xxx/Projects/demo" class="num" @change="loadAiReadmes" />
                <button class="btn sm ghost" @click="pickAiDir">浏览</button>
              </div>
            </label>
            <div class="fld">README（3 层内，可多选，同名按子路径区分）
              <div v-if="aiReadmeLoading" class="dim">扫描中…</div>
              <div v-else-if="!aiDir.trim()" class="dim">先填目录再扫描。</div>
              <div v-else-if="!aiReadmes.length" class="dim">没找到 README，AI 按目录结构推断。</div>
              <label v-for="r in aiReadmes" :key="r.path" class="ai-check">
                <input type="checkbox" :value="r.path" v-model="aiPicked" />
                <span class="num">{{ r.path }}</span>
                <span class="dim num">{{ r.size }}B</span>
              </label>
            </div>
            <div class="dialog-foot">
              <button class="btn ghost" @click="importOpen = false">关闭</button>
              <button class="copy-btn" :class="{ done: aiCopied }" @click="copyPrompt(promptFor(aiDir))">
                {{ aiCopied ? '已复制' : '复制提示词' }}
              </button>
              <button class="btn primary" :disabled="aiFilling || !aiDir.trim() || !aiModel" @click="aiFill">
                {{ aiFilling ? '填写中…' : '让 AI 填写' }}
              </button>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 目录浏览：后端列目录，逐级点选，确定写回工作目录 -->
    <div v-if="browseOpen" class="mask" @click.self="browseOpen = false">
      <div class="dialog">
        <h3>选择目录</h3>
        <div class="browse-cur num">{{ browsePath || '…' }}</div>
        <p v-if="browseErr" class="import-err">{{ browseErr }}</p>
        <div class="browse-list">
          <button v-if="browseParent" class="browse-row up" @click="loadBrowse(browseParent)">↑ 上级</button>
          <button v-for="d in browseDirs" :key="d" class="browse-row" @dblclick="browsePick(d)" @click="browsePick(d)" :title="'进入 ' + d">{{ d }}</button>
          <p v-if="!browseDirs.length && !browseErr" class="dim">空目录，选它就是这里了。</p>
        </div>
        <div class="dialog-foot">
          <button class="btn ghost" @click="browseOpen = false">取消</button>
          <button class="btn primary" :disabled="!browsePath" @click="browseConfirm">就选这里</button>
        </div>
      </div>
    </div>


  </div>
</template>

<style scoped>
.page { max-width: 1100px; margin: 0 auto; }
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
h2 { margin: 0; font-size: 18px; }
.sub { margin: 6px 0 0; color: var(--dim); font-size: 13px; }

.remind {
  border: 1px solid var(--warn); border-radius: 8px; background: color-mix(in srgb, var(--warn) 12%, var(--panel));
  color: var(--warn); padding: 10px 14px; margin-bottom: 14px; font-size: 13px;
  display: flex; flex-direction: column; gap: 4px;
}

.empty { color: var(--dim); border: 1px dashed var(--line); border-radius: 10px; padding: 40px 24px; text-align: center; }

/* 项目 = 全宽面板：项目个位数，纵向堆叠比卡片网格给服务行留得住信息。
   实现要点（别改回去）：卡片本身**不能** overflow:hidden，否则末行背景
   会被裁掉圆角。圆角由「首行/末行各自裁上方/下方圆角」实现——
   行的背景色是纯色铺满，只需首末两行负责圆角即可。 */
.proj {
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  margin-bottom: 16px;
}
.proj-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 9px 9px 0 0; }
/* 项目名即编辑入口：常态与标题无异，hover 才显可点（accent + 下划线） */
.proj-name {
  border: 0; background: transparent; padding: 0; margin: 0;
  color: var(--text); font-size: 15px; font-weight: 700; cursor: pointer;
}
.proj-name:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
.proj-name:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.proj-sum { color: var(--dim); font-size: 12px; padding: 1px 8px; border: 1px solid var(--line); border-radius: 999px; }
.proj-sum.has-run { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
.grow { flex: 1; }

.svc {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 9px 16px; border-top: 1px solid var(--line); font-size: 13px;
  background: var(--panel);
}
.svc:nth-child(odd) { background: color-mix(in srgb, var(--panel-2) 45%, var(--panel)); }
/* 卡片不用 overflow:hidden，由末行自己收圆角，
   否则它的整行背景会把卡片底部两个圆角盖成直角。 */
.svc:last-child { border-radius: 0 0 9px 9px; }
.svc-main { display: flex; align-items: center; gap: 8px; flex: 1 1 320px; min-width: 0; }
.svc-name { font-weight: 600; }
/* 命令是服务的真实身份：mono 弱化展示，悬停给全（含目录） */
.svc-cmd {
  flex: 1; min-width: 0; color: var(--dim); font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.svc-side { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.svc-side .btn, .svc-side .status, .svc-side .uptime, .svc-side .log-link { white-space: nowrap; }
.port { font-family: var(--mono); font-size: 12px; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line)); border-radius: 4px; padding: 1px 6px; }
/* 只有异常态才有文字并着色；「已停止」这种常态不渲染（UI-REVIEW §1-3） */
.status.warn { color: var(--warn); }
.status.bad { color: var(--bad); }
/* 端口被占用标签可点：hover 下划线 + 手型，提示能点出「是否停掉该端口」 */
.status.clickable { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
.status.clickable:hover { filter: brightness(1.15); }
.status.clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.uptime { color: var(--dim); font-size: 12px; }
.svc-actions { display: flex; align-items: center; gap: 6px; }
/* 日志是低频查看动作，不做成按钮：常态安静，hover/聚焦才现形 */
.log-link {
  border: 0; background: transparent; color: var(--dim); cursor: pointer;
  font-size: 12px; padding: 2px 4px; border-radius: 4px;
}
.log-link:hover { color: var(--accent); }
.log-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.btn {
  border: 1px solid var(--line); background: var(--panel-2); color: var(--text);
  border-radius: 6px; padding: 5px 12px; font-size: 13px; cursor: pointer;
}
.btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.btn:disabled { opacity: 0.4; cursor: default; }
.btn.sm { padding: 3px 8px; font-size: 12px; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #0b1017; font-weight: 600; }
.btn.primary:hover:not(:disabled) { color: #0b1017; filter: brightness(1.1); }
.btn.ghost { background: transparent; }
.btn.danger:hover { border-color: var(--bad); color: var(--bad); }

.mask { position: fixed; inset: 0; background: rgba(5, 8, 12, 0.6); display: grid; place-items: center; z-index: 20; }
.dialog {
  width: min(760px, 94vw); max-height: 88vh; overflow: auto;
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px;
}
.dialog h3 { margin: 0; font-size: 16px; }
.dlg-sub { margin: 4px 0 14px; color: var(--dim); font-size: 12px; }
.fld { display: block; color: var(--dim); font-size: 12px; margin-bottom: 12px; }
.fld input { display: block; width: 100%; margin-top: 4px; box-sizing: border-box; }
.dialog input, .dialog select {
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px;
  color: var(--text); padding: 6px 10px; font-size: 13px; box-sizing: border-box; width: 100%;
}
.dialog input:focus, .dialog select:focus { outline: none; border-color: var(--accent); }
/* 选填字段与必填字段在视觉上分层：标签用弱色 + 括号说明，不靠红星堆砌 */
.fgrid label.hint { color: color-mix(in srgb, var(--dim) 80%, var(--panel)); }
/* 分区标题：小字号 + 字距，hint 弱化跟在同一行（不加 ALL-CAPS、不加眉标） */
.svc-editor { margin-bottom: 10px; display: flex; flex-direction: column; gap: 10px; }
.svc-editor-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 2px; }
.sec-title { color: var(--text); font-size: 13px; letter-spacing: .04em; }
.svc-editor-head .hint { color: var(--dim); font-size: 11px; }
/* 服务卡：左侧 2px 强调条给卡片一个"活"的抓手，序号用 mono 数字而非粗徽章 */
.svc-card {
  border: 1px solid var(--line); border-left: 2px solid color-mix(in srgb, var(--accent) 45%, var(--line));
  border-radius: 8px; padding: 10px 12px; background: var(--panel-2);
}
.svc-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.svc-idx {
  flex: none; width: 18px; height: 18px; display: grid; place-items: center;
  font-size: 11px; color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line)); border-radius: 5px;
}
.svc-title { color: var(--text); font-size: 13px; font-weight: 600; }
.fgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 10px; }
.fgrid label { display: block; color: var(--dim); font-size: 12px; }
.fgrid label input { margin-top: 4px; }
.fgrid .span3 { grid-column: span 3; }
@media (max-width: 640px) { .fgrid { grid-template-columns: 1fr; } .fgrid .span3 { grid-column: span 1; } }
.dialog-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }

.log-dialog { width: min(860px, 94vw); }
/* AI 录入面板：提示词展示 + 复制（与概览接入条同语的复制按钮） */
.head-actions { display: flex; gap: 8px; }
/* 导入双页签：JSON 导入 | AI 录入（按钮切换，不做下拉） */
.imp-tabs { display: flex; gap: 6px; margin-bottom: 10px; }
.imp-tab {
  border: 1px solid var(--line); background: none; color: var(--dim);
  border-radius: 6px; padding: 5px 14px; font-size: 12px; cursor: pointer;
}
.imp-tab.on { color: var(--accent); border-color: var(--accent); }
/* 目录浏览：当前路径 + 目录列表（单击进入，确定写回） */
.browse-cur {
  font-size: 12px; background: var(--bg); border: 1px solid var(--line);
  border-radius: 6px; padding: 6px 10px; margin-bottom: 8px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.browse-list { max-height: 300px; overflow-y: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); margin-bottom: 4px; }
.browse-row {
  display: block; width: 100%; text-align: left; padding: 7px 12px; font-size: 12px;
  font-family: var(--mono); background: none; border: 0; border-bottom: 1px solid color-mix(in srgb, var(--line) 45%, transparent);
  color: var(--text); cursor: pointer;
}
.browse-row:last-child { border-bottom: 0; }
.browse-row:hover { background: color-mix(in srgb, var(--panel) 60%, var(--bg)); }
.browse-row.up { color: var(--accent); }
/* AI 直填页：模型下拉 + 目录 + README 多选 */
.ai-fill { display: flex; flex-direction: column; gap: 4px; }
.ai-fill .fld { margin-bottom: 8px; }
/* .dir-line 的 flex 规则见下方共用定义（曾在此重复一份） */
.ai-check { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 4px 0; cursor: pointer; }
.ai-check input { accent-color: var(--accent); }
.ai-note { font-size: 12px; margin: 0 0 10px; }
.ai-prompt {
  font-family: var(--mono); font-size: 12px; line-height: 1.6; white-space: pre-wrap;
  background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px 14px; margin: 0; max-height: 260px; overflow: auto;
}
.copy-btn {
  flex: none; font-size: 12px; padding: 5px 11px; color: var(--dim);
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px; cursor: pointer;
}
.copy-btn:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); }
.copy-btn.done {
  color: var(--ok); border-color: color-mix(in srgb, var(--ok) 55%, var(--line));
  background: color-mix(in srgb, var(--ok) 12%, var(--panel-2));
}
/* 说明文件行：缩进 + 左细线，表明它是「工作目录」扫出来的附属结果；
   圆角只给竖线（不是给盒子），避免又一张卡片 */
.rm-row {
  padding-left: 12px; margin-left: 2px;
  border-left: 1px solid var(--line); border-radius: 0 0 0 3px;
}
.rm-label { display: block; color: var(--dim); font-size: 12px; margin-bottom: 4px; }
.rm-sel { width: 100%; }
/* 下拉选项：路径与大小两端对齐，路径单行省略 */
.rm-opt { display: flex; align-items: center; gap: 10px; width: 100%; }
.rm-opt-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 单元格里的下拉（技术栈）：撑满格子，与输入框同高 */
.cell-sel { width: 100%; margin-top: 4px; }
/* AI 设置条：沉在服务卡下方，一条浅底横条把「模型」与它的作用绑在一起 */
.ai-bar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 12px; border: 1px dashed var(--line); border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 5%, transparent);
}
.ai-bar-key { color: var(--dim); font-size: 12px; flex: none; }
.ai-model-sel { flex: 0 1 260px; min-width: 180px; }
.ai-bar-hint { color: var(--dim); font-size: 11px; flex: 1 1 200px; min-width: 0; }
/* AI 按钮：常态安静，失败态要能被看见（换色，不是只换字） */
.btn.ai { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); color: var(--accent); }
.btn.ai.failed { border-color: color-mix(in srgb, var(--warn) 55%, var(--line)); color: var(--warn); }
/* 导入弹窗的 JSON 输入框：placeholder 即灰字提示，有内容自动消失（原生行为） */
.import-box {
  width: 100%; box-sizing: border-box; min-height: 220px; resize: vertical;
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px;
  color: var(--text); padding: 10px 12px; font-size: 12px; line-height: 1.6;
}
.import-box:focus { outline: none; border-color: var(--accent); }
.import-box::placeholder { color: var(--dim); }
/* 目录行：输入框 + 按钮（浏览/AI）同一行。
   规则直接挂在 .dir-line 上，不挂父选择器 —— 曾挂在 .dir-row 下，而项目目录与
   服务目录两处都没用 .dir-row，导致 flex 失效、按钮被挤到下一行。
   三处（项目目录/服务目录/AI 面板）共用这一条，别再各写一遍。 */
.dir-line { display: flex; gap: 8px; margin-top: 4px; }
/* flex:1 要盖过 .fld input/.dialog input 的 width:100%（同特异性，靠 flex-basis 取胜） */
.dir-line input { flex: 1 1 auto; min-width: 0; width: auto; }
.dir-line .btn { flex: none; }
/* 格式化条：左按钮右错误，错误用红色小字就地提示 */
.import-bar { display: flex; align-items: center; gap: 10px; margin: 8px 0 0; }
.import-err { color: var(--bad); font-size: 12px; }
.log {
  background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  max-height: 55vh; overflow: auto; margin: 0 0 4px; padding: 12px;
  font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all;
}
</style>
