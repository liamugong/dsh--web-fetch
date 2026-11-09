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
      const [keyDrafts, setKeyDrafts] = React.useState({})
      const [keyMsg, setKeyMsg] = React.useState("")
      const [browserPath, setBrowserPath] = React.useState("")
      const [browserMsg, setBrowserMsg] = React.useState("")
      const [perfMsg, setPerfMsg] = React.useState("")
      const [ruleDraft, setRuleDraft] = React.useState({ domain: "", backend: "direct" })
      const [ruleMsg, setRuleMsg] = React.useState("")

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

      React.useEffect(() => {
        if (state?.browser) setBrowserPath(state.browser.path || "")
      }, [state?.browser?.path])

      const saveRules = (rules) => {
        setRuleMsg("")
        return post("/rules", { rules })
          .then((res) => {
            if (res && res.error) throw new Error(res.error)
            return apply(res)
          })
          .catch((e) => setRuleMsg(e.message))
      }

      const addRule = () => {
        const domain = String(ruleDraft.domain || "").trim()
        if (!domain) { setRuleMsg("请先填域名"); return }
        const next = [...(state.rules || []), { domain, backend: ruleDraft.backend, enabled: true, note: "" }]
        saveRules(next).then(() => setRuleDraft({ domain: "", backend: "direct" }))
      }

      const saveKey = (id) => {
        const value = keyDrafts[id] || ""
        setKeyMsg("")
        post("/keys", { id, value })
          .then((res) => {
            if (res && res.error) throw new Error(res.error)
            setKeyMsg(value ? "已保存" : "已清除")
            setKeyDrafts((d) => ({ ...d, [id]: "" }))
            refresh()
          })
          .catch((e) => setKeyMsg(e.message))
      }

      const savePerf = (patch) => {
        setPerfMsg("保存中…")
        post("/config", patch)
          .then((res) => {
            if (res && res.error) throw new Error(res.error)
            setPerfMsg("已保存")
            apply(res)
          })
          .catch((e) => setPerfMsg(e.message))
      }

      const perfAction = (action) => {
        setPerfMsg("处理中…")
        post("/cache", { action })
          .then((res) => {
            if (res && res.error) throw new Error(res.error)
            setPerfMsg(action === "clear" ? "缓存已清空" : action === "clear-affinity" ? "域名亲和记录已清空" : "缓存与亲和记录已清空")
            apply(res)
          })
          .catch((e) => setPerfMsg(e.message))
      }

      const browserAction = (action) => {
        setBrowserMsg("处理中…")
        post("/browser", { action, url: "https://example.com" })
          .then((res) => {
            if (res && res.error) throw new Error(res.error)
            if (action === "download") setBrowserMsg(`已下载：${res.detected?.path || ""}`)
            else if (action === "test") setBrowserMsg(`OK ${res.ms}ms · ${res.bytes}B · ${res.engine}`)
            else setBrowserMsg(res.detected ? `检测到 ${res.detected.engine}：${res.detected.path}` : "未检测到可用浏览器")
            refresh()
          })
          .catch((e) => setBrowserMsg(e.message))
      }

      const saveBrowserPath = () => {
        setBrowserMsg("保存中…")
        post("/config", { browserPath })
          .then((res) => {
            if (res && res.error) throw new Error(res.error)
            setBrowserMsg("已保存")
            apply(res)
          })
          .catch((e) => setBrowserMsg(e.message))
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
      const perf = state.perf || {}
      const pCache = perf.cache || {}
      const pAff = perf.affinity || {}
      const pHedge = perf.hedge || {}
      const pStats = perf.stats || {}
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
          h("div", { style: styles.panelTitle }, "站点规则 · 命中即锁定"),
          h(
            "div",
            { style: { fontSize: 11, opacity: 0.6, marginBottom: 6 } },
            "按域名后缀匹配（子域自动命中，越具体越优先）。命中规则的站点只走指定后端，失败直接报错，不回退通用链。",
          ),
          ...((state.rules || []).map((r, i) =>
            h(
              "div",
              { key: `${r.domain}-${i}`, style: { display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" } },
              h("span", { style: { fontSize: 12, minWidth: 170, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" } }, r.domain),
              h("span", { style: { fontSize: 11, opacity: 0.5 } }, "→"),
              h(
                "select",
                {
                  style: { ...styles.input, minWidth: 140 },
                  value: r.backend,
                  onChange: (e) => saveRules((state.rules || []).map((x, j) => (j === i ? { ...x, backend: e.target.value } : x))),
                },
                ...(state.backends || []).map((b) => h("option", { key: b.id, value: b.id }, b.label)),
              ),
              h("span", { style: { fontSize: 11, opacity: 0.55, flex: 1, minWidth: 180 } }, r.note || ""),
              h(Toggle, {
                on: r.enabled !== false,
                onChange: (v) => saveRules((state.rules || []).map((x, j) => (j === i ? { ...x, enabled: v } : x))),
              }),
              h("button", { style: styles.btn, onClick: () => saveRules((state.rules || []).filter((_, j) => j !== i)) }, "删除"),
            ),
          )),
          h(
            "div",
            { style: { display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" } },
            h("input", {
              style: { ...styles.input, flex: 1, minWidth: 200 },
              placeholder: "域名，如 xiaohongshu.com",
              value: ruleDraft.domain,
              onChange: (e) => setRuleDraft((d) => ({ ...d, domain: e.target.value })),
            }),
            h(
              "select",
              { style: { ...styles.input, minWidth: 140 }, value: ruleDraft.backend, onChange: (e) => setRuleDraft((d) => ({ ...d, backend: e.target.value })) },
              ...(state.backends || []).map((b) => h("option", { key: b.id, value: b.id }, b.label)),
            ),
            h("button", { style: styles.btnPrimary, onClick: addRule }, "添加规则"),
            h("button", { style: styles.btn, onClick: () => post("/rules", { action: "reset" }).then(apply) }, "恢复默认"),
          ),
          ruleMsg ? h("div", { style: { fontSize: 11, marginTop: 6, opacity: 0.7 } }, ruleMsg) : null,
        ),
        h(
          "div",
          { style: styles.panel },
          h("div", { style: styles.panelTitle }, "接口密钥"),
          h("div", { style: { fontSize: 11, opacity: 0.6, marginBottom: 6 } }, "留空则自动复用 DSH 凭据里的同名 Key；这里保存的 Key 优先。"),
          ...[
            ["firecrawl", "firecrawl", "FIRECRAWL_API_KEY"],
            ["exa", "Exa Contents", "EXA_API_KEY"],
            ["jina", "Jina Reader（可选）", "JINA_API_KEY"],
            ["zhihu", "知乎开放平台", "ZHIHU_API_KEY"],
            ["xiaohongshu", "小红书 Cookie", "document.cookie"],
          ].map(([id, label, env]) => {
            const info = (state.keys && state.keys[id]) || {}
            const badge = info.source === "plugin" ? "插件内已保存" : info.source === "external" ? "来自 DSH 凭据" : "未配置"
            const tone = info.configured ? (info.source === "plugin" ? "ok" : "muted") : "bad"
            return h(
              "div",
              { key: id, style: { display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" } },
              h("span", { style: { width: 150, fontSize: 12 } }, label),
              h("span", { style: styles.tag(tone) }, badge),
              h("span", { style: { fontSize: 11, opacity: 0.5, minWidth: 70 } }, info.mask || env),
              h("input", {
                style: { ...styles.input, flex: 1, minWidth: 160 },
                type: "password",
                value: keyDrafts[id] || "",
                placeholder: info.configured ? "已配置，输入新值可覆盖" : `粘贴 ${env}`,
                onChange: (e) => setKeyDrafts((d) => ({ ...d, [id]: e.target.value })),
              }),
              h("button", { style: styles.btn, onClick: () => saveKey(id) }, "保存"),
              h("button", { style: styles.btn, onClick: () => { setKeyDrafts((d) => ({ ...d, [id]: "" })); post("/keys", { id, value: "" }).then(refresh) } }, "清除"),
            )
          }),
          keyMsg ? h("div", { style: { fontSize: 11, marginTop: 6, opacity: 0.7 } }, keyMsg) : null,
        ),
        h(
          "div",
          { style: styles.panel },
          h("div", { style: styles.panelTitle }, "浏览器引擎"),
          h("div", { style: { fontSize: 11, opacity: 0.6, marginBottom: 6 } }, "默认用 Obscura（Rust 自渲染，无需 Chromium）；也可以填本机 Chromium/Chrome 路径走 --dump-dom。"),
          h(
            "div",
            { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
            h("input", {
              style: { ...styles.input, flex: 1, minWidth: 240 },
              value: browserPath,
              placeholder: "留空 = 自动检测（优先 Obscura）",
              onChange: (e) => setBrowserPath(e.target.value),
            }),
            h("button", { style: styles.btnPrimary, onClick: saveBrowserPath }, "保存路径"),
            h("button", { style: styles.btn, onClick: () => browserAction("detect") }, "自动检测"),
            h("button", { style: styles.btn, onClick: () => browserAction("download") }, "下载 Obscura"),
            h("button", { style: styles.btn, onClick: () => browserAction("test") }, "测试抓取"),
          ),
          h(
            "div",
            { style: { fontSize: 11, opacity: 0.65, marginTop: 6 } },
            `当前：${(state.browser && state.browser.detected && `${state.browser.detected.engine} · ${state.browser.detected.path}`) || "未检测到"}`
            + (state.browser && state.browser.obscura && state.browser.obscura.version ? ` · v${state.browser.obscura.version}` : ""),
          ),
          browserMsg ? h("div", { style: { fontSize: 11, marginTop: 4, opacity: 0.8 } }, browserMsg) : null,
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
          h("div", { style: styles.panelTitle }, "性能与缓存"),
          h("div", { style: { fontSize: 11, opacity: 0.6 } },
            `本次会话：${pStats.requests || 0} 次请求 · 缓存命中 ${pStats.cacheHits || 0} 次 · 缓存条目 ${pCache.entries || 0}`),
          h(
            "div",
            { style: { display: "flex", gap: 14, flexWrap: "wrap", marginTop: 6 } },
            h(
              "label",
              { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12 } },
              h(Toggle, { on: pCache.enabled !== false, onChange: (v) => savePerf({ cache: { enabled: v } }) }),
              "URL 缓存",
            ),
            h("span", { style: { fontSize: 11, opacity: 0.6 } }, `TTL ${Math.round((pCache.ttlMs || 0) / 60000)} 分钟`),
            h(
              "label",
              { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12 } },
              h(Toggle, { on: pAff.enabled !== false, onChange: (v) => savePerf({ affinity: { enabled: v } }) }),
              "域名亲和",
            ),
            h("span", { style: { fontSize: 11, opacity: 0.6 } }, `记住 ${Object.keys(pAff.hosts || {}).length} 个域名`),
            h(
              "label",
              { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12 } },
              h(Toggle, { on: pHedge.enabled === true, onChange: (v) => savePerf({ hedge: { enabled: v } }) }),
              "前两档竞速",
            ),
          ),
          h(
            "div",
            { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4, alignItems: "center" } },
            h("span", { style: { fontSize: 11, opacity: 0.6 } }, "全局超时(ms)"),
            h("input", {
              style: { ...styles.input, width: 90 },
              type: "number",
              value: perf.deadlineMs || 45000,
              onChange: (e) => savePerf({ deadlineMs: Number(e.target.value) || undefined }),
            }),
            h("span", { style: { fontSize: 11, opacity: 0.6, marginLeft: 8 } }, "缓存 TTL(分)"),
            h("input", {
              style: { ...styles.input, width: 70 },
              type: "number",
              value: Math.round((pCache.ttlMs || 600000) / 60000),
              onChange: (e) => savePerf({ cache: { ttlMs: Math.max(0.1, Number(e.target.value) || 1) * 60000 } }),
            }),
            h("button", { style: styles.btn, onClick: () => perfAction("clear") }, "清空缓存"),
            h("button", { style: styles.btn, onClick: () => perfAction("clear-affinity") }, "清空亲和"),
          ),
          perfMsg ? h("div", { style: { fontSize: 11, marginTop: 4, opacity: 0.75 } }, perfMsg) : null,
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
