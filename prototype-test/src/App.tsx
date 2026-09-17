import { useEffect, useMemo, useRef, useState } from 'react'
import { buildExport, defaultJd, initialModules, Overlay, Screen, screenImages, TestEvent } from './prototype'

const STORAGE_KEY = 'resume-prototype-test-events-v1'
const SESSION_KEY = 'resume-prototype-test-session-v1'

function loadEvents(): TestEvent[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
}

function App() {
  const [screen, setScreen] = useState<Screen>('login')
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [events, setEvents] = useState<TestEvent[]>(loadEvents)
  const [testerOpen, setTesterOpen] = useState(false)
  const [delay, setDelay] = useState(900)
  const [paymentResult, setPaymentResult] = useState<'success' | 'failed'>('success')
  const [email, setEmail] = useState('test@resume.local')
  const [password, setPassword] = useState('Resume123!')
  const [resumeName, setResumeName] = useState('前端开发工程师简历')
  const [jd, setJd] = useState(defaultJd)
  const [modules, setModules] = useState(initialModules)
  const [hiddenModules, setHiddenModules] = useState<string[]>([])
  const [shareEnabled, setShareEnabled] = useState(false)
  const [shareCopied, setShareCopied] = useState(false)
  const [exportReady, setExportReady] = useState(false)
  const [toast, setToast] = useState('')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const startedRef = useRef(Date.now())
  const startedIsoRef = useRef(new Date().toISOString())
  const sessionIdRef = useRef(localStorage.getItem(SESSION_KEY) || crypto.randomUUID())

  useEffect(() => { localStorage.setItem(SESSION_KEY, sessionIdRef.current) }, [])
  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(events)) }, [events])
  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(''), 2200)
    return () => window.clearTimeout(id)
  }, [toast])
  useEffect(() => {
    if (screen !== 'ai-loading' && screen !== 'diagnosis-loading' && screen !== 'save-retrying') return
    const destination: Screen = screen === 'ai-loading' ? 'ai-compare' : screen === 'diagnosis-loading' ? 'diagnosis-result' : 'editor'
    const action = screen === 'ai-loading' ? 'ai_generation_complete' : screen === 'diagnosis-loading' ? 'diagnosis_complete' : 'save_recovered'
    const id = window.setTimeout(() => {
      record(action, `${screen} → ${destination}`, screen)
      setScreen(destination)
    }, delay)
    return () => window.clearTimeout(id)
  // The timer intentionally restarts when the active async screen or configured delay changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, delay])

  const record = (action: string, detail?: string, atScreen = screen) => {
    const event: TestEvent = {
      id: crypto.randomUUID(), at: new Date().toISOString(), elapsedMs: Date.now() - startedRef.current,
      screen: atScreen, action, ...(detail ? { detail } : {}),
    }
    setEvents(previous => [...previous, event])
  }

  const go = (next: Screen, action: string) => {
    record(action, `${screen} → ${next}`)
    setOverlay(null)
    setScreen(next)
  }

  const delayed = (next: Screen, action: string) => {
    record(`${action}_start`, `delay=${delay}ms`)
    window.setTimeout(() => {
      setScreen(next)
      record(`${action}_complete`, `${screen} → ${next}`)
    }, delay)
  }

  const openOverlay = (next: Exclude<Overlay, null>) => {
    record('overlay_open', next)
    setOverlay(next)
  }

  const closeOverlay = () => {
    if (overlay) record('overlay_close', overlay)
    setOverlay(null)
  }

  const downloadLog = () => {
    record('test_log_exported', `events=${events.length + 1}`)
    const payload = buildExport([...events, {
      id: crypto.randomUUID(), at: new Date().toISOString(), elapsedMs: Date.now() - startedRef.current,
      screen, action: 'test_log_exported', detail: `events=${events.length + 1}`,
    }], sessionIdRef.current, startedIsoRef.current)
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `resume-test-${sessionIdRef.current.slice(0, 8)}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const resetSession = () => {
    const ok = window.confirm('清空本次测试记录并回到登录页？')
    if (!ok) return
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(SESSION_KEY)
    sessionIdRef.current = crypto.randomUUID()
    startedRef.current = Date.now()
    startedIsoRef.current = new Date().toISOString()
    setEvents([]); setOverlay(null); setScreen('login'); setModules(initialModules); setHiddenModules([])
    setShareEnabled(false); setExportReady(false); setToast('测试已重置')
  }

  const moveModule = (from: number, to: number, source = 'button') => {
    if (to < 0 || to >= modules.length || from === to) return
    setModules(current => {
      const next = [...current]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      record('module_reordered', `${item}: ${from + 1}→${to + 1}; via=${source}`)
      return next
    })
  }

  const image = useMemo(() => `/prototypes/${encodeURIComponent(screenImages[screen])}`, [screen])

  return (
    <main className="app-shell">
      <div className="prototype-stage" data-screen={screen}>
        <img className="prototype-image" src={image} alt={`${screenImages[screen].replace('.png', '')}原型画面`} />
        <ScreenControls
          {...{ screen, email, password, resumeName, jd, modules, hiddenModules, delay, paymentResult }}
          setEmail={value => { setEmail(value); record('field_changed', 'email') }}
          setPassword={value => { setPassword(value); record('field_changed', 'password') }}
          setResumeName={value => { setResumeName(value); record('field_changed', 'resume_name') }}
          setJd={value => { setJd(value); record('field_changed', `jd_chars=${value.length}`) }}
          onGo={go} onDelayed={delayed} onOverlay={openOverlay}
          onToggleModule={name => {
            setHiddenModules(current => current.includes(name) ? current.filter(item => item !== name) : [...current, name])
            record('module_visibility_toggled', name)
          }}
          onMove={moveModule} dragIndex={dragIndex} setDragIndex={setDragIndex}
          onAiDecision={decision => { record('ai_decision', decision); setToast(decision === 'accept' ? '已应用建议并创建版本' : '已保留原文'); setScreen('editor') }}
          onPayment={() => delayed(paymentResult === 'success' ? 'payment-success' : 'payment-failed', 'payment')}
        />
        {overlay && <RealOverlay
          type={overlay} shareEnabled={shareEnabled} shareCopied={shareCopied} exportReady={exportReady}
          delay={delay} onClose={closeOverlay}
          onShare={() => { setShareEnabled(true); record('share_link_created') }}
          onCopy={() => { setShareCopied(true); record('share_link_copied'); setToast('分享链接已复制') }}
          onExport={() => {
            record('pdf_export_start', `delay=${delay}ms`)
            window.setTimeout(() => { setExportReady(true); record('pdf_export_ready'); setToast('PDF 已生成（模拟）') }, delay)
          }}
          onPlans={() => go('plans', 'quota_view_plans')}
        />}
        {toast && <div className="toast" role="status">{toast}</div>}
      </div>

      <aside className={`tester-panel ${testerOpen ? 'open' : ''}`} aria-label="可用性测试工具">
        <button className="tester-toggle" onClick={() => setTesterOpen(value => !value)} aria-expanded={testerOpen}>
          {testerOpen ? '×' : '测试工具'}
        </button>
        {testerOpen && <div className="tester-content">
          <div className="tester-heading"><strong>测试工具</strong><span>{events.length} 条记录</span></div>
          <label>模拟延迟
            <select value={delay} onChange={event => setDelay(Number(event.target.value))}>
              <option value={350}>快速 · 0.35 秒</option><option value={900}>标准 · 0.9 秒</option><option value={1800}>慢速 · 1.8 秒</option>
            </select>
          </label>
          <label>支付结果
            <select value={paymentResult} onChange={event => setPaymentResult(event.target.value as 'success' | 'failed')}>
              <option value="success">支付成功</option><option value="failed">支付未完成</option>
            </select>
          </label>
          <div className="tester-actions">
            <button onClick={() => openOverlay('quota')}>模拟额度不足</button>
            <button onClick={() => go('save-error', 'simulate_save_error')}>模拟保存失败</button>
            <button onClick={downloadLog}>导出测试 JSON</button>
            <button onClick={resetSession}>重置测试</button>
          </div>
          <details><summary>流程跳转</summary><div className="jump-grid">
            {([['登录','login'],['工作台','dashboard'],['编辑器','editor'],['AI','ai-loading'],['JD','jd-input'],['诊断','diagnosis-idle'],['会员','plans']] as [string, Screen][]).map(([label, target]) =>
              <button key={target} onClick={() => go(target, 'tester_jump')}>{label}</button>)}
          </div></details>
          <p>账号：test@resume.local<br />密码：Resume123!</p>
        </div>}
      </aside>
    </main>
  )
}

type ControlsProps = {
  screen: Screen; email: string; password: string; resumeName: string; jd: string; modules: string[]; hiddenModules: string[]
  delay: number; paymentResult: 'success' | 'failed'; dragIndex: number | null
  setEmail: (value: string) => void; setPassword: (value: string) => void; setResumeName: (value: string) => void
  setJd: (value: string) => void; setDragIndex: (index: number | null) => void
  onGo: (screen: Screen, action: string) => void; onDelayed: (screen: Screen, action: string) => void
  onOverlay: (overlay: Exclude<Overlay, null>) => void; onToggleModule: (name: string) => void
  onMove: (from: number, to: number, source?: string) => void; onAiDecision: (decision: 'accept' | 'reject') => void; onPayment: () => void
}

function ScreenControls(props: ControlsProps) {
  const { screen, onGo, onDelayed, onOverlay } = props
  if (screen === 'login') return <div className="real-form login-form">
    <label>邮箱<input value={props.email} onChange={e => props.setEmail(e.target.value)} autoComplete="email" /></label>
    <label>密码<input type="password" value={props.password} onChange={e => props.setPassword(e.target.value)} autoComplete="current-password" /></label>
    <button className="primary" aria-label="提交登录" onClick={() => onGo('dashboard-empty', 'login_submitted')}>登录</button>
  </div>

  if (screen === 'dashboard-empty' || screen === 'dashboard') return <>
    <Hotspot label="新建简历" className="dashboard-create" onClick={() => onGo('create', 'create_resume_opened')} />
    {screen === 'dashboard' && <Hotspot label="打开前端开发工程师简历" className="dashboard-card" onClick={() => onGo('editor', 'resume_opened')} />}
  </>

  if (screen === 'create') return <div className="real-form create-form">
    <label>简历名称<input value={props.resumeName} onChange={e => props.setResumeName(e.target.value)} /></label>
    <label>求职方向<input defaultValue="前端开发工程师" /></label>
    <div className="form-row"><button onClick={() => onGo('dashboard-empty', 'create_cancelled')}>取消</button><button className="primary" onClick={() => onGo('templates', 'template_picker_opened')}>下一步，选择模板</button></div>
  </div>

  if (screen === 'templates') return <>
    <Hotspot label="返回创建简历" className="template-back" onClick={() => onGo('create', 'template_back')} />
    <Hotspot label="选择 ATS 单栏模板并进入编辑器" className="template-first" onClick={() => onGo('editor', 'template_selected')} />
  </>

  if (screen === 'editor') return <>
    <Hotspot label="返回工作台" className="editor-back" onClick={() => onGo('dashboard', 'editor_back')} />
    <Hotspot label="打开分享" className="editor-share" onClick={() => onOverlay('share')} />
    <Hotspot label="导出 PDF" className="editor-export" onClick={() => onOverlay('export')} />
    <Hotspot label="收起左侧面板" className="collapse-left" onClick={() => onGo('left-collapsed', 'left_panel_collapsed')} />
    <Hotspot label="收起右侧面板" className="collapse-right" onClick={() => onGo('right-collapsed', 'right_panel_collapsed')} />
    <Hotspot label="模块管理" className="module-manage" onClick={() => onGo('modules', 'module_manager_opened')} />
    <Hotspot label="AI 优化" className="tool-ai" onClick={() => onGo('ai-loading', 'ai_requested')} />
    <Hotspot label="JD 匹配" className="tool-jd" onClick={() => onGo('jd-input', 'jd_opened')} />
    <Hotspot label="简历诊断" className="tool-diagnosis" onClick={() => onGo('diagnosis-idle', 'diagnosis_opened')} />
  </>

  if (screen === 'modules') return <div className="module-control real-surface">
    <div className="surface-title"><strong>模块管理</strong><button onClick={() => onGo('editor', 'module_manager_closed')}>完成</button></div>
    {props.modules.map(name => <label key={name} className="toggle-row"><span>{name}</span><input type="checkbox" checked={!props.hiddenModules.includes(name)} onChange={() => props.onToggleModule(name)} /><span className="switch" /></label>)}
    <button className="wide-button" onClick={() => onGo('sorting', 'module_sort_opened')}>调整模块顺序</button>
  </div>

  if (screen === 'sorting') return <div className="sort-control real-surface">
    <div className="surface-title"><strong>模块排序</strong><button onClick={() => onGo('editor', 'module_sort_saved')}>保存</button></div>
    <p>拖动模块，或使用上下按钮调整顺序。</p>
    <ul>{props.modules.map((name, index) => <li key={name} draggable
      onDragStart={() => props.setDragIndex(index)} onDragOver={e => e.preventDefault()}
      onDrop={() => { if (props.dragIndex !== null) props.onMove(props.dragIndex, index, 'drag'); props.setDragIndex(null) }}>
      <span className="drag" aria-hidden="true">⠿</span><span>{name}</span>
      <span className="sort-buttons"><button aria-label={`上移${name}`} disabled={index === 0} onClick={() => props.onMove(index, index - 1)}>↑</button><button aria-label={`下移${name}`} disabled={index === props.modules.length - 1} onClick={() => props.onMove(index, index + 1)}>↓</button></span>
    </li>)}</ul>
  </div>

  if (screen === 'left-collapsed') return <><Hotspot label="展开左侧面板" className="expand-left" onClick={() => onGo('editor', 'left_panel_expanded')} /><Hotspot label="同时收起右侧面板" className="collapse-right" onClick={() => onGo('focus', 'focus_mode_opened')} /></>
  if (screen === 'right-collapsed') return <><Hotspot label="展开右侧面板" className="expand-right" onClick={() => onGo('editor', 'right_panel_expanded')} /><Hotspot label="同时收起左侧面板" className="collapse-left" onClick={() => onGo('focus', 'focus_mode_opened')} /></>
  if (screen === 'focus') return <><Hotspot label="展开左侧面板" className="expand-left" onClick={() => onGo('right-collapsed', 'left_panel_expanded')} /><Hotspot label="展开右侧面板" className="expand-right" onClick={() => onGo('left-collapsed', 'right_panel_expanded')} /></>

  if (screen === 'ai-loading') return <Hotspot label="取消 AI 生成" className="ai-cancel" onClick={() => onGo('editor', 'ai_cancelled')} />
  if (screen === 'ai-compare') return <div className="compare-actions"><button onClick={() => props.onAiDecision('reject')}>拒绝，保留原文</button><button onClick={() => onDelayed('ai-compare', 'ai_regenerate')}>重新生成</button><button className="primary" onClick={() => props.onAiDecision('accept')}>接受建议</button></div>

  if (screen === 'jd-input') return <div className="jd-control real-surface">
    <label>目标岗位 JD<textarea value={props.jd} onChange={e => props.setJd(e.target.value)} /></label>
    <div className="form-row"><button onClick={() => onGo('editor', 'jd_closed')}>返回</button><button className="primary" disabled={props.jd.trim().length < 20} onClick={() => onDelayed('jd-result', 'jd_analysis')}>开始匹配</button></div>
  </div>
  if (screen === 'jd-result') return <><Hotspot label="返回 JD 输入" className="jd-back" onClick={() => onGo('jd-input', 'jd_result_back')} /><Hotspot label="定位修改项目经历" className="jd-locate" onClick={() => onGo('editor', 'jd_suggestion_located')} /></>

  if (screen === 'diagnosis-idle') return <><Hotspot label="返回编辑器" className="diagnosis-back" onClick={() => onGo('editor', 'diagnosis_closed')} /><Hotspot label="开始诊断" className="diagnosis-start" onClick={() => onGo('diagnosis-loading', 'diagnosis_started')} /></>
  if (screen === 'diagnosis-loading') return <Hotspot label="取消诊断" className="diagnosis-cancel" onClick={() => onGo('diagnosis-idle', 'diagnosis_cancelled')} />
  if (screen === 'diagnosis-result') return <Hotspot label="定位并修改问题" className="diagnosis-fix" onClick={() => onGo('editor', 'diagnosis_issue_located')} />

  if (screen === 'save-error') return <Hotspot label="重试保存" className="save-retry" onClick={() => onGo('save-retrying', 'save_retry')} />
  if (screen === 'save-retrying') return <Hotspot label="返回编辑器" className="save-done" onClick={() => onGo('editor', 'save_recovered')} />

  if (screen === 'plans') return <><Hotspot label="返回编辑器" className="plans-back" onClick={() => onGo('editor', 'plans_closed')} /><Hotspot label="选择专业版" className="plan-buy" onClick={() => onGo('payment-processing', 'plan_selected')} /></>
  if (screen === 'payment-processing') return <div className="payment-sim"><p>测试支付不会产生真实扣款</p><button className="primary" onClick={props.onPayment}>确认模拟支付</button></div>
  if (screen === 'payment-success') return <Hotspot label="返回继续优化简历" className="payment-return" onClick={() => onGo('editor', 'payment_success_return')} />
  if (screen === 'payment-failed') return <><Hotspot label="重新支付" className="payment-retry" onClick={() => onGo('payment-processing', 'payment_retry')} /><Hotspot label="选择其他套餐" className="payment-plans" onClick={() => onGo('plans', 'payment_change_plan')} /></>
  return null
}

function Hotspot({ label, className, onClick }: { label: string; className: string; onClick: () => void }) {
  return <button className={`hotspot ${className}`} onClick={onClick} aria-label={label}><span>{label}</span></button>
}

type OverlayProps = {
  type: Exclude<Overlay, null>; shareEnabled: boolean; shareCopied: boolean; exportReady: boolean; delay: number
  onClose: () => void; onShare: () => void; onCopy: () => void; onExport: () => void; onPlans: () => void
}

function RealOverlay(props: OverlayProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') props.onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [props])
  return <div className="overlay-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) props.onClose() }}>
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      <button className="dialog-close" onClick={props.onClose} aria-label="关闭弹窗">×</button>
      {props.type === 'share' && <>
        <div className="dialog-kicker">分享设置</div><h2 id="dialog-title">通过链接分享简历</h2>
        <p>仅获得链接的人可以查看。测试链接不会上传任何数据。</p>
        <label className="toggle-row overlay-toggle"><span>开启链接访问</span><input type="checkbox" checked={props.shareEnabled} onChange={props.onShare} /><span className="switch" /></label>
        <div className="copy-row"><input readOnly value={props.shareEnabled ? 'https://resume.test/s/rsm-demo-2026' : '开启后生成链接'} /><button disabled={!props.shareEnabled} onClick={props.onCopy}>{props.shareCopied ? '已复制' : '复制'}</button></div>
      </>}
      {props.type === 'export' && <>
        <div className="dialog-kicker">PDF 导出</div><h2 id="dialog-title">导出当前简历</h2>
        <div className="export-preview"><span>PDF</span><div><strong>前端开发工程师简历</strong><small>A4 · ATS 单栏 · 2 页</small></div></div>
        <p>生成过程仅为模拟，不会下载真实简历文件。</p>
        <button className="primary wide-button" onClick={props.onExport}>{props.exportReady ? '重新生成 PDF' : `生成 PDF（约 ${props.delay / 1000} 秒）`}</button>
        {props.exportReady && <div className="success-note" role="status">✓ PDF 已生成，可下载（测试状态）</div>}
      </>}
      {props.type === 'quota' && <>
        <div className="quota-icon">0</div><h2 id="dialog-title">本月 AI 额度已用完</h2>
        <p>原文与当前输入已保留。升级后可继续本次优化，本测试不会产生真实支付。</p>
        <div className="dialog-actions"><button onClick={props.onClose}>稍后再说</button><button className="primary" onClick={props.onPlans}>查看会员方案</button></div>
      </>}
    </section>
  </div>
}

export default App
