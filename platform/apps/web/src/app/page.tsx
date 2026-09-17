export default function HomePage() {
  return (
    <main className="baseline-shell">
      <section aria-labelledby="baseline-title" className="baseline-panel">
        <p className="eyebrow">V0.1 工程基线</p>
        <h1 id="baseline-title">编辑、保存与预览</h1>
        <p>正式编辑器尚未接入。当前页面只用于确认应用构建、运行和健康检查。</p>
        <a href="/api/health/live">检查应用状态</a>
      </section>
    </main>
  );
}
