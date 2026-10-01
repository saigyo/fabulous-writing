// Rendering and interaction for the architecture atlas.
// Content lives in atlas-data.js (window.ATLAS); this file only draws it.
(function () {
  "use strict";
  const A = window.ATLAS;
  const $ = (sel, root = document) => root.querySelector(sel);
  const SVG_NS = "http://www.w3.org/2000/svg";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ── Data preparation ──────────────────────────────────────────────
  const SIZE = { web: [240, 110], embed: [240, 110], backend: [290, 110], data: [320, 110], ext: [320, 110], delivery: [420, 120] };
  const zoneById = new Map(A.zones.map((z) => [z.id, z]));
  const nodeById = new Map();
  for (const n of A.nodes) {
    const [w, h] = SIZE[n.zone];
    n.w = n.w || w;
    n.h = n.h || h;
    nodeById.set(n.id, n);
  }
  const flowById = new Map(A.flows.map((f) => [f.id, f]));

  // node id -> [{flow, idx}] where the node is a step's focus
  const stepsByNode = new Map();
  for (const f of A.flows) {
    f.steps.forEach((s, idx) => {
      if (!stepsByNode.has(s.n)) stepsByNode.set(s.n, []);
      stepsByNode.get(s.n).push({ flow: f, idx });
    });
  }
  const neighbors = new Map();
  for (const [a, b] of A.edges) {
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!neighbors.has(x)) neighbors.set(x, new Set());
      neighbors.get(x).add(y);
    }
  }

  const WORLD = (() => {
    let maxX = 0, maxY = 0;
    for (const z of A.zones) { maxX = Math.max(maxX, z.x + z.w); maxY = Math.max(maxY, z.y + z.h); }
    return { x: 0, y: 0, w: maxX + 40, h: maxY + 40 };
  })();

  // ── Small DOM helpers ─────────────────────────────────────────────
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // Inline markup: `code` and **bold**. Built with DOM nodes, never innerHTML.
  function rich(parent, text) {
    const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const tok = m[0];
      if (tok[0] === "`") parent.append(el("code", null, tok.slice(1, -1)));
      else parent.append(el("strong", null, tok.slice(2, -2)));
      last = m.index + tok.length;
    }
    if (last < text.length) parent.append(text.slice(last));
    return parent;
  }
  function blocks(parent, paragraphs) {
    let list = null;
    for (const p of paragraphs) {
      if (p.startsWith("- ")) {
        if (!list) { list = el("ul", "bullets"); parent.append(list); }
        list.append(rich(el("li"), p.slice(2)));
      } else {
        list = null;
        parent.append(rich(el("p"), p));
      }
    }
  }
  function fileUrl(path) {
    const isDir = !/\.[a-z0-9]+$/i.test(path.split("/").pop());
    return `${A.REPO}/${isDir ? "tree" : "blob"}/main/${path}`;
  }
  // Doc keys look like "backend#the-check-flow" or "backend#<anchor>|Label".
  function docLink(key) {
    const [ref, label] = key.split("|");
    const [doc, anchor] = ref.split("#");
    const d = A.DOCS[doc];
    return { title: d.title, url: `${A.REPO}/blob/main/${d.path}${anchor ? "#" + anchor : ""}`, section: label || (anchor ? prettyAnchor(anchor) : "") };
  }
  // GitHub heading slug → readable text; drops ticket ids like b17 or m6.
  function prettyAnchor(a) {
    const words = a.split("-").filter((w) => w && !/^([bcm]\d+|\d+)$/.test(w));
    const text = words.join(" ").replace(/_/g, " ");
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  function externalLink(text, url, cls) {
    const a = el("a", cls, text);
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  // ── Build the world ───────────────────────────────────────────────
  const viewport = $("#viewport");
  const world = $("#world");
  const edgeSvg = $("#edges");
  world.style.width = WORLD.w + "px";
  world.style.height = WORLD.h + "px";
  edgeSvg.setAttribute("width", WORLD.w);
  edgeSvg.setAttribute("height", WORLD.h);
  edgeSvg.setAttribute("viewBox", `0 0 ${WORLD.w} ${WORLD.h}`);

  const zoneEls = new Map();
  for (const z of A.zones) {
    const d = el("section", "zone");
    d.style.cssText = `left:${z.x}px;top:${z.y}px;width:${z.w}px;height:${z.h}px;--hue:var(--z-${z.hue})`;
    const head = el("button", "zone-head");
    head.type = "button";
    head.dataset.zone = z.id;
    head.append(el("span", "zone-title", z.title), el("span", "zone-sub", z.sub));
    d.append(head);
    for (const b of z.bands || []) {
      const band = el("div", "band", b.label);
      band.style.top = b.y - z.y + "px";
      d.append(band);
    }
    world.append(d);
    zoneEls.set(z.id, d);
  }

  const nodeEls = new Map();
  for (const n of A.nodes) {
    const z = zoneById.get(n.zone);
    const b = el("button", "node");
    b.type = "button";
    b.dataset.node = n.id;
    b.style.cssText = `left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px;--hue:var(--z-${z.hue})`;
    b.append(el("span", "node-kind", n.kind), el("span", "node-title", n.title), el("span", "node-summary", n.summary));
    const badge = el("span", "node-steps");
    b.append(badge);
    world.append(b);
    nodeEls.set(n.id, b);
  }

  function edgeGeometry(a, b) {
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
    const dx = bx - ax, dy = by - ay;
    const horiz = Math.abs(dx) / (a.w + b.w) > Math.abs(dy) / (a.h + b.h);
    let sx, sy, ex, ey;
    if (horiz) {
      sx = dx > 0 ? a.x + a.w : a.x; sy = ay;
      ex = dx > 0 ? b.x : b.x + b.w; ey = by;
    } else {
      sx = ax; sy = dy > 0 ? a.y + a.h : a.y;
      ex = bx; ey = dy > 0 ? b.y : b.y + b.h;
    }
    const dist = Math.hypot(ex - sx, ey - sy);
    const k = Math.max(30, Math.min(260, dist * 0.42));
    let c1x = sx, c1y = sy, c2x = ex, c2y = ey;
    if (horiz) { const s = Math.sign(dx) || 1; c1x += k * s; c2x -= k * s; }
    else { const s = Math.sign(dy) || 1; c1y += k * s; c2y -= k * s; }
    // Point at t = 0.5 for labels.
    const mx = 0.125 * sx + 0.375 * c1x + 0.375 * c2x + 0.125 * ex;
    const my = 0.125 * sy + 0.375 * c1y + 0.375 * c2y + 0.125 * ey;
    return { d: `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${ex},${ey}`, mx, my };
  }
  function svg(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  const structural = svg("g", { class: "edges-structural" });
  const flowLayer = svg("g", { class: "edges-flow" });
  edgeSvg.append(structural, flowLayer);
  const edgeLabels = $("#edge-labels");
  const edgeEls = [];
  const labelEls = [];
  for (const [from, to, label] of A.edges) {
    const g = edgeGeometry(nodeById.get(from), nodeById.get(to));
    const p = svg("path", { d: g.d, class: "edge", "marker-end": "url(#arrow)" });
    p.dataset.from = from;
    p.dataset.to = to;
    structural.append(p);
    edgeEls.push(p);
    if (label) {
      const l = el("span", "edge-label", label);
      l.dataset.from = from;
      l.dataset.to = to;
      labelEls.push(l);
      l.style.left = g.mx + "px";
      l.style.top = g.my + "px";
      edgeLabels.append(l);
    }
  }

  // ── Camera ────────────────────────────────────────────────────────
  const cam = { s: 0.3, x: 0, y: 0 };
  const MIN_S = 0.12, MAX_S = 2.4;
  let anim = null;
  let rafPending = false;

  function lod(s) { return s < 0.42 ? "far" : s < 0.85 ? "mid" : "near"; }
  function applyCamera() {
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.s})`;
    viewport.style.setProperty("--inv", (1 / cam.s).toFixed(4));
    viewport.dataset.lod = lod(cam.s);
    const g = 40 * cam.s;
    viewport.style.backgroundSize = `${g}px ${g}px`;
    viewport.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
    $("#zoom-level").textContent = Math.round(cam.s * 100) + "%";
    scheduleMinimap();
  }
  function clampScale(s) { return Math.max(MIN_S, Math.min(MAX_S, s)); }

  // The part of the viewport not covered by floating panels.
  function visibleRect() {
    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    let left = 0, right = vw, bottom = vh;
    const mobile = vw < 760;
    // Panels slide in with a CSS transform, so measure their resting
    // layout (offset sizes and the fixed margins) instead of the
    // mid-transition bounding box.
    const rail = $("#rail");
    if (!mobile && !rail.classList.contains("collapsed")) left = 16 + rail.offsetWidth + 8;
    const drawer = $("#drawer");
    if (drawer.classList.contains("open")) {
      if (mobile) bottom = vh - 8 - drawer.offsetHeight - 8;
      else right = vw - 16 - drawer.offsetWidth - 8;
    }
    return { x: left, y: 0, w: Math.max(120, right - left), h: Math.max(120, bottom) };
  }
  function cameraFor(rect, maxScale = 1.0, pad = 40) {
    const v = visibleRect();
    const s = clampScale(Math.min((v.w - pad * 2) / rect.w, (v.h - pad * 2) / rect.h, maxScale));
    return { s, x: v.x + v.w / 2 - (rect.x + rect.w / 2) * s, y: v.y + v.h / 2 - (rect.y + rect.h / 2) * s };
  }
  function animateTo(target) {
    if (anim) cancelAnimationFrame(anim.raf);
    if (reduceMotion.matches) { Object.assign(cam, target); applyCamera(); return; }
    const start = { ...cam };
    const t0 = performance.now();
    const dur = 520;
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      const e = ease(t);
      // Interpolate scale geometrically so zooming feels even.
      cam.s = start.s * Math.pow(target.s / start.s, e);
      cam.x = start.x + (target.x - start.x) * e;
      cam.y = start.y + (target.y - start.y) * e;
      applyCamera();
      if (t < 1) anim.raf = requestAnimationFrame(step);
      else anim = null;
    };
    anim = { raf: requestAnimationFrame(step) };
  }
  function stopAnim() { if (anim) { cancelAnimationFrame(anim.raf); anim = null; } }
  function zoomAt(sx, sy, factor) {
    stopAnim();
    const s = clampScale(cam.s * factor);
    const wx = (sx - cam.x) / cam.s, wy = (sy - cam.y) / cam.s;
    cam.s = s;
    cam.x = sx - wx * s;
    cam.y = sy - wy * s;
    applyCamera();
  }
  function fitAll() { animateTo(cameraFor(WORLD, 1, 24)); }
  function unionRect(ids, pad) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const id of ids) {
      const n = nodeById.get(id) || zoneById.get(id);
      if (!n) continue;
      x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y);
      x2 = Math.max(x2, n.x + n.w); y2 = Math.max(y2, n.y + n.h);
    }
    return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
  }

  // ── Pointer, wheel, touch ─────────────────────────────────────────
  const pointers = new Map();
  let drag = null;
  viewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    stopAnim();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    viewport.setPointerCapture(e.pointerId);
    if (pointers.size === 1) {
      drag = { x: e.clientX, y: e.clientY, camX: cam.x, camY: cam.y, moved: false, target: e.target };
    } else if (pointers.size === 2) {
      const [p, q] = [...pointers.values()];
      drag = { pinch: true, dist: Math.hypot(p.x - q.x, p.y - q.y), s: cam.s, moved: true };
    }
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!drag) return;
    if (drag.pinch && pointers.size === 2) {
      const [p, q] = [...pointers.values()];
      const dist = Math.hypot(p.x - q.x, p.y - q.y);
      const r = viewport.getBoundingClientRect();
      zoomAt((p.x + q.x) / 2 - r.left, (p.y + q.y) / 2 - r.top, (drag.s * dist) / drag.dist / cam.s);
      return;
    }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) { drag.moved = true; viewport.classList.add("panning"); }
    cam.x = drag.camX + dx;
    cam.y = drag.camY + dy;
    applyCamera();
  });
  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      viewport.classList.remove("panning");
      if (drag && !drag.moved && e.type === "pointerup") clickTarget(drag.target);
      drag = null;
    } else if (pointers.size === 1) {
      const [p] = [...pointers.values()];
      drag = { x: p.x, y: p.y, camX: cam.x, camY: cam.y, moved: true };
    }
  }
  viewport.addEventListener("pointerup", endPointer);
  viewport.addEventListener("pointercancel", endPointer);
  viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const delta = e.deltaY * unit;
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0018)));
  }, { passive: false });

  function clickTarget(target) {
    const node = target.closest(".node");
    if (node) { selectNode(node.dataset.node, { focus: false }); return; }
    const zone = target.closest(".zone-head");
    if (zone) { selectZone(zone.dataset.zone); return; }
  }
  // Hovering a card highlights its arrows (pointer devices only).
  world.addEventListener("pointerover", (e) => {
    const n = e.target.closest(".node");
    if (n && e.pointerType === "mouse") highlightEdges(n.dataset.node, "hovered");
  });
  world.addEventListener("pointerout", (e) => {
    const n = e.target.closest(".node");
    if (n && !n.contains(e.relatedTarget)) highlightEdges(null, "hovered");
  });
  const focusIds = { related: null, hovered: null };
  function highlightEdges(id, cls) {
    focusIds[cls] = id;
    viewport.classList.toggle("has-focus", !!(focusIds.related || focusIds.hovered));
    for (const p of edgeEls) p.classList.toggle(cls, !!id && (p.dataset.from === id || p.dataset.to === id));
    for (const l of labelEls) l.classList.toggle(cls, !!id && (l.dataset.from === id || l.dataset.to === id));
  }

  // Keyboard activation of nodes and zone heads (pointer clicks go through clickTarget).
  world.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const t = e.target;
    if (t.classList.contains("node") || t.classList.contains("zone-head")) {
      e.preventDefault();
      if (t.dataset.node) selectNode(t.dataset.node, { focus: true });
      else selectZone(t.dataset.zone);
    }
  });
  world.addEventListener("focusin", (e) => {
    const t = e.target;
    if (!t.classList.contains("node") || drag) return;
    const n = nodeById.get(t.dataset.node);
    const v = visibleRect();
    const sx = n.x * cam.s + cam.x, sy = n.y * cam.s + cam.y;
    const ex = (n.x + n.w) * cam.s + cam.x, ey = (n.y + n.h) * cam.s + cam.y;
    if (sx < v.x || ex > v.x + v.w || sy < v.y || ey > v.y + v.h) {
      animateTo(cameraFor(unionRect([n.id], 160), Math.max(cam.s, 0.6)));
    }
  });

  // ── State: selection, flows, hash ─────────────────────────────────
  const state = { node: null, zone: null, flow: null, step: 0, view: "tour" };
  const drawer = $("#drawer");
  const drawerBody = $("#drawer-body");

  function setHash() {
    let h = "";
    if (state.flow && state.view === "flow") h = `#flow=${state.flow.id}&step=${state.step + 1}`;
    else if (state.view === "node" && state.node) h = `#node=${state.node}`;
    else if (state.view === "zone" && state.zone) h = `#zone=${state.zone}`;
    if (location.hash !== h) history.replaceState(null, "", h || location.pathname + location.search);
  }
  function openDrawer() {
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
  }
  function closeDrawer() {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    state.view = "none";
    state.node = null;
    state.zone = null;
    exitFlow(false);
    markSelection();
    setHash();
  }

  function markSelection() {
    for (const [id, b] of nodeEls) b.classList.toggle("selected", state.view === "node" && state.node === id);
    highlightEdges(state.view === "node" ? state.node : null, "related");
  }

  function selectNode(id, { focus = true } = {}) {
    if (!nodeById.has(id)) return;
    state.node = id;
    state.view = "node";
    renderNode(id);
    openDrawer();
    markSelection();
    setHash();
    if (focus) requestAnimationFrame(() => animateTo(cameraFor(unionRect([id], 200), 1.05)));
  }
  function selectZone(id) {
    const z = zoneById.get(id);
    if (!z) return;
    state.zone = id;
    state.view = "zone";
    renderZone(z);
    openDrawer();
    markSelection();
    setHash();
    requestAnimationFrame(() => animateTo(cameraFor({ x: z.x - 20, y: z.y - 20, w: z.w + 40, h: z.h + 40 }, 1, 16)));
  }

  function startFlow(id, step = 0) {
    const f = flowById.get(id);
    if (!f) return;
    state.flow = f;
    state.step = Math.max(0, Math.min(step, f.steps.length - 1));
    state.view = "flow";
    viewport.classList.add("flow-active");
    drawFlow();
    renderFlow();
    openDrawer();
    markSelection();
    setHash();
    highlightFlowList();
    requestAnimationFrame(focusStep);
  }
  function exitFlow(rerender = true) {
    if (!state.flow) return;
    state.flow = null;
    viewport.classList.remove("flow-active");
    flowLayer.replaceChildren();
    for (const b of nodeEls.values()) {
      b.classList.remove("in-flow", "current", "from");
      b.querySelector(".node-steps").textContent = "";
    }
    highlightFlowList();
    if (rerender) {
      state.view = "tour";
      renderTour();
      setHash();
    }
  }
  function goStep(delta) {
    if (!state.flow) return;
    const next = state.step + delta;
    if (next < 0 || next >= state.flow.steps.length) return;
    state.step = next;
    state.view = "flow";
    drawFlow();
    renderFlow();
    setHash();
    focusStep();
  }
  function focusStep() {
    const s = state.flow.steps[state.step];
    const ids = s.from ? [s.n, s.from] : [s.n];
    animateTo(cameraFor(unionRect(ids, ids.length > 1 ? 90 : 220), 1.0));
  }
  function flowOverview() {
    const ids = new Set();
    for (const s of state.flow.steps) { ids.add(s.n); if (s.from) ids.add(s.from); }
    animateTo(cameraFor(unionRect([...ids], 80), 1.0, 24));
  }

  function drawFlow() {
    const f = state.flow;
    flowLayer.replaceChildren();
    const involved = new Map(); // node id -> step numbers
    f.steps.forEach((s, i) => {
      if (!involved.has(s.n)) involved.set(s.n, []);
      involved.get(s.n).push(i + 1);
      if (s.from && !involved.has(s.from)) involved.set(s.from, []);
    });
    f.steps.forEach((s, i) => {
      if (!s.from || s.from === s.n) return;
      const g = edgeGeometry(nodeById.get(s.from), nodeById.get(s.n));
      const cls = i === state.step ? "flow-edge current" : i < state.step ? "flow-edge past" : "flow-edge future";
      flowLayer.append(svg("path", { d: g.d, class: cls, "marker-end": i === state.step ? "url(#arrow-flow)" : i < state.step ? "url(#arrow-past)" : "url(#arrow-future)" }));
    });
    // Current edge on top.
    const cur = flowLayer.querySelector(".current");
    if (cur) flowLayer.append(cur);
    const curStep = f.steps[state.step];
    for (const [id, b] of nodeEls) {
      const nums = involved.get(id);
      b.classList.toggle("in-flow", !!nums);
      b.classList.toggle("current", id === curStep.n);
      b.classList.toggle("from", id === curStep.from && id !== curStep.n);
      b.querySelector(".node-steps").textContent = nums && nums.length ? nums.join(" · ") : "";
    }
  }

  // ── Drawer renderers ──────────────────────────────────────────────
  function drawerHeader(eyebrow, title, hue) {
    drawerBody.replaceChildren();
    const head = el("header", "d-head");
    if (hue) head.style.setProperty("--hue", `var(--z-${hue})`);
    head.append(el("p", "eyebrow", eyebrow), el("h2", "d-title", title));
    drawerBody.append(head);
    drawerBody.scrollTop = 0;
    return head;
  }
  function section(title) {
    const s = el("section", "d-section");
    s.append(el("h3", null, title));
    drawerBody.append(s);
    return s;
  }
  function chip(text, onClick, cls = "chip") {
    const b = el("button", cls, text);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function renderTour() {
    drawerHeader("Interactive documentation", A.tour.title);
    const intro = el("div", "prose");
    blocks(intro, A.tour.paragraphs);
    drawerBody.append(intro);
    const how = section("How to use this map");
    const ul = el("ul", "bullets");
    for (const h of A.tour.howto) ul.append(rich(el("li"), h));
    how.append(ul);
    const start = section("Good places to start");
    const row = el("div", "chips");
    for (const id of ["signin", "fastcheck", "llmcheck", "extension", "release"]) {
      const f = flowById.get(id);
      row.append(chip(f.title, () => startFlow(id), "chip chip-flow"));
    }
    start.append(row);
    const zones = section("Areas");
    const zl = el("div", "chips");
    for (const z of A.zones) {
      const c = chip(z.title, () => selectZone(z.id), "chip chip-zone");
      c.style.setProperty("--hue", `var(--z-${z.hue})`);
      zl.append(c);
    }
    zones.append(zl);
  }

  function renderZone(z) {
    const head = drawerHeader("Area", z.title, z.hue);
    head.append(el("p", "d-sub", z.sub));
    const p = el("div", "prose");
    blocks(p, [z.about]);
    drawerBody.append(p);
    const s = section("Components");
    const list = el("div", "chips");
    for (const n of A.nodes.filter((n) => n.zone === z.id)) {
      const c = chip(n.title, () => selectNode(n.id));
      list.append(c);
    }
    s.append(list);
  }

  function renderNode(id) {
    const n = nodeById.get(id);
    const z = zoneById.get(n.zone);
    drawerHeader(`${n.kind} · ${z.title}`, n.title, z.hue);
    if (state.flow) {
      drawerBody.prepend(chip(`← Back to “${state.flow.title}”`, () => { state.view = "flow"; renderFlow(); markSelection(); setHash(); focusStep(); }, "back"));
    }
    if (n.purpose) drawerBody.append(rich(el("p", "lead"), n.purpose));
    const how = section("How it works");
    how.append(rich(el("p", "summary"), n.summary));
    const body = el("div", "prose");
    blocks(body, n.body || []);
    how.append(body);

    const steps = stepsByNode.get(id) || [];
    if (steps.length) {
      const s = section("Takes part in");
      const list = el("div", "chips");
      const byFlow = new Map();
      for (const { flow, idx } of steps) {
        if (!byFlow.has(flow)) byFlow.set(flow, []);
        byFlow.get(flow).push(idx);
      }
      for (const [flow, idxs] of byFlow) {
        const label = `${flow.title} · step ${idxs.map((i) => i + 1).join(", ")}`;
        list.append(chip(label, () => startFlow(flow.id, idxs[0]), "chip chip-flow"));
      }
      s.append(list);
    }
    const nb = neighbors.get(id);
    if (nb && nb.size) {
      const s = section("Connected to");
      const list = el("div", "chips");
      for (const other of nb) {
        const o = nodeById.get(other);
        const c = chip(o.title, () => selectNode(other));
        c.style.setProperty("--hue", `var(--z-${zoneById.get(o.zone).hue})`);
        c.classList.add("chip-node");
        list.append(c);
      }
      s.append(list);
    }
    if (n.files && n.files.length) {
      const s = section("Key files");
      const ul = el("ul", "files");
      for (const f of n.files) {
        const li = el("li");
        li.append(externalLink(f, fileUrl(f), "file"));
        ul.append(li);
      }
      s.append(ul);
    }
    if (n.docs && n.docs.length) {
      const s = section("Read more");
      const ul = el("ul", "docs");
      for (const key of n.docs) {
        const d = docLink(key);
        const li = el("li");
        li.append(externalLink(d.title + (d.section ? " › " + d.section : ""), d.url, "doc"));
        ul.append(li);
      }
      s.append(ul);
    }
  }

  function renderFlow() {
    const f = state.flow;
    drawerHeader(f.group, f.title);
    drawerBody.append(rich(el("p", "lead"), f.intro));
    const ctl = el("div", "stepper");
    const prev = chip("← Previous", () => goStep(-1), "step-btn");
    const next = chip("Next →", () => goStep(1), "step-btn primary");
    prev.disabled = state.step === 0;
    next.disabled = state.step === f.steps.length - 1;
    const count = el("span", "step-count", `Step ${state.step + 1} of ${f.steps.length}`);
    count.setAttribute("aria-live", "polite");
    ctl.append(prev, count, next);
    drawerBody.append(ctl);
    const tools = el("div", "flow-tools");
    tools.append(chip("Show whole process", flowOverview, "link-btn"), chip("Exit process", () => exitFlow(true), "link-btn"));
    drawerBody.append(tools);

    const ol = el("ol", "steps");
    f.steps.forEach((s, i) => {
      const li = el("li", i === state.step ? "step current" : i < state.step ? "step past" : "step");
      const head = el("button", "step-head");
      head.type = "button";
      const node = nodeById.get(s.n);
      head.append(el("span", "step-num", String(i + 1)), el("span", "step-title", s.t));
      head.addEventListener("click", () => { state.step = i; state.view = "flow"; drawFlow(); renderFlow(); setHash(); focusStep(); });
      li.append(head);
      if (i === state.step) {
        const body = el("div", "step-body");
        body.append(rich(el("p"), s.d));
        const where = el("p", "step-where");
        where.append("At ");
        const link = chip(node.title, () => { state.node = s.n; state.view = "node"; renderNode(s.n); markSelection(); setHash(); }, "inline-link");
        link.style.setProperty("--hue", `var(--z-${zoneById.get(node.zone).hue})`);
        where.append(link);
        if (s.from) where.append(` · coming from ${nodeById.get(s.from).title}`);
        body.append(where);
        li.append(body);
      }
      ol.append(li);
    });
    drawerBody.append(ol);
    const cur = ol.querySelector(".current");
    if (cur) requestAnimationFrame(() => cur.scrollIntoView({ block: "nearest", behavior: reduceMotion.matches ? "auto" : "smooth" }));
  }

  // ── Left rail: processes, areas, search ───────────────────────────
  const rail = $("#rail");
  const flowList = $("#flow-list");
  const searchInput = $("#search");
  const results = $("#results");

  function buildFlowList() {
    const groups = new Map();
    for (const f of A.flows) {
      if (!groups.has(f.group)) groups.set(f.group, []);
      groups.get(f.group).push(f);
    }
    for (const [g, fs] of groups) {
      const sec = el("section", "flow-group");
      sec.append(el("h3", null, g));
      const ul = el("ul");
      for (const f of fs) {
        const li = el("li");
        const b = el("button", "flow-item");
        b.type = "button";
        b.dataset.flow = f.id;
        b.append(el("span", "flow-name", f.title), el("span", "flow-len", `${f.steps.length} steps`));
        b.addEventListener("click", () => {
          if (state.flow && state.flow.id === f.id) { exitFlow(true); return; }
          startFlow(f.id);
          if (viewport.clientWidth < 760) rail.classList.add("collapsed");
        });
        li.append(b);
        ul.append(li);
      }
      sec.append(ul);
      flowList.append(sec);
    }
  }
  function highlightFlowList() {
    for (const b of flowList.querySelectorAll(".flow-item")) {
      const on = !!state.flow && b.dataset.flow === state.flow.id;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function runSearch(q) {
    q = q.trim().toLowerCase();
    results.replaceChildren();
    if (!q) { results.hidden = true; flowList.hidden = false; return; }
    flowList.hidden = true;
    results.hidden = false;
    const hits = [];
    for (const f of A.flows) if (f.title.toLowerCase().includes(q) || f.intro.toLowerCase().includes(q)) hits.push({ type: "flow", f, score: f.title.toLowerCase().includes(q) ? 0 : 2 });
    for (const n of A.nodes) {
      const t = n.title.toLowerCase();
      const hay = [n.kind, n.summary, ...(n.body || []), ...(n.files || [])].join(" ").toLowerCase();
      if (t.includes(q)) hits.push({ type: "node", n, score: t.startsWith(q) ? 0 : 1 });
      else if (hay.includes(q)) hits.push({ type: "node", n, score: 3 });
    }
    hits.sort((a, b) => a.score - b.score);
    if (!hits.length) { results.append(el("p", "empty", "Nothing found.")); return; }
    for (const h of hits.slice(0, 40)) {
      const b = el("button", "result");
      b.type = "button";
      if (h.type === "flow") {
        b.append(el("span", "r-kind", "Process"), el("span", "r-title", h.f.title));
        b.addEventListener("click", () => startFlow(h.f.id));
      } else {
        b.style.setProperty("--hue", `var(--z-${zoneById.get(h.n.zone).hue})`);
        b.append(el("span", "r-kind", h.n.kind + " · " + zoneById.get(h.n.zone).title), el("span", "r-title", h.n.title));
        b.addEventListener("click", () => selectNode(h.n.id));
      }
      results.append(b);
    }
  }
  searchInput.addEventListener("input", () => runSearch(searchInput.value));
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const first = results.querySelector(".result"); if (first) first.click(); }
    if (e.key === "Escape") { searchInput.value = ""; runSearch(""); searchInput.blur(); e.stopPropagation(); }
  });

  // ── Minimap ───────────────────────────────────────────────────────
  const mini = $("#minimap");
  const mctx = mini.getContext("2d");
  let colors = null;
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const c = (n) => cs.getPropertyValue(n).trim();
    colors = { client: c("--z-client"), server: c("--z-server"), data: c("--z-data"), external: c("--z-external"), delivery: c("--z-delivery"), accent: c("--accent"), ink: c("--ink-2"), panel: c("--panel") };
  }
  function scheduleMinimap() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; drawMinimap(); });
  }
  function miniScale() {
    const w = mini.clientWidth, h = mini.clientHeight;
    return Math.min(w / WORLD.w, h / WORLD.h);
  }
  function drawMinimap() {
    if (!colors) readColors();
    const dpr = window.devicePixelRatio || 1;
    const w = mini.clientWidth, h = mini.clientHeight;
    if (mini.width !== w * dpr) { mini.width = w * dpr; mini.height = h * dpr; }
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctx.clearRect(0, 0, w, h);
    const k = miniScale();
    for (const z of A.zones) {
      mctx.globalAlpha = 0.16;
      mctx.fillStyle = colors[z.hue];
      mctx.fillRect(z.x * k, z.y * k, z.w * k, z.h * k);
    }
    mctx.globalAlpha = 0.75;
    for (const n of A.nodes) {
      const on = !state.flow || nodeEls.get(n.id).classList.contains("in-flow");
      mctx.fillStyle = on ? colors[zoneById.get(n.zone).hue] : colors.ink;
      mctx.globalAlpha = on ? 0.8 : 0.15;
      mctx.fillRect(n.x * k, n.y * k, Math.max(1.5, n.w * k), Math.max(1.5, n.h * k));
    }
    mctx.globalAlpha = 1;
    const v = visibleRect();
    const rx = (v.x - cam.x) / cam.s, ry = (v.y - cam.y) / cam.s;
    mctx.strokeStyle = colors.accent;
    mctx.lineWidth = 1.5;
    mctx.strokeRect(rx * k, ry * k, (v.w / cam.s) * k, (v.h / cam.s) * k);
  }
  function miniJump(e) {
    const r = mini.getBoundingClientRect();
    const k = miniScale();
    const wx = (e.clientX - r.left) / k, wy = (e.clientY - r.top) / k;
    const v = visibleRect();
    stopAnim();
    cam.x = v.x + v.w / 2 - wx * cam.s;
    cam.y = v.y + v.h / 2 - wy * cam.s;
    applyCamera();
  }
  let miniDrag = false;
  mini.addEventListener("pointerdown", (e) => { miniDrag = true; mini.setPointerCapture(e.pointerId); miniJump(e); });
  mini.addEventListener("pointermove", (e) => { if (miniDrag) miniJump(e); });
  mini.addEventListener("pointerup", () => { miniDrag = false; });

  // ── Controls & keyboard ───────────────────────────────────────────
  function centerZoom(f) {
    const v = visibleRect();
    zoomAt(v.x + v.w / 2, v.y + v.h / 2, f);
  }
  $("#zoom-in").addEventListener("click", () => centerZoom(1.3));
  $("#zoom-out").addEventListener("click", () => centerZoom(1 / 1.3));
  $("#zoom-fit").addEventListener("click", fitAll);
  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#rail-toggle").addEventListener("click", () => {
    rail.classList.toggle("collapsed");
    $("#rail-toggle").setAttribute("aria-expanded", rail.classList.contains("collapsed") ? "false" : "true");
    scheduleMinimap();
  });
  $("#rail-close").addEventListener("click", () => $("#rail-toggle").click());
  $("#about").addEventListener("click", () => { exitFlow(false); state.view = "tour"; renderTour(); openDrawer(); markSelection(); setHash(); });

  const themeBtn = $("#theme");
  const THEMES = ["system", "light", "dark"];
  function applyTheme(t) {
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    themeBtn.textContent = t === "system" ? "Theme: auto" : t === "light" ? "Theme: light" : "Theme: dark";
    try { localStorage.setItem("atlas-theme", t); } catch (_) { /* storage unavailable */ }
    readColors();
    scheduleMinimap();
  }
  themeBtn.addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || "system";
    applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readColors(); scheduleMinimap(); });

  document.addEventListener("keydown", (e) => {
    const typing = e.target.matches("input, textarea");
    if (e.key === "/" && !typing) { e.preventDefault(); if (rail.classList.contains("collapsed")) $("#rail-toggle").click(); searchInput.focus(); return; }
    if (typing) return;
    if (e.key === "Escape") {
      if (state.view === "node" && state.flow) { state.view = "flow"; renderFlow(); markSelection(); setHash(); }
      else if (drawer.classList.contains("open")) closeDrawer();
      return;
    }
    if (state.flow && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      goStep(e.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (e.key === "+" || e.key === "=") centerZoom(1.25);
    else if (e.key === "-" || e.key === "_") centerZoom(1 / 1.25);
    else if (e.key === "0") fitAll();
  });
  window.addEventListener("resize", () => { scheduleMinimap(); });

  // ── Boot ──────────────────────────────────────────────────────────
  buildFlowList();
  try { const t = localStorage.getItem("atlas-theme"); if (t && t !== "system") applyTheme(t); } catch (_) { /* storage unavailable */ }
  readColors();
  if (window.innerWidth < 1100) rail.classList.add("collapsed");
  $("#rail-toggle").setAttribute("aria-expanded", rail.classList.contains("collapsed") ? "false" : "true");

  function fromHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("flow") && flowById.has(h.get("flow"))) { startFlow(h.get("flow"), (parseInt(h.get("step"), 10) || 1) - 1); return true; }
    if (h.get("node") && nodeById.has(h.get("node"))) { selectNode(h.get("node")); return true; }
    if (h.get("zone") && zoneById.has(h.get("zone"))) { selectZone(h.get("zone")); return true; }
    return false;
  }
  // Start fitted to the whole map, then honor a deep link.
  Object.assign(cam, cameraFor(WORLD, 1, 24));
  applyCamera();
  if (!fromHash()) {
    renderTour();
    if (window.innerWidth >= 760) openDrawer();
    Object.assign(cam, cameraFor(WORLD, 1, 24));
    applyCamera();
  }
  window.addEventListener("hashchange", fromHash);
})();
