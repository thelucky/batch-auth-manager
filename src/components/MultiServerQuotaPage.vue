<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { RequestClient } from '../lib/request'
import { fetchQuotaByType, codexQuota, type AccountDetailKind, type QuotaResult } from '../api/quota'
import type { AuthFile, AuthFilesResponse } from '../api/authFiles'
import { useAuthStore } from '../stores/auth'
import { useNotificationStore } from '../stores/notification'
import { supportsQuota, getProviderDisplayName, getQuotaPercentClass, QUOTA_CONFIG } from '../config/constants'
import { formatResetTime, formatQuotaPlanType } from '../utils/quota'
import Button from './ui/Button.vue'
import Input from './ui/Input.vue'
import Label from './ui/Label.vue'
import Dialog from './ui/dialog/Dialog.vue'
import Select from './ui/select/Select.vue'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from './ui/table'
import { RefreshCw, Plus, Server, CircleHelp } from 'lucide-vue-next'

interface ServerProfile {
  id: string
  name: string
  url: string
  key: string
}
interface QuotaEntry {
  result?: QuotaResult
  error?: string
  updatedAt: number
}
interface ServerState {
  files: AuthFile[]
  entries: Record<string, QuotaEntry>
  loadingFile: Record<string, boolean>
  loading: boolean
  loaded: boolean
  error: string
  total: number
}

const STORAGE_KEY = 'quota-servers'
const CACHE_PREFIX = 'quota-server-cache:'
const CACHE_VERSION = 1
const CONCURRENCY = 5
const authStore = useAuthStore()
const notifications = useNotificationStore()

function readServers(): ServerProfile[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    return Array.isArray(saved) ? saved.filter((item: ServerProfile) =>
      item && [item.id, item.name, item.url, item.key].every(value => typeof value === 'string' && value.length > 0)
    ) : []
  } catch {
    return []
  }
}

const servers = ref<ServerProfile[]>(readServers())
// 外层按服务器固定 ID 隔离，内层保留原文件名；不会与管理页面的缓存混用。
const states = reactive<Record<string, ServerState>>(readCache())
const querying = ref(false)
const filter = ref('')
const search = ref('')
const showEditor = ref(false)
const form = ref<ServerProfile>({ id: '', name: '', url: '', key: '' })
const visibleServers = computed(() => servers.value.filter(server => !filter.value || server.id === filter.value))

function stateFor(id: string): ServerState {
  return states[id] ||= { files: [], entries: {}, loadingFile: {}, loading: false, loaded: false, error: '', total: 0 }
}

function readCache(): Record<string, ServerState> {
  const restored: Record<string, ServerState> = {}
  for (const server of servers.value) {
    try {
      const cached = JSON.parse(localStorage.getItem(`${CACHE_PREFIX}${server.id}`) || 'null')
      const state = cached?.state
      if (cached?.version !== CACHE_VERSION || cached.url !== server.url || !Array.isArray(state?.files) ||
        !state.entries || typeof state.entries !== 'object') continue
      restored[server.id] = { ...state, loading: false, loadingFile: {} }
    } catch {
      // 缓存缺失或损坏时，等待用户手动刷新。
    }
  }
  return restored
}

function saveCache(server: ServerProfile) {
  const { files, entries, loaded, error, total } = stateFor(server.id)
  try {
    localStorage.setItem(`${CACHE_PREFIX}${server.id}`, JSON.stringify({
      version: CACHE_VERSION,
      url: server.url,
      state: { files, entries, loaded, error, total }
    }))
  } catch {
    notifications.warning('额度缓存保存失败，刷新页面后需手动查询')
  }
}

function clearCache(id: string) {
  delete states[id]
  localStorage.removeItem(`${CACHE_PREFIX}${id}`)
}

function visibleFiles(id: string) {
  const keyword = search.value.trim().toLowerCase()
  return stateFor(id).files.filter(file => !keyword || `${file.name} ${file.email || ''} ${file.type}`.toLowerCase().includes(keyword))
}

