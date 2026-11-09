window.__ModuleLoader__.load({
  id: "dsh--web-fetch",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require("react")
    const h = React.createElement

    const API = "/api/dsh-web-fetch"

    /** Last state seen by any mounted card; the row summary reads this. */
    let latestState = null

    function get(path) {
      return fetch(`${API}${path}`, { headers: { accept: "application/json" } }).then((r) => r.json())
    }
    function post(path, body) {
      return fetch(`${API}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then((r) => r.json())
    }

    const styles = {
      root: { display: "flex", flexDirection: "column", gap: 14, padding: "4px 0 8px" },
      header: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" },
      title: { fontSize: 14, fontWeight: 600 },
      subtitle: { fontSize: 12, opacity: 0.6 },
      list: { display: "flex", flexDirection: "column", gap: 6, margin: 0, padding: 0, listStyle: "none" },
      row: (dragging, over) => ({
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 10px",
        borderRadius: 8,
        border: `1px solid ${over ? "var(--dsh-accent, #2563eb)" : "rgba(127,127,127,.22)"}`,
        background: dragging ? "rgba(127,127,127,.10)" : "transparent",
        cursor: "grab",
        opacity: dragging ? 0.5 : 1,
      }),
      grip: { opacity: 0.45, fontSize: 15, userSelect: "none", lineHeight: 1 },
      nudge: { display: "flex", flexDirection: "column", gap: 2 },
      nudgeBtn: {
        width: 22, height: 18, lineHeight: "16px", padding: 0, fontSize: 11,
        borderRadius: 4, border: "1px solid #d1d5db", background: "#fff",
        color: "#4b5563", cursor: "pointer",
      },
      idx: { width: 16, textAlign: "right", opacity: 0.45, fontSize: 12, fontVariantNumeric: "tabular-nums" },
      main: { flex: 1, minWidth: 0 },
      name: { fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
      desc: { fontSize: 11.5, opacity: 0.6, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      tag: (tone) => ({
        fontSize: 10.5,
        padding: "1px 6px",
        borderRadius: 999,
        border: `1px solid ${tone === "ok" ? "rgba(5,150,105,.5)" : tone === "bad" ? "rgba(220,38,38,.5)" : "rgba(127,127,127,.3)"}`,
        color: tone === "ok" ? "#059669" : tone === "bad" ? "#dc2626" : "inherit",
        opacity: tone === "muted" ? 0.6 : 1,
        fontWeight: 400,
      }),
      switch: { position: "relative", width: 34, height: 20, flex: "none" },
      switchInput: { position: "absolute", inset: 0, opacity: 0, margin: 0, cursor: "pointer", width: "100%", height: "100%" },
      track: (on) => ({
        position: "absolute",
        inset: 0,
        borderRadius: 999,
        background: on ? "var(--dsh-accent, #2563eb)" : "rgba(127,127,127,.35)",
        transition: "background .16s",
        pointerEvents: "none",
      }),
      knob: (on) => ({
        position: "absolute",
        top: 2,
        left: on ? 16 : 2,
        width: 16,
        height: 16,
        borderRadius: "50%",
        background: "#fff",
        transition: "left .16s",
        pointerEvents: "none",
      }),
      actions: { display: "flex", gap: 8, flexWrap: "wrap" },
      btn: { fontSize: 12, padding: "5px 11px", borderRadius: 7, border: "1px solid rgba(127,127,127,.3)", background: "transparent", color: "inherit", cursor: "pointer" },
      btnPrimary: { fontSize: 12, padding: "5px 11px", borderRadius: 7, border: "1px solid var(--dsh-accent, #2563eb)", background: "var(--dsh-accent, #2563eb)", color: "#fff", cursor: "pointer" },
      panel: { border: "1px solid rgba(127,127,127,.22)", borderRadius: 10, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 },
      panelTitle: { fontSize: 11, letterSpacing: ".05em", textTransform: "uppercase", opacity: 0.55 },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word", opacity: 0.75, margin: 0 },
      dot: (status) => ({
        width: 7,
        height: 7,
        borderRadius: "50%",
        display: "inline-block",
        background: status === "running" ? "#059669" : status === "error" ? "#dc2626" : "#d97706",
      }),
      input: { flex: 1, minWidth: 0, fontSize: 12, padding: "6px 9px", borderRadius: 7, border: "1px solid rgba(127,127,127,.3)", background: "transparent", color: "inherit" },
    }

    function Toggle({ on, onChange }) {
      return h(
        "span",
        { style: styles.switch },
        h("input", { type: "checkbox", checked: on, onChange: (e) => onChange(e.target.checked), style: styles.switchInput }),
        h("span", { style: styles.track(on) }),
        h("span", { style: styles.knob(on) }),
      )
    }

    function WebFetchSettings() {
      const [state, setState] = React.useState(latestState)
      const [error, setError] = React.useState("")
      const [dragId, setDragId] = React.useState(null)
      const [overId, setOverId] = React.useState(null)
      const [testUrl, setTestUrl] = React.useState("https://example.com")
      const [testOut, setTestOut] = React.useState("")
      const [busy, setBusy] = React.useState(false)

      const apply = React.useCallback((s) => {
        if (s && s.error) setError(s.error)
        else { latestState = s; setState(s); setError("") }
      }, [])

      const refresh = React.useCallback(() => {
        get("/state").then(apply).catch((e) => setError(e.message))
      }, [apply])

      React.useEffect(() => { refresh() }, [refresh])

      const move = (from, to) => {
        if (!state || from === to) return
        const order = state.order.slice()
        order.splice(order.indexOf(from), 1)
        order.splice(order.indexOf(to), 0, from)
        setState({ ...state, order })
        post("/order", { order }).then(apply).catch((e) => setError(e.message))
      }

      const nudge = (id, delta) => {
        if (!state) return
        const order = state.order.slice()
        const from = order.indexOf(id)
        const to = from + delta
        if (from < 0 || to < 0 || to >= order.length) return
        order.splice(from, 1)
        order.splice(to, 0, id)
        setState({ ...state, order })
        post("/order", { order }).then(apply).catch((e) => setError(e.message))
      }

      const toggle = (id, enabled) => {
        setBusy(true)
        post("/toggle", { id, enabled }).then(apply).catch((e) => setError(e.message)).finally(() => setBusy(false))
      }

      const crwAction = (action) => {
        setBusy(true)
        post("/crw", { action }).then(apply).catch((e) => setError(e.message)).finally(() => setBusy(false))
      }

      const runTest = () => {
        if (!testUrl.trim()) return
        setTestOut("测试中…")
        post("/test", { url: testUrl.trim() }).then((r) => {
          if (r.error) { setTestOut(`错误：${r.error}`); return }
          setTestOut(
            (r.results || [])
              .map((x) => `${x.ok ? "✓" : "✗"} ${x.id}  ${x.ms}ms  ${x.ok ? x.bytes + "B" : x.error}`)
              .join("\n"),
          )
        }).catch((e) => setTestOut(`错误：${e.message}`))
      }

      if (error && !state) {
        return h("div", { style: styles.root }, h("div", { style: styles.subtitle }, `dsh--web-fetch 读取失败：${error}`))
      }
      if (!state) return h("div", { style: styles.root }, h("div", { style: styles.subtitle }, "读取中…"))

      const crw = state.crw || {}
      const rows = state.order.map((id, i) => {
        const b = (state.backends || []).find((x) => x.id === id)
        if (!b) return null
        return h(
          "li",
          {
            key: id,
            draggable: true,
            onDragStart: (e) => { setDragId(id); e.dataTransfer.effectAllowed = "move" },
            onDragEnd: () => { setDragId(null); setOverId(null) },
            onDragOver: (e) => { e.preventDefault(); setOverId(id) },
            onDragLeave: () => setOverId((cur) => (cur === id ? null : cur)),
            onDrop: (e) => { e.preventDefault(); move(dragId, id); setDragId(null); setOverId(null) },
            style: styles.row(dragId === id, overId === id),
          },
          h("span", { style: styles.grip }, "⠿"),
          h("span", { style: styles.idx }, String(i + 1)),
          h(
            "div",
            { style: styles.main },
            h(
              "div",
              { style: styles.name },
              b.label,
              h("span", { style: styles.tag(b.available ? "ok" : "bad") }, b.available ? "可用" : b.reason || "不可用"),
              b.needsKey ? h("span", { style: styles.tag("muted") }, "需要 Key") : null,
            ),
            h("div", { style: styles.desc }, b.description || ""),
          ),
          h(
            "div",
            { style: styles.nudge },
            h("button", { style: { ...styles.nudgeBtn, opacity: i === 0 ? 0.35 : 1 }, title: "上移", onClick: () => nudge(id, -1) }, "↑"),
            h("button", { style: { ...styles.nudgeBtn, opacity: i === state.order.length - 1 ? 0.35 : 1 }, title: "下移", onClick: () => nudge(id, 1) }, "↓"),
          ),
          h(Toggle, { on: b.enabled, onChange: (v) => toggle(id, v) }),
        )
      })

      return h(
        "div",
        { style: styles.root },
        h(
          "div",
          { style: styles.header },
          h("div", { style: styles.title }, "dsh--web-fetch"),
          h("div", { style: styles.subtitle }, "拖动调整抓取回退顺序，越靠前越先尝试；改动即时保存"),
          h("div", { style: { marginLeft: "auto" } }, h("button", { style: styles.btn, onClick: refresh }, "刷新")),
        ),
        error ? h("div", { style: { fontSize: 12, color: "#dc2626" } }, error) : null,
        h("ul", { style: styles.list }, rows),
        h(
          "div",
          { style: styles.actions },
          h("button", { style: styles.btn, onClick: () => post("/order", { order: ["direct", "jina", "firecrawl", "crw", "exa", "browser", "lightpanda"] }).then(apply) }, "恢复默认顺序"),
          h("button", { style: styles.btn, onClick: () => post("/test", { url: testUrl }).then(() => refresh()) }, "重新检测可用性"),
        ),
        h(
          "div",
          { style: styles.panel },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
            h("span", { style: styles.panelTitle }, "CRW 本地实例"),
            h("span", { style: styles.dot(crw.status) }),
            h("span", { style: { fontSize: 12 } }, `${crw.status || "unknown"} · ${crw.host || "127.0.0.1"}:${crw.port || ""}`),
            h("span", { style: { fontSize: 11, opacity: 0.55 } }, `renderer ${crw.rendererMode || "auto"}${crw.hasBinary ? " · 二进制已就绪" : " · 首次启用会自动下载"}`),
            h(
              "div",
              { style: { marginLeft: "auto", display: "flex", gap: 6 } },
              h("button", { style: styles.btn, disabled: busy, onClick: () => crwAction("start") }, "启动"),
              h("button", { style: styles.btn, disabled: busy, onClick: () => crwAction("stop") }, "停止"),
              h("button", { style: styles.btn, disabled: busy, onClick: () => crwAction("restart") }, "重启"),
            ),
          ),
          crw.lastError ? h("pre", { style: { ...styles.mono, color: "#dc2626" } }, crw.lastError) : null,
        ),
        h(
          "div",
          { style: styles.panel },
          h("div", { style: styles.panelTitle }, "连通性测试"),
          h(
            "div",
            { style: { display: "flex", gap: 8 } },
            h("input", { style: styles.input, value: testUrl, onChange: (e) => setTestUrl(e.target.value), placeholder: "https://example.com" }),
            h("button", { style: styles.btnPrimary, onClick: runTest }, "依次测试"),
          ),
          testOut ? h("pre", { style: styles.mono }, testOut) : null,
        ),
      )
    }

    const inject = ["slots"]

    /** One-line summary shown inside the plugin list row. */
    function rowSummary() {
      const st = latestState
      if (!st) return "抓取后端聚合器"
      const on = (st.order || []).filter((id) => st.enabled[id] !== false).length
      const crw = st.crw && st.crw.status === "running" ? " · CRW 运行中" : ""
      return `${on} 个后端启用${crw}`
    }

    function apply(ctx) {
      // Row card in the plugin list, and the full page in the plugin's own
      // settings tab. Registering both mirrors how official bundles do it.
      ctx.slots.inject("plugins.row.config", () =>
        ctx.slots.register(
          { name: "plugins.row.config", key: "dsh--web-fetch#web-fetch" },
          (slotProps) =>
            slotProps && slotProps.view === "summary" ? rowSummary() : h(WebFetchSettings, { page: true }),
        ),
      )
      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register(
          { name: "plugins.bundle.config", key: "dsh--web-fetch" },
          (slotProps) =>
            slotProps && slotProps.view === "summary" ? rowSummary() : h(WebFetchSettings, { page: true }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.WebFetchSettings = WebFetchSettings
    return module.exports
  },
})
