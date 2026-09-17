export type Screen =
  | 'login' | 'dashboard-empty' | 'dashboard' | 'create' | 'templates'
  | 'editor' | 'modules' | 'sorting' | 'left-collapsed' | 'right-collapsed' | 'focus'
  | 'ai-loading' | 'ai-compare' | 'jd-input' | 'jd-result'
  | 'diagnosis-idle' | 'diagnosis-loading' | 'diagnosis-result'
  | 'save-error' | 'save-retrying' | 'plans' | 'payment-processing'
  | 'payment-success' | 'payment-failed'

export type Overlay = 'share' | 'export' | 'quota' | null

export const screenImages: Record<Screen, string> = {
  login: '用户登录.png',
  'dashboard-empty': '工作台空状态.png',
  dashboard: '工作台正常状态.png',
  create: '创建简历.png',
  templates: '模板选择.png',
  editor: '编辑器默认状态.png',
  modules: '模块管理状态.png',
  sorting: '模块排序状态.png',
  'left-collapsed': '左侧面板收起.png',
  'right-collapsed': '右侧面板收起.png',
  focus: '左右面板同时收起.png',
  'ai-loading': 'AI优化生成中.png',
  'ai-compare': 'AI修改对比.png',
  'jd-input': 'JD匹配输入.png',
  'jd-result': 'JD匹配结果.png',
  'diagnosis-idle': '简历未诊断.png',
  'diagnosis-loading': '简历诊断中.png',
  'diagnosis-result': '简历诊断结果.png',
  'save-error': '自动保存失败.png',
  'save-retrying': '自动保存重试中.png',
  plans: '会员方案.png',
  'payment-processing': '支付处理中.png',
  'payment-success': '支付成功.png',
  'payment-failed': '支付未完成.png',
}

export type TestEvent = {
  id: string
  at: string
  elapsedMs: number
  screen: Screen
  action: string
  detail?: string
}

export const defaultJd = `职位：前端开发工程师
负责 React + TypeScript Web 产品开发，熟悉组件化、状态管理和性能优化；
具备跨团队协作能力，有自动化测试与工程化实践经验。`

export const initialModules = ['基本信息', '教育背景', '项目经历', '实习经历', '技能与证书', '校园经历']

export function buildExport(events: TestEvent[], sessionId: string, startedAt: string) {
  return {
    schemaVersion: 1,
    product: 'AI 简历平台可用性测试',
    sessionId,
    startedAt,
    exportedAt: new Date().toISOString(),
    eventCount: events.length,
    events,
  }
}
