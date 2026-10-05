<template>
  <section class="page" data-module="contract">
    <header class="page-head">
      <div>
        <h2>承建单位管理</h2>
        <p class="page-desc">维护承建单位，围绕单位编号、单位名称、资质等级、联系人做登记、筛选与状态流转；资质风险扫描与治理工程页共用同一份单位档案。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记承建单位</button>
        <button class="btn" type="button" @click="exportRows">导出承建单位清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
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
          <th>关联项目数</th>
          <th>承接资格</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in displayRows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '注册日期'">
              {{ row[column] || '—' }}
              <em v-if="row.__registerFallback" class="fallback-hint" title="旧单位档案缺注册日期，按首次承建日期兼容">按首次承建日期</em>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.__projectCount }}</td>
          <td>
            <span :class="row.__canContract ? 'tag tag-ok' : 'tag tag-block'">
              {{ row.__canContract ? '可承接' : '不可承接' }}
            </span>
            <span v-if="!row.__canContract" class="cell-note">{{ row.__blockReason }}</span>
          </td>
          <td>{{ row.status }}</td>
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
          <td :colspan="columns.length + 4" class="empty-state">暂无承建单位数据，可先登记承建单位</td>
        </tr>
      </tbody>
    </table>

    <section class="risk-panel">
      <header class="risk-head">
        <div>
          <h3>资质风险定位扫描</h3>
          <p class="risk-sub">
            按证书有效期、项目履历和合作记录定位临期、暂停合作、黑名单单位，并为每个风险单位列出关联在途项目的替换建议。
            提前预警 {{ scanResult.daysAhead }} 天 · 最近扫描：{{ scannedAtText }}
          </p>
        </div>
        <button class="btn primary" type="button" :disabled="scanning" @click="runScan">
          {{ scanning ? '扫描中…' : '重新扫描' }}
        </button>
      </header>

      <div class="risk-level-bar">
        <button
          v-for="option in levelOptions"
          :key="option"
          type="button"
          class="level-chip"
          :class="{ active: activeLevel === option }"
          @click="activeLevel = option"
        >
          {{ option === '全部' ? '全部风险' : option }}
          <strong>{{ option === '全部' ? scanResult.items.length : scanResult.summary[option] ?? 0 }}</strong>
        </button>
      </div>

      <article v-for="item in filteredRisks" :key="String(item.unitId)" class="risk-card">
        <header class="risk-card-head">
          <span class="risk-badge" :data-level="item.level">{{ item.level }}</span>
          <div class="risk-unit">
            <strong>{{ item.unitName }}</strong>
            <span class="risk-unit-meta">{{ item.unitCode }} · {{ item.grade }} · {{ item.contact }} {{ item.phone }}</span>
          </div>
          <span :class="item.canContract ? 'tag tag-ok' : 'tag tag-block'">
            {{ item.canContract ? '仍可承接（证书临期）' : '不可承接新项目' }}
          </span>
        </header>
        <p class="risk-reason">{{ item.reason }}；{{ item.blockReason || '请在到期前完成资质延续，期间正常履约' }}</p>
        <p class="risk-meta-line">
          <span>证书有效期：{{ item.certExpiry || '未登记' }}</span>
          <span>合作状态：{{ item.cooperationStatus }}</span>
          <span>
            注册日期：{{ item.registerDate || '无项目履历可推导' }}
            <em v-if="item.registerDateFallback" class="fallback-hint">按首次承建日期兼容</em>
          </span>
          <span>在途关联项目：{{ item.relatedActiveProjects }} 个</span>
        </p>

        <table v-if="item.suggestions.length" class="data-table suggest-table">
          <thead>
            <tr>
              <th>关联项目编号</th>
              <th>隐患点编号</th>
              <th>治理方案</th>
              <th>项目状态</th>
              <th>建议替换单位</th>
              <th>替换理由</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="suggestion in item.suggestions" :key="suggestion.projectId">
              <td>{{ suggestion.projectId }}</td>
              <td>{{ suggestion.hazardId }}</td>
              <td>{{ suggestion.scheme }}</td>
              <td>{{ suggestion.projectStatus }}</td>
              <td>
                <template v-if="suggestion.suggestUnitName">
                  {{ suggestion.suggestUnitName }}
                  <span class="cell-note">{{ suggestion.suggestUnitId }} · {{ suggestion.suggestGrade }}</span>
                </template>
                <template v-else>
                  <span class="tag tag-warn">暂无可替换单位</span>
                </template>
              </td>
              <td>{{ suggestion.reason }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="risk-no-project">该单位名下没有在途项目（已竣工项目无需替换），仅限制新增承接。</p>
      </article>

      <p v-if="!filteredRisks.length" class="empty-state risk-empty">
        {{ scanResult.items.length ? '当前筛选等级下没有风险单位' : '扫描完成，档案中暂无临期、暂停合作或黑名单单位' }}
      </p>
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
import {
  EXPIRE_WARNING_DAYS,
  loadQualificationScan,
  scanQualificationRisk,
  unitProjectHistory,
} from '@/api/qualification-risk'
import type { EntryRow, QualificationRiskLevel, QualificationScanResult } from '@/data/types'

const meta = moduleMeta('contract')
const columns = ["单位编号", "单位名称", "资质等级", "联系人", "联系电话", "资质证书有效期", "注册日期", "单位状态"]
const actions = ["暂停合作", "列入黑名单", "恢复正常"]
const statuses = ["正常", "暂停合作", "列入黑名单", "资质过期", "已注销"]
const stats = [{ "label": "单位总数", "value": 0 }, { "label": "正常合作数", "value": 0 }, { "label": "黑名单数", "value": 0 }]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 扫描快照全仓只有一份：重新扫描整体覆盖，风险解除后旧建议随快照一起消失。
const scanResult = ref<QualificationScanResult>({
  scannedAt: '',
  daysAhead: EXPIRE_WARNING_DAYS,
  items: [],
  summary: { 黑名单: 0, 暂停合作: 0, 资质过期: 0, 临期: 0 },
})
const scanning = ref(false)
const activeLevel = ref<'全部' | QualificationRiskLevel>('全部')

const levelOptions: ('全部' | QualificationRiskLevel)[] = ['全部', '黑名单', '暂停合作', '资质过期', '临期']

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const riskByUnitId = computed(() => {
  const map = new Map<number, QualificationScanResult['items'][number]>()
  for (const item of scanResult.value.items) {
    map.set(item.unitId, item)
  }
  return map
})

// 主表上的项目履历直接读治理工程档案：与治理工程页共用同一份数据。
type DisplayRow = EntryRow & {
  __projectCount: number
  __registerFallback: boolean
  __canContract: boolean
  __blockReason: string
}

const displayRows = computed<DisplayRow[]>(() =>
  rows.value.map((row): DisplayRow => {
    const risk = riskByUnitId.value.get(Number(row.id))
    return {
      ...row,
      __projectCount: unitProjectHistory(String(row['单位名称'] ?? '')).length,
      __registerFallback: risk?.registerDateFallback ?? false,
      __canContract: risk ? risk.canContract : String(row.status) === '正常',
      __blockReason: risk?.blockReason ?? '',
    }
  }),
)

const filteredRisks = computed(() =>
  activeLevel.value === '全部'
    ? scanResult.value.items
    : scanResult.value.items.filter((item) => item.level === activeLevel.value),
)

const scannedAtText = computed(() => {
  if (!scanResult.value.scannedAt) {
    return '未扫描'
  }
  return new Date(scanResult.value.scannedAt).toLocaleString()
})

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
  // 动作改的是同一份单位档案，立即重扫，保证解除风险的旧建议当场消失。
  runScan()
}

