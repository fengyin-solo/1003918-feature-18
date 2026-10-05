import { listRows } from './local-store'

// 单位档案是承建单位页与治理工程页共用的唯一数据源：
// 扫描、承接资格、承建方风险都从这里派生，避免各页面各算一份对不上。

export const CONTRACT_KEY = 'contract'
export const ENGINEERING_KEY = 'engineering'

// 资质证书到期前 30 天进入「临期」观察窗。
export const CERT_WARNING_DAYS = 30

// 风险等级按严重程度排序；一个单位命中多个条件时只归入最严重的一档，
// 不能在扫描结果里重复出现多次（修复「同一单位重复显示在多个风险等级」）。
export const RISK_LEVELS = ['黑名单', '暂停合作', '资质过期', '证书临期'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

export type ProjectProfile = {
  projectId: string
  hazardId: string
  plan: string
  contractorName: string
  amount: number
  startDate: string
  duration: string
  status: string
  // 已竣工、待验收属于历史履历，不再需要替换承建方。
  active: boolean
}

export type UnitProfile = {
  id: number
  code: string
  name: string
  qualification: string
  contact: string
  phone: string
  registerDate: string
  registerDateFallback: boolean
  certExpiry: string | null
  status: string
  projects: ProjectProfile[]
  projectCount: number
  certState: '有效' | '临期' | '过期' | '未登记'
  // 统一的承接资格：证书过期或合作状态异常的单位一律不可承接
  // （修复「过期证书仍显示成可承接」）。
  eligible: boolean
  riskLevel: RiskLevel | null
  riskReasons: string[]
}

// 合同金额、承建项目数等数值字段种子里偶尔写成文本，这里统一兜底成数字。
function toNumber(value: unknown, fallback = 0): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

// 只接受 YYYY-MM-DD 这类真实日期，种子里的占位文本（「xxx样例」）一律视为缺日期。
function parseDate(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const text = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null
  }
  const time = new Date(`${text}T00:00:00`).getTime()
  return Number.isNaN(time) ? null : text
}

