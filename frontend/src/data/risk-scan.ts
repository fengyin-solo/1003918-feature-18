import {
  buildUnitProfiles,
  replacementCandidates,
  RISK_LEVELS,
  type RiskLevel,
  type UnitProfile,
} from './unit-profile'

// 扫描结果只保留一份：重复扫描在同一份结果上对账更新，
// 风险解除的单位连同其替换建议一起剔除，不允许旧建议残留。
const SCAN_STORAGE_KEY = 'geohazard-monitor-prevention:risk-scan'

export type ReplacementSuggestion = {
  projectId: string
  hazardId: string
  projectStatus: string
  // 替换建议优先推荐同隐患点履历单位，没有候选时留空提示人工指派。
  suggestedUnitId: number | null
  suggestedUnitCode: string
  suggestedUnitName: string
  reason: string
}

export type RiskUnitScan = {
  unitId: number
  unitCode: string
  unitName: string
  level: RiskLevel
  reasons: string[]
  certExpiry: string | null
  certState: UnitProfile['certState']
  registerDate: string
  registerDateFallback: boolean
  suggestions: ReplacementSuggestion[]
}

export type RiskScanResult = {
  scannedAt: string
  riskCount: number
  units: RiskUnitScan[]
}

type StoredSuggestion = ReplacementSuggestion

type StoredScan = {
  scannedAt: string
  units: Array<Omit<RiskUnitScan, 'suggestions'> & { suggestions: StoredSuggestion[] }>
}

let cache: RiskScanResult | null = null

function readStored(): StoredScan | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(SCAN_STORAGE_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as StoredScan
  } catch {
    return null
  }
}

function writeStored(result: RiskScanResult): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const payload: StoredScan = {
    scannedAt: result.scannedAt,
    units: result.units,
  }
  window.localStorage.setItem(SCAN_STORAGE_KEY, JSON.stringify(payload))
}

function buildSuggestion(
  project: UnitProfile['projects'][number],
  target: UnitProfile,
  profiles: UnitProfile[],
  previous: ReplacementSuggestion | undefined,
): ReplacementSuggestion {
  // 上一版建议的候选单位现在依然健康可承接时沿用，避免每次扫描结果乱跳；
  // 一旦该候选自身也出风险（档案变化），立即从同一份档案重新推荐。
  const stillValid =
    previous &&
    previous.suggestedUnitId !== null &&
    profiles.some(
      (unit) =>
        unit.id === previous.suggestedUnitId && unit.riskLevel === null && unit.eligible,
    )
  if (stillValid && previous) {
    return { ...previous }
  }

  const candidate = replacementCandidates(profiles, target)[0]
  if (!candidate) {
    return {
      projectId: project.projectId,
      hazardId: project.hazardId,
      projectStatus: project.status,
      suggestedUnitId: null,
      suggestedUnitCode: '',
      suggestedUnitName: '',
      reason: '暂无可承接的健康单位，需人工指派替换承建方',
    }
  }
  const matched = candidate.projects.some(
    (item) => item.active && item.hazardId && item.hazardId === project.hazardId,
  )
  return {
    projectId: project.projectId,
    hazardId: project.hazardId,
    projectStatus: project.status,
    suggestedUnitId: candidate.id,
    suggestedUnitCode: candidate.code,
    suggestedUnitName: candidate.name,
    reason: matched
      ? `该单位有隐患点 ${project.hazardId} 的治理履历，资质有效可直接承接`
      : '该单位资质有效且无风险记录，承建履历较充足',
  }
}

// 扫描核心：以当前单位档案为准重新生成结果。
// 与上一份结果按「单位 + 项目」对账，只保留仍有效建议；
// 风险解除的单位不会出现在新结果里，旧建议随之消失。
function reconcile(previous: RiskScanResult | null, now: Date): RiskScanResult {
  const profiles = buildUnitProfiles(now)
  const previousUnits = new Map(previous?.units.map((unit) => [unit.unitId, unit]) ?? [])

  const units: RiskUnitScan[] = []
  for (const profile of profiles) {
    if (profile.status === '已注销' || !profile.riskLevel) {
      // 风险解除：整单位（含建议）不再进入新结果。
      continue
    }
    const previousUnit = previousUnits.get(profile.id)
    const previousSuggestions = new Map(
      previousUnit?.suggestions.map((item) => [item.projectId, item]) ?? [],
    )

    const suggestions = profile.projects
      .filter((project) => project.active)
      .map((project) =>
        buildSuggestion(project, profile, profiles, previousSuggestions.get(project.projectId)),
      )

    units.push({
      unitId: profile.id,
      unitCode: profile.code,
      unitName: profile.name,
      level: profile.riskLevel,
      reasons: [...profile.riskReasons],
      certExpiry: profile.certExpiry,
      certState: profile.certState,
      registerDate: profile.registerDate,
      registerDateFallback: profile.registerDateFallback,
      suggestions,
    })
  }

  // 固定按风险等级严重度、再按单位编号排序，等级分布稳定。
  const levelOrder = new Map(RISK_LEVELS.map((level, index) => [level, index]))
  units.sort(
    (a, b) =>
      (levelOrder.get(a.level) ?? 0) - (levelOrder.get(b.level) ?? 0) ||
      a.unitCode.localeCompare(b.unitCode),
  )

  return {
    scannedAt: formatTime(now),
    riskCount: units.length,
    units,
  }
}

function formatTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

// 主动发起扫描：刷新一份建议并持久化，重复扫描不会新增副本。
export function runRiskScan(now: Date = new Date()): RiskScanResult {
  const result = reconcile(cache, now)
  cache = result
  writeStored(result)
  return result
}

// 读取最近一次扫描：页面刷新后拿存档，但先与当前档案对账，
// 档案里已解除的风险及其旧建议当场剔除（修复「刷新后建议不更新」）。
// 从未扫描过时返回 null，页面引导用户先发起扫描。
export function loadRiskScan(now: Date = new Date()): RiskScanResult | null {
  if (!cache) {
    const stored = readStored()
    if (!stored) {
      return null
    }
    cache = { scannedAt: stored.scannedAt, riskCount: stored.units.length, units: stored.units }
  }
  const reconciled = reconcile(cache, now)
  cache = reconciled
  writeStored(reconciled)
  return reconciled
}

export function clearRiskScan(): void {
  resetScanCache()
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(SCAN_STORAGE_KEY)
  }
}

// 切到下一次页面会话的内存态（测试用：模拟刷新后只靠 localStorage 恢复）。
export function resetScanCache(): void {
  cache = null
}

export function countByLevel(result: RiskScanResult | null): Record<RiskLevel, number> {
  const counts = Object.fromEntries(RISK_LEVELS.map((level) => [level, 0])) as Record<
    RiskLevel,
    number
  >
  for (const unit of result?.units ?? []) {
    counts[unit.level] += 1
  }
  return counts
}
