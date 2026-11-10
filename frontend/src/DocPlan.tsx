/** Вкладка «Доска»: DocPlan на том же origin, сессия reporting через X-Session-Id. */

export default function DocPlan() {
  return (
    <div className="docplan-embed">
      <iframe
        className="docplan-embed-frame"
        title="Доска"
        src="/docplan/index.html?embed=1"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  )
}
