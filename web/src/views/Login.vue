<script setup>
import { ref } from 'vue'

const emit = defineEmits(['login'])
const key = ref('')
const err = ref('')
const busy = ref(false)

async function submit() {
  if (!key.value) { err.value = '请输入管理口令（配置中的 gateway.admin_key）'; return }
  busy.value = true
  err.value = ''
  emit('login', key.value)
  // App.vue 探测失败会回到本页；这里不做额外处理
  setTimeout(() => { busy.value = false }, 600)
}
</script>

<template>
  <div class="wrap">
    <form class="card" @submit.prevent="submit">
      <div class="mark">▚</div>
      <h1>polycode-hub</h1>
      <p class="hint">输入 admin_key 进入控制台。口令只保存在本浏览器。</p>
      <input v-model="key" type="password" class="input" placeholder="admin_key" autofocus />
      <button class="btn" type="submit" :disabled="busy">进入控制台</button>
      <p v-if="err" class="err">{{ err }}</p>
    </form>
  </div>
</template>

<style scoped>
.wrap { display: grid; place-items: center; height: 100%; }
.card {
  width: 320px; padding: 32px 28px; box-sizing: border-box;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  display: flex; flex-direction: column; gap: 14px;
}
.mark { color: var(--accent); font-size: 28px; }
h1 { font-family: var(--mono); font-size: 18px; margin: 0; }
.hint { color: var(--dim); font-size: 12px; margin: 0; line-height: 1.6; }
.input {
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px;
  color: var(--text); padding: 10px 12px; font-size: 14px; outline: none;
}
.input:focus { border-color: var(--accent); }
.btn {
  background: var(--accent); color: #0b1119; border: 0; border-radius: 6px;
  padding: 10px 0; font-size: 14px; font-weight: 600; cursor: pointer;
}
.btn:disabled { opacity: .6; }
.err { color: var(--bad); font-size: 12px; margin: 0; }
</style>
