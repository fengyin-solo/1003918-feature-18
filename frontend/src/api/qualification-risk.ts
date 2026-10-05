import { listRows, readJson, writeJson } from '@/data/local-store'
import type {
  QualificationRiskItem,
  QualificationRiskLevel,
  QualificationScanResult,
  ReplacementSuggestion,
} from '@/data/types'

// 资质风险定位扫描：单位档案（contract）与治理工程档案（engineering）是扫描的唯一数据源，
// 治理工程页看到的承建方、承建单位页看到的项目履历都从同一份档案取，杜绝两边对不上。

const SNAPSHOT_KEY = 'geohazard-monitor-prevention:qualification-scan'

// 证书到期前多少天进入临期扫描范围。
export const EXPIRE_WARNING_DAYS = 90

// 已落锤的项目不需要替换施工方，其余在途状态都要给出替换建议。
const ACTIVE_PROJECT_STATUSES = ['待立项', '招标中', '施工中', '待验收', '验收中']

const RISK_LEVELS: QualificationRiskLevel[] = ['黑名单', '暂停合作', '资质过期', '临期']

const GRADE_RANK: Record<string, number> = { 甲级: 1, 乙级: 2, 丙级: 3 }
const LEVEL_ORDER: Record<QualificationRiskLevel, number> = {
  黑名单: 0,
  暂停合作: 1,
  资质过期: 2,
  临期: 3,
}

type ProjectRef = {
  projectId: string
  hazardId: string
  scheme: string
  status: string
  startDate: string
  unitName: string
}

type UnitArchive = {
  id: number
  code: string
  name: string
  grade: string
  contact: string
  phone: string
  registerDate: string
  registerDateFallback: boolean
  certExpiry: string
  cooperationStatus: string
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

// 用 UTC 解析 YYYY-MM-DD，避免本地时区把日期往前后挪一天。
function parseDate(value: string): number | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!matched) {
    return null
  }
  return Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]))
}

function todayStart(): number {
  const now = new Date()
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
}

function diffDays(from: number, to: number): number {
  return Math.round((to - from) / 86_400_000)
}

function loadProjects(): ProjectRef[] {
  return listRows('engineering')
    .map((row) => ({
      projectId: text(row['项目编号']),
      hazardId: text(row['隐患点编号']),
      scheme: text(row['治理方案']),
      status: text(row.status),
      startDate: text(row['开工日期']),
      unitName: text(row['承建方']),
    }))
    .filter((project) => project.unitName !== '')
}

// 旧单位档案可能没有注册日期：按首次承建（开工）日期兼容，并标注是推导值。
function resolveRegisterDate(rawDate: string, projects: ProjectRef[]): { date: string; fallback: boolean } {
  if (parseDate(rawDate) !== null) {
    return { date: rawDate, fallback: false }
  }
  const earliest = projects
    .map((project) => project.startDate)
    .filter((date) => parseDate(date) !== null)
    .sort()[0]
  return earliest ? { date: earliest, fallback: true } : { date: '', fallback: true }
}

function loadUnitArchives(projects: ProjectRef[]): UnitArchive[] {
  return listRows('contract').map((row) => {
    const name = text(row['单位名称'])
    const ownProjects = projects.filter((project) => project.unitName === name)
    const registered = resolveRegisterDate(text(row['注册日期']), ownProjects)
    return {
      id: Number(row.id),
      code: text(row['单位编号']),
      name,
      grade: text(row['资质等级']),
      contact: text(row['联系人']),
      phone: text(row['联系电话']),
      registerDate: registered.date,
      registerDateFallback: registered.fallback,
      certExpiry: text(row['资质证书有效期']),
      cooperationStatus: text(row.status),
    }
  })
}

// 一个单位在同一时刻只能落在一个风险等级，按严重程度取最高级，
// 修掉「同一单位重复显示在多个风险等级」的异常。
function classify(
  unit: UnitArchive,
  today: number,
): { level: QualificationRiskLevel; reason: string } | null {
  const expiry = parseDate(unit.certExpiry)
  if (unit.cooperationStatus === '列入黑名单') {
    return { level: '黑名单', reason: '合作记录显示该单位已被列入黑名单' }
  }
  if (unit.cooperationStatus === '暂停合作') {
    return { level: '暂停合作', reason: '合作记录显示该单位已暂停合作' }
  }
  if (expiry === null) {
    return { level: '资质过期', reason: '资质证书有效期缺失或无法核验，视为资质失效' }
  }
  if (expiry < today) {
    return {
      level: '资质过期',
      reason: `资质证书已于 ${unit.certExpiry} 到期，不得再承接项目`,
    }
  }
  const remaining = diffDays(today, expiry)
  if (remaining <= EXPIRE_WARNING_DAYS) {
    return {
      level: '临期',
      reason: `资质证书将于 ${unit.certExpiry} 到期，剩余 ${remaining} 天`,
    }
  }
  return null
}

type Candidate = UnitArchive & { activeCount: number }