function quotaItems(entry?: QuotaEntry): { name: string; percent: number | null; resetTime?: string | number }[] {
  const result = entry?.result
  if (!result) return []
  const data = result.data
  if (result.type === 'antigravity') return (data.groups || []).map((item: any) => ({ ...item, name: item.name }))
  if (result.type === 'gemini-cli') return (data.buckets || []).map((item: any) => ({ ...item, name: item.modelId }))
  return (data.limits || []).map((item: any) => ({ ...item, name: item.model }))
}

function quotaBarClass(percent: number) {
  if (percent >= QUOTA_CONFIG.thresholds.sufficient) return 'bg-green-500 dark:bg-green-400'
  if (percent >= QUOTA_CONFIG.thresholds.warning) return 'bg-yellow-500 dark:bg-yellow-400'
  return 'bg-red-500 dark:bg-red-400'
}

function accountDetails(id: string, fileName: string) {
  const result = stateFor(id).entries[fileName]?.result
  return result?.type === 'codex' ? result.data : null
}

function formatAccountDate(timestamp?: number | null) {
  if (!timestamp) return '未获取'
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  })
}

function formatCreditBalance(data: any) {
  if (data?.unlimitedCredits) return '不限额'
  return data?.creditBalance != null ? String(Math.trunc(data.creditBalance)) : '未获取'
}

async function queryAccountDetails(server: ServerProfile, file: AuthFile, kind: AccountDetailKind) {
  if (querying.value) return
  const data = accountDetails(server.id, file.name)
  if (!data) return
  querying.value = true
  const client = new RequestClient()
  client.initialize(server.url, server.key)
  try {
    const details = await codexQuota.fetchAccountDetails(file, kind, client)
    data[kind] = details
    data.subscriptionError = kind === 'subscription' ? null : data.subscriptionError
    saveCache(server)
    notifications.success('查询完成')
  } catch (error: any) {
    notifications.error(error.message || '查询失败')
  } finally {
    querying.value = false
  }
}

function editServer(server?: ServerProfile) {
  form.value = { ...(server || { id: '', name: '', url: '', key: '' }) }
  showEditor.value = true
}

function importCurrent() {
  editServer()
  form.value.name = '当前服务器'
  form.value.url = authStore.apiUrl
  form.value.key = authStore.managementKey
}