function runScan() {
  scanning.value = true
  try {
    scanResult.value = scanQualificationRisk()
  } finally {
    scanning.value = false
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '承建单位列表读取失败'
  }
}

onMounted(() => {
  reload()
  scanResult.value = loadQualificationScan()
})
</script>

<style scoped>
.fallback-hint {
  margin-left: 4px;
  padding: 0 6px;
  border-radius: 999px;
  background: #eef2f7;
  color: var(--muted);
  font-size: 11px;
  font-style: normal;
  white-space: nowrap;
}
.cell-note {
  display: block;
  color: var(--muted);
  font-size: 12px;
}
.tag {
  display: inline-block;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  white-space: nowrap;
}
.tag-ok {
  background: #e7f6ec;
  color: #1a7f37;
}
.tag-block {
  background: #fdecec;
  color: #b42318;
}
.tag-warn {
  background: #fff4e0;
  color: #b54708;
}
.risk-panel {
  margin-top: 18px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
}
.risk-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.risk-head h3 {
  margin: 0;
  font-size: 16px;
}
.risk-sub {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 12px;
  max-width: 760px;
}
.risk-level-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}
.level-chip {
  border: 1px solid var(--border);
  background: #f6f8fb;
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
}
.level-chip strong {
  margin-left: 6px;
  color: var(--brand);
}
.level-chip.active {
  border-color: var(--brand);
  background: #eaf1fe;
  color: var(--brand);
}
.risk-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.risk-card-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.risk-badge {
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 13px;
  color: #fff;
  background: #64748b;
}
.risk-badge[data-level='黑名单'] {
  background: #b42318;
}
.risk-badge[data-level='暂停合作'] {
  background: #b54708;
}
.risk-badge[data-level='资质过期'] {
  background: #c4320a;
}
.risk-badge[data-level='临期'] {
  background: #b7791f;
}
.risk-unit {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.risk-unit-meta {
  color: var(--muted);
  font-size: 12px;
}
.risk-reason {
  margin: 8px 0 4px;
  font-size: 13px;
}
.risk-meta-line {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin: 0 0 10px;
  color: var(--muted);
  font-size: 12px;
}
.suggest-table {
  margin-top: 6px;
}
.risk-no-project {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 13px;
}
.risk-empty {
  padding: 20px;
}
</style>