// 候选替换单位：合作正常 + 证书不在临期窗口内。暂停、黑名单、过期、临期一律不入选。
function buildCandidates(units: UnitArchive[], projects: ProjectRef[]): Candidate[] {
  const today = todayStart()
  const safeDeadline = today + EXPIRE_WARNING_DAYS * 86_400_000
  return units
    .filter((unit) => {
      if (unit.cooperationStatus !== '正常') {
        return false
      }
      const expiry = parseDate(unit.certExpiry)
      return expiry !== null && expiry > safeDeadline
    })
    .map((unit) => ({
      ...unit,
      activeCount: projects.filter(
        (project) =>
          project.unitName === unit.name && ACTIVE_PROJECT_STATUSES.includes(project.status),
      ).length,
    }))
}

function pickCandidate(candidates: Candidate[], grade: string): Candidate | null {
  const targetRank = GRADE_RANK[grade] ?? 9
  const sorted = [...candidates].sort((a, b) => {
    const rankA = GRADE_RANK[a.grade] ?? 9
    const rankB = GRADE_RANK[b.grade] ?? 9
    // 优先同等级，其次等级更高（数值更小），再比在执行项目余量，最后稳定按编号。
    const sameA = rankA === targetRank ? 0 : 1
    const sameB = rankB === targetRank ? 0 : 1
    if (sameA !== sameB) {
      return sameA - sameB
    }
    if (rankA !== rankB) {
      return rankA - rankB
    }
    if (a.activeCount !== b.activeCount) {
      return a.activeCount - b.activeCount
    }
    return a.id - b.id
  })
  return sorted[0] ?? null
}

function buildSuggestions(
  unit: UnitArchive,
  grade: string,
  projects: ProjectRef[],
  candidates: Candidate[],
): ReplacementSuggestion[] {
  const activeProjects = projects.filter(
    (project) =>
      project.unitName === unit.name && ACTIVE_PROJECT_STATUSES.includes(project.status),
  )
  return activeProjects.map((project) => {
    const candidate = pickCandidate(candidates, grade)
    if (!candidate) {
      return {
        projectId: project.projectId,
        hazardId: project.hazardId,
        scheme: project.scheme,
        projectStatus: project.status,
        startDate: project.startDate,
        suggestUnitId: '',
        suggestUnitName: '',
        suggestGrade: '',
        reason: '档案中暂无可承接替换单位，建议重新组织招标',
      }
    }
    const reason =
      candidate.grade === grade
        ? `与原单位同为${grade}资质，且在执行项目较少，可平稳接替`
        : `${candidate.grade}资质不低于原单位${grade}，且在执行项目较少`
    return {
      projectId: project.projectId,
      hazardId: project.hazardId,
      scheme: project.scheme,
      projectStatus: project.status,
      startDate: project.startDate,
      suggestUnitId: candidate.code,
      suggestUnitName: candidate.name,
      suggestGrade: candidate.grade,
      reason,
    }
  })
}

// 执行一次扫描：结果完全由当前档案现场推导，并整体覆盖唯一一份快照。
// 重复扫描不会叠加旧建议；风险解除后重扫，旧建议随快照一起消失，不会残留。
export function scanQualificationRisk(): QualificationScanResult {
  const today = todayStart()
  const projects = loadProjects()
  const units = loadUnitArchives(projects)
  const candidates = buildCandidates(units, projects)

  const items: QualificationRiskItem[] = []
  for (const unit of units) {
    const verdict = classify(unit, today)
    if (!verdict) {
      continue
    }
    const suggestions = buildSuggestions(unit, unit.grade, projects, candidates)
    const expiry = parseDate(unit.certExpiry)
    const canContract =
      verdict.level === '临期' && expiry !== null && expiry >= today
    items.push({
      unitId: unit.id,
      unitCode: unit.code,
      unitName: unit.name,
      grade: unit.grade,
      contact: unit.contact,
      phone: unit.phone,
      registerDate: unit.registerDate,
      registerDateFallback: unit.registerDateFallback,
      certExpiry: unit.certExpiry,
      cooperationStatus: unit.cooperationStatus,
      level: verdict.level,
      reason: verdict.reason,
      canContract,
      blockReason: canContract ? '' : '资质/合作状态异常，暂停派接新项目',
      relatedActiveProjects: suggestions.length,
      suggestions,
    })
  }

  items.sort((a, b) => {
    if (LEVEL_ORDER[a.level] !== LEVEL_ORDER[b.level]) {
      return LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]
    }
    return a.unitId - b.unitId
  })

  const summary = Object.fromEntries(
    RISK_LEVELS.map((level) => [level, items.filter((item) => item.level === level).length]),
  ) as Record<QualificationRiskLevel, number>

  const result: QualificationScanResult = {
    scannedAt: new Date().toISOString(),
    daysAhead: EXPIRE_WARNING_DAYS,
    items,
    summary,
  }
  writeJson(SNAPSHOT_KEY, result)
  return result
}

// 读取最近一次扫描快照；没有扫过就先扫一次，保证页面永远展示的是档案推导结果。
export function loadQualificationScan(): QualificationScanResult {
  const snapshot = readJson<QualificationScanResult>(SNAPSHOT_KEY)
  if (!snapshot || !Array.isArray(snapshot.items)) {
    return scanQualificationRisk()
  }
  return snapshot
}

// 单位在治理工程档案里的项目履历：承建单位页与治理工程页共用同一份工程档案。
export function unitProjectHistory(unitName: string) {
  return loadProjects().filter((project) => project.unitName === unitName)
}