function diffDays(dateText: string, today: Date): number {
  const target = new Date(`${dateText}T00:00:00`).getTime()
  const base = new Date(
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate(),
    ).padStart(2, '0')}T00:00:00`,
  ).getTime()
  return Math.round((target - base) / 86400000)
}

const ACTIVE_PROJECT_STATUSES = ['待立项', '招标中', '施工中']

// 从治理工程台账取关联履历：承建方按单位名称挂接到单位档案，
// 两个页面共用 engineering 这一份数据，任一侧改动扫描都能看到。
function buildProjects(): Map<string, ProjectProfile[]> {
  const grouped = new Map<string, ProjectProfile[]>()
  for (const row of listRows(ENGINEERING_KEY)) {
    const name = String(row['承建方'] ?? '').trim()
    if (!name) {
      continue
    }
    const project: ProjectProfile = {
      projectId: String(row['项目编号'] ?? ''),
      hazardId: String(row['隐患点编号'] ?? ''),
      plan: String(row['治理方案'] ?? ''),
      contractorName: name,
      amount: toNumber(row['合同金额']),
      startDate: parseDate(row['开工日期']) ?? '',
      duration: String(row['计划工期'] ?? ''),
      status: String(row.status ?? ''),
      active: ACTIVE_PROJECT_STATUSES.includes(String(row.status ?? '')),
    }
    const list = grouped.get(name) ?? []
    list.push(project)
    grouped.set(name, list)
  }
  return grouped
}

function certStateOf(expiry: string | null, today: Date): UnitProfile['certState'] {
  if (!expiry) {
    return '未登记'
  }
  const days = diffDays(expiry, today)
  if (days < 0) {
    return '过期'
  }
  if (days <= CERT_WARNING_DAYS) {
    return '临期'
  }
  return '有效'
}

// 风险只归入最严重的一档，命中的其它条件保留在 reasons 里说明，
// 保证一个单位在扫描结果里只出现一行。
function riskOf(
  status: string,
  cert: UnitProfile['certState'],
): Pick<UnitProfile, 'riskLevel' | 'riskReasons'> {
  const reasons: string[] = []
  if (cert === '过期') {
    reasons.push('资质证书已过期')
  } else if (cert === '临期') {
    reasons.push(`资质证书 ${CERT_WARNING_DAYS} 天内到期`)
  }
  if (status === '暂停合作') {
    reasons.push('合作记录：已暂停合作')
  }
  if (status === '列入黑名单') {
    reasons.push('合作记录：已列入黑名单')
  }
  let level: RiskLevel | null = null
  if (status === '列入黑名单') {
    level = '黑名单'
  } else if (status === '暂停合作') {
    level = '暂停合作'
  } else if (cert === '过期') {
    level = '资质过期'
  } else if (cert === '临期') {
    level = '证书临期'
  }
  return { riskLevel: level, riskReasons: reasons }
}

// 构建全量单位档案。每次调用都从当前数据现场派生，
// 所以单位状态、证书日期或治理工程承建方一变，档案立刻跟着变。
export function buildUnitProfiles(today: Date = new Date()): UnitProfile[] {
  const projectsByName = buildProjects()
  const profiles: UnitProfile[] = []

  for (const row of listRows(CONTRACT_KEY)) {
    const name = String(row['单位名称'] ?? '').trim()
    const projects = name ? projectsByName.get(name) ?? [] : []

    // 旧单位可能没有注册日期：按首次承建日期（最早开工日期）兼容，
    // 实在没有履历时再退到证书有效期，保证扫描不会因缺字段漏掉单位。
    const declaredRegisterDate = parseDate(row['注册日期'])
    const firstProjectDate = projects
      .map((item) => item.startDate)
      .filter(Boolean)
      .sort()[0]
    const certExpiry = parseDate(row['证书有效期'])
    let registerDate = declaredRegisterDate ?? firstProjectDate ?? certExpiry ?? ''
    let registerDateFallback = false
    if (!declaredRegisterDate && registerDate) {
      registerDateFallback = true
    }

    const status = String(row.status ?? '')
    const certState = certStateOf(certExpiry, today)
    const risk = riskOf(status, certState)
    // 已注销单位退出合作，不再参与承接与风险扫描。
    const eligible =
      status !== '已注销' && status !== '列入黑名单' && status !== '暂停合作' &&
      certState !== '过期' && certState !== '未登记'

    profiles.push({
      id: Number(row.id),
      code: String(row['单位编号'] ?? ''),
      name,
      qualification: String(row['资质等级'] ?? ''),
      contact: String(row['联系人'] ?? ''),
      phone: String(row['联系电话'] ?? ''),
      registerDate,
      registerDateFallback,
      certExpiry,
      status,
      projects: projects.sort((a, b) =>
        (a.startDate || '').localeCompare(b.startDate || '') || a.projectId.localeCompare(b.projectId),
      ),
      projectCount: projects.length,
      certState,
      eligible,
      riskLevel: risk.riskLevel,
      riskReasons: risk.riskReasons,
    })
  }

  return profiles.sort((a, b) => a.code.localeCompare(b.code))
}

export function getUnitProfile(id: number, today: Date = new Date()): UnitProfile | undefined {
  return buildUnitProfiles(today).find((unit) => unit.id === id)
}

// 替换建议候选：自身无风险、当前可承接的单位。
// 优先做过同隐患点治理工程的单位（履历匹配），再按单位编号取稳定顺序，
// 保证建议是确定性的——同一份档案反复扫描结果一致，不会刷新就变。
export function replacementCandidates(
  profiles: UnitProfile[],
  target: UnitProfile,
): UnitProfile[] {
  return profiles
    .filter((unit) => unit.id !== target.id && unit.riskLevel === null && unit.eligible)
    .map((unit) => {
      const matched = unit.projects.some(
        (project) => project.active && project.hazardId && project.hazardId === firstHazardId(target),
      )
      return { unit, matched }
    })
    .sort((a, b) => {
      if (a.matched !== b.matched) {
        return a.matched ? -1 : 1
      }
      // 同隐患点履历之外，再让承建项目多、编号靠前的单位优先。
      if (b.unit.projectCount !== a.unit.projectCount) {
        return b.unit.projectCount - a.unit.projectCount
      }
      return a.unit.code.localeCompare(b.unit.code)
    })
    .map((item) => item.unit)
}

function firstHazardId(unit: UnitProfile): string {
  return unit.projects.find((project) => project.active)?.hazardId ?? ''
}
