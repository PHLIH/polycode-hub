<script setup>
import { ref, onMounted } from 'vue'
import { api, getKey, setKey, clearKey, AuthError } from './api.js'
import Login from './views/Login.vue'
import Dashboard from './views/Dashboard.vue'
import Providers from './views/Providers.vue'
import Accounts from './views/Accounts.vue'
import Discover from './views/Discover.vue'
import Projects from './views/Projects.vue'

const view = ref('dashboard')
const authed = ref(false)
const checking = ref(true)

async function probe(key) {
  if (key) setKey(key)
  try {
    await api.stats()
    authed.value = true
    return true
  } catch (e) {
    if (e instanceof AuthError) { clearKey(); return false }
    // 非鉴权错误（断网/后端未起）也放行进入：首屏不挡死，页面内各表再各自报错。
    // 代价是口令错误且同时断网时会被误放行一次，下一次成功请求会重新鉴权。
    authed.value = true
    return true
  }
}

onMounted(async () => {
  await probe(getKey())
  checking.value = false
})

async function onLogin(key) {
  await probe(key)
}

const pages = {
  dashboard: { comp: Dashboard, label: '概览' },
  providers: { comp: Providers, label: 'Provider' },
  accounts: { comp: Accounts, label: '账号池' },
  discover: { comp: Discover, label: '发现' },
  projects: { comp: Projects, label: '项目' }
}
</script>

<template>
  <div v-if="checking" class="boot">连接中…</div>
  <Login v-else-if="!authed" @login="onLogin" />
  <div v-else class="shell">
    <aside class="rail">
      <div class="brand">
        <span class="brand-mark">▚</span>
        <div>
          <div class="brand-name">polycode-hub</div>
          <div class="brand-sub">多源额度网关</div>
        </div>
      </div>
      <nav class="nav">
        <button v-for="(p, k) in pages" :key="k" class="nav-item" :class="{ active: view === k }"
          @click="view = k">
          {{ p.label }}
        </button>
      </nav>
      <footer class="rail-foot" />
    </aside>
    <main class="main">
      <!-- 视图内跳转（如发现页「去 Provider 页」）：本应用没有 router，靠这个事件切换。 -->
      <component :is="pages[view].comp" @navigate="view = $event" />
    </main>
  </div>
</template>

<style scoped>
.boot { display: grid; place-items: center; height: 100%; color: var(--dim); }
.shell { display: flex; height: 100%; }
.rail {
  width: 200px; flex: none; display: flex; flex-direction: column;
  background: var(--panel); border-right: 1px solid var(--line); padding: 16px 12px;
  box-sizing: border-box;
}
.brand { display: flex; gap: 10px; align-items: center; padding: 4px 8px 18px; }
.brand-mark { color: var(--accent); font-size: 20px; }
.brand-name { font-family: var(--mono); font-size: 14px; }
.brand-sub { font-size: 11px; color: var(--dim); }
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav-item {
  text-align: left; padding: 8px 12px; border: 0; border-radius: var(--r-ctl);
  background: transparent; color: var(--dim); font-size: 14px; cursor: pointer;
}
.nav-item:hover { color: var(--text); background: var(--panel-2); }
.nav-item.active { color: var(--text); background: var(--panel-2); box-shadow: inset 2px 0 0 var(--accent); }
.rail-foot { margin-top: auto; padding: 8px; }
.main { flex: 1; overflow: auto; padding: 20px 24px; box-sizing: border-box; }
</style>
