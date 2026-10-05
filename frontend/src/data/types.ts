/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// 资质风险定位扫描：扫描结果由承建单位 + 治理工程同一份档案现场推导，只落一份快照。
export type QualificationRiskLevel = '黑名单' | '暂停合作' | '资质过期' | '临期'

export type ReplacementSuggestion = {
  projectId: string
  hazardId: string
  scheme: string
  projectStatus: string
  startDate: string
  suggestUnitId: string
  suggestUnitName: string
  suggestGrade: string
  reason: string
}

export type QualificationRiskItem = {
  unitId: number
  unitCode: string
  unitName: string
  grade: string
  contact: string
  phone: string
  registerDate: string
  registerDateFallback: boolean
  certExpiry: string
  cooperationStatus: string
  level: QualificationRiskLevel
  reason: string
  canContract: boolean
  blockReason: string
  relatedActiveProjects: number
  suggestions: ReplacementSuggestion[]
}

export type QualificationScanResult = {
  scannedAt: string
  daysAhead: number
  items: QualificationRiskItem[]
  summary: Record<QualificationRiskLevel, number>
}