function saveServer() {
  if (querying.value) return
  const name = form.value.name.trim()
  const key = form.value.key.trim()
  let url: string
  try {
    const parsed = new URL(form.value.url.trim())
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error()
    url = parsed.href.replace(/\/+$/, '')
  } catch {
    notifications.warning('请填写有效的 HTTP 或 HTTPS API 地址，不包含查询参数或账号密码')
    return
  }
  if (!name || !key) {
    notifications.warning('请填写服务器名称和管理密钥')
    return
  }
  if (servers.value.some(server => server.id !== form.value.id && server.url === url)) {
    notifications.warning('该服务器地址已添加')
    return
  }
  const previous = servers.value.find(server => server.id === form.value.id)
  const profile = { id: form.value.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`, name, url, key }
  const next = previous ? servers.value.map(server => server.id === profile.id ? profile : server) : [...servers.value, profile]
  try {
    if (previous && (previous.url !== url || previous.key !== key)) clearCache(profile.id)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    notifications.error('保存失败，请检查浏览器存储是否可用')
    return
  }
  servers.value = next
  showEditor.value = false
  form.value.key = ''
}

async function removeServer(server: ServerProfile) {
  const confirmed = await notifications.showConfirmation({ title: '移除服务器', message: `从额度列表移除“${server.name}”？服务器上的文件不受影响。`, variant: 'danger' })
  if (!confirmed || querying.value) return
  const next = servers.value.filter(item => item.id !== server.id)
  try {
    clearCache(server.id)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    notifications.error('移除失败，请检查浏览器存储是否可用')
    return
  }
  servers.value = next
  if (filter.value === server.id) filter.value = ''
}

async function loadServer(server: ServerProfile) {
  const state = stateFor(server.id)
  const client = new RequestClient()
  client.initialize(server.url, server.key)
  state.loading = true
  try {
    const response = await client.get<AuthFilesResponse>('/v0/management/auth-files')
    const files = response.files || []
    state.total = files.length
    state.files = files.filter(file => supportsQuota(file.type))
    state.loaded = true
    state.error = ''
    const names = new Set(state.files.map(file => file.name))
    for (const name of Object.keys(state.entries)) {
      if (!names.has(name)) delete state.entries[name]
    }
    saveCache(server)
    const targets = state.files
    for (let index = 0; index < targets.length; index += CONCURRENCY) {
      await Promise.all(targets.slice(index, index + CONCURRENCY).map(async file => {
        state.loadingFile[file.name] = true
        try {
          const result = await fetchQuotaByType(file, client)
          const previous = state.entries[file.name]?.result
          if (result.type === 'codex' && previous?.type === 'codex') {
            result.data.subscription = previous.data.subscription
            result.data.subscriptionError = previous.data.subscriptionError
            if (result.data.resetCredits?.availableCount === previous.data.resetCredits?.availableCount) {
              result.data.resetCredits = previous.data.resetCredits
            }
          }
          state.entries[file.name] = { result, updatedAt: Date.now() }
        } catch (error: any) {
          state.entries[file.name] = { result: state.entries[file.name]?.result, error: error.message || '查询失败', updatedAt: Date.now() }
        } finally {
          delete state.loadingFile[file.name]
        }
      }))
      saveCache(server)
    }
  } catch (error: any) {
    state.error = error.message || '连接失败'
    saveCache(server)
  } finally {
    state.loading = false
  }
}

async function refresh(targets: ServerProfile[]) {
  if (querying.value) return
  querying.value = true
  try {
    for (const server of targets) await loadServer(server)
  } finally {
    querying.value = false
  }
}

</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-xl font-semibold">统一额度</h2>
        <p class="mt-1 text-sm text-muted-foreground">集中查看各服务器的账号剩余配额，不影响当前管理连接。</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" :disabled="querying || !authStore.apiUrl || !authStore.managementKey" @click="importCurrent">添加当前连接</Button>
        <Button variant="outline" :disabled="querying" @click="editServer()"><Plus class="mr-2 h-4 w-4" />添加服务器</Button>
        <Button :disabled="querying || !servers.length" @click="refresh(servers)"><RefreshCw class="mr-2 h-4 w-4" :class="{ 'animate-spin': querying }" />{{ querying ? '查询中…' : '全部刷新' }}</Button>
      </div>
    </div>

    <div v-if="servers.length" class="flex flex-wrap gap-3">
      <Select v-model="filter" class="w-48" aria-label="筛选服务器">
        <option value="">全部服务器</option>
        <option v-for="server in servers" :key="server.id" :value="server.id">{{ server.name }}</option>
      </Select>
      <Input v-model="search" class="max-w-sm" placeholder="搜索文件名、邮箱或类型" aria-label="搜索账号" />
    </div>
    <div v-else class="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
      添加 CPA 服务器地址和管理密钥，即可在此统一查询额度。
    </div>

    <section v-for="server in visibleServers" :key="server.id" class="overflow-hidden rounded-lg border">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/30 p-4">
        <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <h3 class="flex shrink-0 items-center gap-2 font-semibold"><Server class="h-4 w-4" />{{ server.name }}</h3>
          <p class="break-all text-xs text-muted-foreground">{{ server.url }}</p>
          <p v-if="stateFor(server.id).loaded" class="text-xs text-muted-foreground">{{ stateFor(server.id).files.length }} 个账号支持额度查询 / 共 {{ stateFor(server.id).total }} 个认证文件</p>
        </div>
        <div class="flex gap-2">
          <Button size="sm" variant="outline" :disabled="querying" @click="editServer(server)">编辑</Button>
          <Button size="sm" variant="outline" :disabled="querying" @click="removeServer(server)">移除</Button>
          <Button size="sm" :disabled="querying" @click="refresh([server])">{{ stateFor(server.id).loading ? '查询中…' : '刷新额度' }}</Button>
        </div>
      </div>
      <p v-if="stateFor(server.id).error" class="break-all p-4 text-sm text-destructive">连接失败：{{ stateFor(server.id).error }}。{{ stateFor(server.id).loaded ? '下方为上次查询结果。' : '' }}</p>
      <Table class="min-w-[1280px] table-fixed">
        <colgroup>
          <col />
          <col class="w-20" />
          <col class="w-64" />
          <col class="w-44" />
          <col class="w-24" />
          <col class="w-36" />
          <col class="w-[152px]" />
        </colgroup>
        <TableHeader><TableRow><TableHead class="whitespace-nowrap">认证文件 / 账号</TableHead><TableHead class="whitespace-nowrap">类型</TableHead><TableHead>配额</TableHead><TableHead class="whitespace-nowrap">续期时间</TableHead><TableHead class="whitespace-nowrap">Credit 余额</TableHead><TableHead class="whitespace-nowrap">剩余重置次数</TableHead><TableHead class="whitespace-nowrap">更新时间</TableHead></TableRow></TableHeader>
        <TableBody>
          <TableRow v-for="file in visibleFiles(server.id)" :key="file.name">
            <TableCell class="break-all">
              <div>{{ server.name }} / {{ file.name }}</div>
              <div v-if="file.email" class="mt-1 text-xs text-muted-foreground">{{ file.email }}</div>
              <div v-if="file.disabled" class="mt-1 text-xs text-muted-foreground">已禁用</div>
            </TableCell>
            <TableCell>{{ getProviderDisplayName(file.type) }}<div v-if="stateFor(server.id).entries[file.name]?.result?.data.planType" class="text-xs text-muted-foreground">{{ formatQuotaPlanType(stateFor(server.id).entries[file.name]?.result?.data.planType) }}</div></TableCell>
            <TableCell>
              <span v-if="stateFor(server.id).loadingFile[file.name]" class="text-muted-foreground">查询中…</span>
              <span v-else-if="stateFor(server.id).entries[file.name]?.error" class="break-all text-destructive">{{ stateFor(server.id).entries[file.name].error }}</span>
              <div v-else-if="quotaItems(stateFor(server.id).entries[file.name]).length" class="space-y-1">
                <div v-for="item in quotaItems(stateFor(server.id).entries[file.name])" :key="item.name" class="text-xs">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-muted-foreground">{{ item.name }}<span v-if="item.resetTime" class="ml-2">{{ formatResetTime(item.resetTime, true) }}</span></span>
                    <span :class="item.percent === null ? 'text-muted-foreground' : getQuotaPercentClass(item.percent)" class="shrink-0">{{ item.percent === null ? '无法获取' : `${item.percent}%` }}</span>
                  </div>
                  <div v-if="item.percent !== null" class="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-muted" role="progressbar" :aria-label="`${item.name} 剩余配额`" :aria-valuenow="item.percent" :aria-valuemin="0" :aria-valuemax="100">
                    <div class="h-full rounded-full" :class="quotaBarClass(item.percent)" :style="{ width: `${item.percent}%` }" />
                  </div>
                </div>
              </div>
              <span v-else class="text-muted-foreground">{{ stateFor(server.id).entries[file.name] ? '暂无配额信息' : '待查询' }}</span>
            </TableCell>
            <TableCell class="whitespace-nowrap text-xs">
              <template v-if="accountDetails(server.id, file.name)">
                <div class="flex items-center gap-1">
                  <span :title="accountDetails(server.id, file.name).subscriptionError || ''">{{ formatAccountDate(accountDetails(server.id, file.name).subscription?.activeUntil) }}</span>
                  <Button size="icon" variant="ghost" class="h-6 w-6 shrink-0 text-muted-foreground" title="查询续期时间" aria-label="查询续期时间" :disabled="querying" @click="queryAccountDetails(server, file, 'subscription')"><CircleHelp class="h-4 w-4" /></Button>
                </div>
              </template>
              <span v-else class="text-muted-foreground">-</span>
            </TableCell>
            <TableCell class="text-xs">{{ accountDetails(server.id, file.name) ? formatCreditBalance(accountDetails(server.id, file.name)) : '-' }}</TableCell>
            <TableCell class="whitespace-nowrap text-xs">
              <template v-if="accountDetails(server.id, file.name)">
                <div class="flex items-center gap-1">
                  <span>{{ accountDetails(server.id, file.name).resetCredits?.availableCount ?? '未获取' }}<span v-if="accountDetails(server.id, file.name).resetCredits?.availableCount != null"> 次</span></span>
                  <Button size="icon" variant="ghost" class="h-6 w-6 shrink-0 text-muted-foreground" title="查询重置过期时间" aria-label="查询重置过期时间" :disabled="querying" @click="queryAccountDetails(server, file, 'resetCredits')"><CircleHelp class="h-4 w-4" /></Button>
                </div>
                <div v-for="(credit, index) in accountDetails(server.id, file.name).resetCredits?.credits || []" :key="credit.id || index" class="mt-1 text-muted-foreground">{{ credit.noExpiry ? '无过期时间' : formatAccountDate(credit.expiresAt) }}</div>
                <div v-if="accountDetails(server.id, file.name).resetCredits?.credits?.length && accountDetails(server.id, file.name).resetCredits.availableCount > accountDetails(server.id, file.name).resetCredits.credits.length" class="mt-1 text-muted-foreground">其余 {{ accountDetails(server.id, file.name).resetCredits.availableCount - accountDetails(server.id, file.name).resetCredits.credits.length }} 次过期时间未获取</div>
                <div v-if="accountDetails(server.id, file.name).resetCredits?.availableCount !== 0 && !accountDetails(server.id, file.name).resetCredits?.credits?.length" class="mt-1 text-muted-foreground" :title="accountDetails(server.id, file.name).resetCredits?.error || ''">过期时间未获取</div>
              </template>
              <span v-else class="text-muted-foreground">-</span>
            </TableCell>
            <TableCell class="whitespace-nowrap text-xs text-muted-foreground">{{ stateFor(server.id).entries[file.name]?.updatedAt ? new Date(stateFor(server.id).entries[file.name].updatedAt).toLocaleString('zh-CN') : '-' }}</TableCell>
          </TableRow>
          <TableRow v-if="!visibleFiles(server.id).length"><TableCell :colspan="7" class="py-8 text-center text-muted-foreground">{{ stateFor(server.id).loading ? '正在读取认证文件…' : !stateFor(server.id).loaded ? '点击刷新额度开始查询' : search.trim() ? '没有匹配的账号' : '没有支持额度查询的账号' }}</TableCell></TableRow>
        </TableBody>
      </Table>
    </section>

    <Dialog :open="showEditor" @update:open="showEditor = $event" :title="form.id ? '编辑服务器' : '添加服务器'" description="连接信息仅保存在当前浏览器，与现有管理连接独立。">
      <form class="space-y-4" @submit.prevent="saveServer">
        <div class="space-y-2"><Label for="quota-server-name">服务器名称</Label><Input id="quota-server-name" v-model="form.name" placeholder="例如：服务器一" required /></div>
        <div class="space-y-2"><Label for="quota-server-url">API 地址</Label><Input id="quota-server-url" v-model="form.url" placeholder="http://localhost:8317" required /></div>
        <div class="space-y-2"><Label for="quota-server-key">管理密钥</Label><Input id="quota-server-key" v-model="form.key" type="password" autocomplete="off" required /></div>
        <div class="flex justify-end gap-2"><Button type="button" variant="outline" @click="showEditor = false">取消</Button><Button type="submit" :disabled="querying">保存</Button></div>
      </form>
    </Dialog>
  </div>
</template>
