import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
// 官方深色变量：一次性盖住 select 下拉、分页、日期面板等传送门组件，不必逐个手补
import 'element-plus/theme-chalk/dark/css-vars.css'
document.documentElement.classList.add('dark')
import './styles.css'
import App from './App.vue'

createApp(App).use(ElementPlus, { locale: zhCn }).mount('#app')
