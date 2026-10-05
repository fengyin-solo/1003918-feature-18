<template>
  <section class="page" data-module="contract">
    <header class="page-head">
      <div>
        <h2>承建单位管理</h2>
        <p class="page-desc">维护承建单位资质与合作档案，并按证书有效期、项目履历、合作记录定位资质风险单位。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记承建单位</button>
        <button class="btn" type="button" @click="exportRows">导出承建单位清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="item.danger ? 'stat-danger' : ''">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '承接资格'">
              <span :class="['risk-badge', profileOf(Number(row.id))?.eligible ? 'badge-ok' : 'badge-danger']">
                {{ profileOf(Number(row.id))?.eligible ? '可承接' : '不可承接' }}
              </span>
            </template>
            <template v-else-if="column === '关联项目数'">{{ profileOf(Number(row.id))?.projectCount ?? 0 }}</template>
            <template v-else-if="column === '注册日期'">
              {{ profileOf(Number(row.id))?.registerDate || '—' }}
              <span v-if="profileOf(Number(row.id))?.registerDateFallback" class="fallback-tip" title="旧单位缺注册日期，按首次承建日期兼容显示">（按首次承建日期）</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            {{ row.status }}
            <span
              v-if="profileOf(Number(row.id))?.riskLevel"
              :class="['risk-badge', 'badge-risk']"
            >{{ profileOf(Number(row.id))?.riskLevel }}</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无承建单位数据，可先登记承建单位</td>
        </tr>
      </tbody>
    </table>

    <section class="scan-panel">
      <header class="scan-head">
        <div>
          <h3>资质风险定位扫描</h3>
          <p class="page-desc">
            与治理工程页共用同一份单位档案，按证书有效期、项目履历、合作记录定位风险单位，并为关联在建项目给出替换建议。
            <span v-if="scanResult">上次扫描：{{ scanResult.scannedAt }}</span>
          </p>
        </div>
        <div class="page-actions">
          <button class="btn primary" type="button" @click="scan">发起风险扫描</button>
          <button class="btn ghost" type="button" @click="clearScan">清空扫描结果</button>
        </div>
      </header>

      <div class="stat-row">
        <article v-for="item in levelCards" :key="item.label" class="stat-card">
          <span class="stat-label">{{ item.label }}</span>
          <strong class="stat-value" :class="item.value > 0 ? 'stat-danger' : ''">{{ item.value }}</strong>
        </article>
      </div>

      <p v-if="scanMessage" class="scan-tip">{{ scanMessage }}</p>

      <table v-if="scanResult" class="data-table scan-table">
        <thead>
          <tr>
            <th>风险等级</th>
            <th>单位编号</th>
            <th>单位名称</th>
            <th>证书有效期</th>
            <th>注册日期</th>
            <th>风险定位依据</th>
            <th>关联项目替换建议</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="unit in scanResult.units" :key="unit.unitId">
            <td><span class="risk-badge badge-risk">{{ unit.level }}</span></td>
            <td>{{ unit.unitCode }}</td>
            <td>{{ unit.unitName }}</td>
            <td>
              {{ unit.certExpiry || '未登记' }}
              <span v-if="unit.certState === '过期'" class="risk-badge badge-danger">已过期</span>
              <span v-else-if="unit.certState === '临期'" class="risk-badge badge-warn">临期</span>
            </td>
            <td>
              {{ unit.registerDate || '—' }}
              <span v-if="unit.registerDateFallback" class="fallback-tip">（按首次承建日期）</span>
            </td>
            <td>
              <ul class="reason-list">
                <li v-for="reason in unit.reasons" :key="reason">{{ reason }}</li>
              </ul>
            </td>
            <td>
              <ul v-if="unit.suggestions.length" class="suggest-list">
                <li v-for="suggestion in unit.suggestions" :key="suggestion.projectId">
                  <span class="suggest-project">{{ suggestion.projectId }}（{{ suggestion.projectStatus }}）</span>
                  <template v-if="suggestion.suggestedUnitId">
                    → 替换为
                    <strong>{{ suggestion.suggestedUnitName }}（{{ suggestion.suggestedUnitCode }}）</strong>
                    <span class="suggest-reason">{{ suggestion.reason }}</span>
                  </template>
                  <span v-else class="error-text">{{ suggestion.reason }}</span>
                </li>
              </ul>
              <span v-else class="muted-text">关联项目均已竣工，无需替换</span>
            </td>
          </tr>
          <tr v-if="!scanResult.units.length">
            <td colspan="7" class="empty-state">本次扫描未发现风险单位，历史风险建议已全部清除</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state scan-empty">尚未扫描，点击「发起风险扫描」定位临期、暂停合作与黑名单单位</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条承建单位记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { buildUnitProfiles, type UnitProfile } from '@/data/unit-profile'
import { clearRiskScan, countByLevel, loadRiskScan, runRiskScan, type RiskScanResult } from '@/data/risk-scan'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('contract')
const columns = ["单位编号", "单位名称", "资质等级", "联系人", "联系电话", "关联项目数", "注册日期", "证书有效期", "承接资格"]
const actions = ["暂停合作", "列入黑名单", "恢复正常"]
const statuses = ["正常", "暂停合作", "列入黑名单", "资质过期", "已注销"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["单位编号", "单位名称", "资质等级"]
const scanResult = ref<RiskScanResult | null>(null)
const scanMessage = ref('')

// 档案直接从当前合同与治理工程数据派生：状态动作后重建，扫描与列表始终同源。
const profiles = ref<UnitProfile[]>([])
const profileMap = computed(() => new Map(profiles.value.map((unit) => [unit.id, unit])))

function profileOf(id: number): UnitProfile | undefined {
  return profileMap.value.get(id)
}

function refreshProfiles() {
  profiles.value = buildUnitProfiles()
}

const stats = computed(() => [
  { label: '单位总数', value: profiles.value.length, danger: false },
  { label: '正常合作数', value: profiles.value.filter((unit) => unit.status === '正常' && unit.eligible).length, danger: false },
  { label: '风险单位数', value: profiles.value.filter((unit) => unit.riskLevel !== null).length, danger: true },
  { label: '黑名单数', value: profiles.value.filter((unit) => unit.status === '列入黑名单').length, danger: true },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const levelCounts = computed(() => countByLevel(scanResult.value))
const levelCards = computed(() => [
  { label: '黑名单单位', value: levelCounts.value['黑名单'] },
  { label: '暂停合作单位', value: levelCounts.value['暂停合作'] },
  { label: '资质过期单位', value: levelCounts.value['资质过期'] },
  { label: '证书临期单位', value: levelCounts.value['证书临期'] },
])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '承建单位登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  // 风险解除（恢复正常）后立即对账扫描结果：旧建议随风险单位一起消失。
  if (scanResult.value) {
    scanResult.value = loadRiskScan() ?? scanResult.value
  }
}

function scan() {
  errorMessage.value = ''
  scanResult.value = runRiskScan()
  scanMessage.value = `扫描完成：共定位 ${scanResult.value.riskCount} 家风险单位，替换建议已按最新档案更新`
}

function clearScan() {
  clearRiskScan()
  scanResult.value = null
  scanMessage.value = '扫描结果已清空，可重新发起扫描'
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    refreshProfiles()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '承建单位列表读取失败'
  }
}

onMounted(() => {
  reload()
  // 刷新页面后读回最近一次扫描，并先与当前档案对账，剔除已解除风险的旧建议。
  scanResult.value = loadRiskScan()
})
</script>
