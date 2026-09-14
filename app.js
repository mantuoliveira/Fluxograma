(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const canvas = $("#canvas");
  const svg = $("#connections");
  const appShell = $(".app-shell");
  const palette = $("#palette");
  const historyPanel = $(".history");
  const historyResize = $("#historyResize");
  const typeNames = { start: "INÍCIO", assignment: "AÇÃO", call: "CHAMADA", decision: "DECISÃO", end: "FIM" };
  const defaults = { start: "INÍCIO", assignment: "x <- 0", call: "Subfluxo", decision: "x < 10", end: "FIM" };
  const GRID_SIZE = 22;
  const sides = ["top", "right", "bottom", "left"];
  const sideNames = { top: "cima", right: "direita", bottom: "baixo", left: "esquerda" };
  const sideDirections = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };

  let state = { blocks: [], connections: [] };
  let selectedId = null;
  let selectedConnectionId = null;
  let editingId = null;
  let editingOriginal = "";
  let pendingConnection = null;
  let drag = null;
  let routeDrag = null;
  let panelResize = null;
  let run = freshRun();
  let idCounter = 1;
  let toastTimer;
  let connectionFrame = null;

  function scheduleDrawConnections() {
    cancelAnimationFrame(connectionFrame);
    connectionFrame = requestAnimationFrame(() => {
      connectionFrame = null;
      drawConnections();
    });
  }

  function freshRun() {
    return { currentId: null, variables: {}, history: [], returnStack: [], ended: false, lastConnection: null };
  }

  function makeId() {
    return `b${Date.now().toString(36)}_${idCounter++}`;
  }

  function makeConnectionId() {
    return `c${Date.now().toString(36)}_${idCounter++}`;
  }

  function snap(value, minimum = 0) {
    return Math.max(minimum, Math.round(value / GRID_SIZE) * GRID_SIZE);
  }

  function maximumHistoryWidth() {
    if (window.innerWidth <= 800) return Math.max(250, window.innerWidth - 20);
    const paletteCollapsed = appShell.classList.contains("palette-collapsed");
    const paletteWidth = paletteCollapsed ? 0 : window.innerWidth <= 1050 ? 202 : 232;
    const canvasMinimum = 500;
    const layoutSpacing = paletteCollapsed ? 60 : 72;
    return Math.max(250, window.innerWidth - paletteWidth - canvasMinimum - layoutSpacing);
  }

  function setHistoryWidth(width, persist = true) {
    const nextWidth = Math.round(Math.max(250, Math.min(maximumHistoryWidth(), width)));
    document.documentElement.style.setProperty("--history-width", `${nextWidth}px`);
    historyResize.setAttribute("aria-valuenow", String(nextWidth));
    historyResize.setAttribute("aria-valuemax", String(Math.round(maximumHistoryWidth())));
    if (persist) {
      try { localStorage.setItem("fluxo-history-width", String(nextWidth)); } catch (_) { /* Preferência opcional. */ }
    }
    scheduleDrawConnections();
    return nextWidth;
  }

  function setHistoryCollapsed(collapsed, persist = true) {
    historyPanel.classList.toggle("collapsed", collapsed);
    appShell.classList.toggle("history-collapsed", collapsed);
    const button = $("#toggleHistory");
    button.setAttribute("aria-expanded", String(!collapsed));
    button.setAttribute("aria-label", collapsed ? "Expandir rastreamento" : "Recolher rastreamento");
    button.title = collapsed ? "Expandir rastreamento" : "Recolher rastreamento";
    if (persist) {
      try { localStorage.setItem("fluxo-history-collapsed", collapsed ? "1" : "0"); } catch (_) { /* Preferência opcional. */ }
    }
    scheduleDrawConnections();
    setTimeout(scheduleDrawConnections, 250);
  }

  function assignmentLines(source) {
    return String(source).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  function parseAssignment(line, index) {
    const match = line.match(/^([A-Za-z_]\w*)(?:\s*\[\s*(.+?)\s*\])?\s*<-\s*(.+)$/);
    if (!match) throw new Error(`Linha ${index + 1}: use variável <- expressão ou lista[índice] <- expressão.`);
    return { name: match[1], indexSource: match[2], valueSource: match[3] };
  }

  function validateListIndex(value) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error("O índice da lista precisa ser um número inteiro maior ou igual a zero.");
    }
    return value;
  }

  function snapshotVariables(variables) {
    return Object.fromEntries(Object.entries(variables).map(([name, value]) => [name, Array.isArray(value) ? value.slice() : value]));
  }

  function blockDimensions(blockOrType) {
    const type = typeof blockOrType === "string" ? blockOrType : blockOrType.type;
    const hasContent = typeof blockOrType !== "string";
    const lineCount = type === "assignment" && typeof blockOrType !== "string"
      ? Math.max(1, assignmentLines(blockOrType.code).length)
      : 1;
    const longestLine = ["assignment", "decision"].includes(type) && hasContent
      ? Math.max(1, ...String(blockOrType.code).split(/\r?\n/).map((line) => line.length))
      : 1;
    let columns = type === "assignment"
      ? Math.max(8, Math.ceil((longestLine * 8 + 48) / GRID_SIZE))
      : type === "decision" ? Math.max(8, Math.ceil((longestLine * 8 + 88) / GRID_SIZE)) : 8;
    if (["assignment", "decision"].includes(type) && columns % 2) columns += 1;
    let rows = type === "decision" ? 6 : type === "assignment" ? Math.max(4, lineCount + 2) : 4;
    if (rows % 2) rows += 1;
    return { width: GRID_SIZE * columns, height: GRID_SIZE * rows };
  }

  function normalizeDynamicBlockLayout(block) {
    const dimensions = blockDimensions(block);
    const width = dimensions.width;
    const height = dimensions.height;
    const previousWidth = Number.isFinite(block.layoutWidth) ? block.layoutWidth : GRID_SIZE * 8;
    const previousHeight = Number.isFinite(block.layoutHeight) ? block.layoutHeight : height;
    if (width !== previousWidth) block.x = snap(block.x - (width - previousWidth) / 2, 0);
    if (height !== previousHeight) block.y = snap(block.y - (height - previousHeight) / 2, 0);
    block.layoutWidth = width;
    block.layoutHeight = height;
  }

  function findFreeBlockPosition(type) {
    const start = GRID_SIZE * 2;
    const gap = GRID_SIZE;
    const rowStep = GRID_SIZE * 6;
    const dimensions = blockDimensions(type);
    const availableWidth = Math.max(canvas.clientWidth, dimensions.width + start * 2);
    const columnStep = dimensions.width + gap;
    const columns = Math.max(1, Math.floor((availableWidth - start * 2 + gap) / columnStep));
    const attempts = Math.max(100, (state.blocks.length + 1) * 8);

    for (let index = 0; index < attempts; index += 1) {
      const candidate = {
        x: start + (index % columns) * columnStep,
        y: start + Math.floor(index / columns) * rowStep
      };
      const occupied = state.blocks.some((block) => {
        const existing = blockDimensions(block);
        return candidate.x < block.x + existing.width + gap
          && candidate.x + dimensions.width + gap > block.x
          && candidate.y < block.y + existing.height + gap
          && candidate.y + dimensions.height + gap > block.y;
      });
      if (!occupied) return candidate;
    }

    const lowestEdge = state.blocks.reduce((edge, block) => Math.max(edge, block.y + blockDimensions(block).height), start);
    return { x: start, y: snap(lowestEdge + gap, GRID_SIZE) };
  }

  function addBlock(type, x, y, code = defaults[type]) {
    const position = Number.isFinite(x) && Number.isFinite(y)
      ? { x: snap(x, GRID_SIZE), y: snap(y, GRID_SIZE) }
      : findFreeBlockPosition(type);
    const block = {
      id: makeId(), type, code,
      x: position.x,
      y: position.y,
      ...(type === "decision" ? { trueSide: "right", falseSide: "left" } : {})
    };
    state.blocks.push(block);
    resetExecution(false);
    selectBlock(block.id);
    startInlineEdit(block.id);
  }

  function selectBlock(id) {
    selectedId = id;
    selectedConnectionId = null;
    const block = state.blocks.find((item) => item.id === id);
    $("#deleteSelected").disabled = !block;
  }

  function validateBlockCode(block, value) {
    const code = value.trim();
    if (!code) throw new Error("O bloco precisa ter um texto.");
    if (block.type === "assignment") {
      const lines = assignmentLines(code);
      if (!lines.length) throw new Error("O bloco precisa ter uma ação.");
      lines.forEach(parseAssignment);
      return lines.join("\n");
    }
    if (block.type === "decision") {
      tokenize(code);
      if (!/(?:<=|>=|!=|[<>=])/.test(code)) throw new Error("A decisão precisa ter uma comparação.");
    }
    return code;
  }

  function startInlineEdit(id) {
    const block = state.blocks.find((item) => item.id === id);
    if (!block) return;
    selectedId = id;
    selectedConnectionId = null;
    editingId = id;
    editingOriginal = block.code;
    $("#deleteSelected").disabled = false;
    render();
    requestAnimationFrame(() => {
      const input = canvas.querySelector(`.flow-block[data-id="${CSS.escape(id)}"] .inline-editor`);
      if (input) { input.focus(); input.select(); }
    });
  }

  function finishInlineEdit(cancel = false) {
    if (!editingId) return true;
    const block = state.blocks.find((item) => item.id === editingId);
    const input = canvas.querySelector(`.flow-block[data-id="${CSS.escape(editingId)}"] .inline-editor`);
    if (!block) { editingId = null; return true; }
    if (cancel) block.code = editingOriginal;
    else {
      try { block.code = validateBlockCode(block, input ? input.value : block.code); }
      catch (error) {
        toast(error.message);
        if (input) { input.focus(); input.select(); }
        return false;
      }
    }
    editingId = null;
    editingOriginal = "";
    resetExecution(false);
    return true;
  }

  function render() {
    canvas.classList.toggle("connecting", Boolean(pendingConnection));
    canvas.querySelectorAll(".flow-block, .branch-picker").forEach((node) => node.remove());
    $("#emptyState").hidden = state.blocks.length > 0;
    $("#blockCount").textContent = state.blocks.length;

    state.blocks.filter((block) => block.type === "decision").forEach(normalizeDecisionSides);
    state.blocks.filter((block) => ["assignment", "decision"].includes(block.type)).forEach(normalizeDynamicBlockLayout);
    syncDecisionConnections();

    state.blocks.forEach((block) => {
      const el = document.createElement("div");
      el.className = `flow-block ${block.type}${block.id === selectedId ? " selected" : ""}${block.id === run.currentId ? " current" : ""}${block.id === editingId ? " editing" : ""}`;
      el.dataset.id = block.id;
      el.style.left = `${block.x}px`;
      el.style.top = `${block.y}px`;
      if (["assignment", "decision"].includes(block.type)) {
        const dimensions = blockDimensions(block);
        el.style.width = `${dimensions.width}px`;
        el.style.height = `${dimensions.height}px`;
      }
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.setAttribute("aria-label", `${typeNames[block.type]}: ${block.code}`);
      const editor = block.type === "assignment"
        ? '<textarea class="inline-editor" autocomplete="off" spellcheck="false" aria-label="Editar ações do bloco"></textarea>'
        : '<input class="inline-editor" autocomplete="off" spellcheck="false" aria-label="Editar texto do bloco">';
      const blockSurface = block.type === "decision"
        ? '<span class="decision-surface" aria-hidden="true"></span>'
        : block.type === "call" ? '<span class="call-bars" aria-hidden="true"></span>' : "";
      el.innerHTML = `${blockSurface}${block.id === editingId ? editor : '<span class="block-code"></span>'}`;
      const content = el.querySelector(block.id === editingId ? ".inline-editor" : ".block-code");
      if (block.id === editingId) content.value = block.code;
      else content.textContent = block.code;

      sides.forEach((side) => el.appendChild(makePort(block, side)));
      if (block.type === "decision") {
        el.appendChild(makePortTag("V", "true", block.trueSide));
        el.appendChild(makePortTag("F", "false", block.falseSide));
      }
      canvas.appendChild(el);
    });
    scheduleDrawConnections();
  }

  function makePort(block, side) {
    const branch = block.type === "decision"
      ? side === block.trueSide ? "true" : side === block.falseSide ? "false" : null
      : block.type === "end" ? null : "next";
    const port = document.createElement("button");
    port.type = "button";
    port.className = `port side-${side}${branch ? ` branch-${branch}` : ""}`;
    port.dataset.side = side;
    const role = branch === "true" ? "Saída verdadeira" : branch === "false" ? "Saída falsa" : "Conexão";
    port.setAttribute("aria-label", `${role}, ${sideNames[side]}`);
    if (branch) port.dataset.branch = branch;
    return port;
  }

  function makePortTag(text, branch, side) {
    const tag = document.createElement("span");
    tag.className = `port-tag ${branch}-tag side-${side}`;
    tag.textContent = text;
    return tag;
  }

  function normalizeDecisionSides(block) {
    block.trueSide = sides.includes(block.trueSide) ? block.trueSide : "right";
    block.falseSide = sides.includes(block.falseSide) ? block.falseSide : "left";
    if (block.trueSide === block.falseSide) block.falseSide = block.trueSide === "left" ? "right" : "left";
  }

  function syncDecisionConnections() {
    const decisions = new Map(state.blocks.filter((block) => block.type === "decision").map((block) => [block.id, block]));
    state.connections.forEach((connection) => {
      const block = decisions.get(connection.from);
      if (!block) return;
      if (connection.fromSide === block.trueSide) connection.branch = "true";
      else if (connection.fromSide === block.falseSide) connection.branch = "false";
      else if (connection.branch === "true") connection.fromSide = block.trueSide;
      else if (connection.branch === "false") connection.fromSide = block.falseSide;
    });
  }

  function portPoint(block, side) {
    const el = canvas.querySelector(`[data-id="${CSS.escape(block.id)}"]`);
    if (!el) return { x: 0, y: 0 };
    const canvasRect = canvas.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const left = rect.left - canvasRect.left + canvas.scrollLeft;
    const top = rect.top - canvasRect.top + canvas.scrollTop;
    if (side === "top") return { x: left + rect.width / 2, y: top };
    if (side === "right") return { x: left + rect.width, y: top + rect.height / 2 };
    if (side === "left") return { x: left, y: top + rect.height / 2 };
    return { x: left + rect.width / 2, y: top + rect.height };
  }

  function connectionFromSide(connection, block) {
    if (block.type === "decision" && connection.branch === "true") return block.trueSide;
    if (block.type === "decision" && connection.branch === "false") return block.falseSide;
    return sides.includes(connection.fromSide) ? connection.fromSide : "bottom";
  }

  function removeCollinearPoints(points) {
    const unique = points.filter((point, index) => !index || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
    return unique.filter((point, index) => {
      if (!index || index === unique.length - 1) return true;
      const previous = unique[index - 1];
      const next = unique[index + 1];
      return !((previous.x === point.x && point.x === next.x) || (previous.y === point.y && point.y === next.y));
    });
  }

  function defaultRouteControl(exit, fromDirection, entry, toDirection) {
    const fromHorizontal = fromDirection.x !== 0;
    const toHorizontal = toDirection.x !== 0;
    const midpoint = (start, end) => snap((start + end) / 2);
    if (fromHorizontal && toHorizontal) {
      if (exit.y === entry.y) return { axis: "y", value: exit.y };
      const sameDirection = fromDirection.x === toDirection.x;
      const destinationIsAhead = (entry.x - exit.x) * fromDirection.x >= 0;
      return {
        axis: "x",
        value: sameDirection
          ? (fromDirection.x < 0 ? Math.min(exit.x, entry.x) : Math.max(exit.x, entry.x))
          : destinationIsAhead ? midpoint(exit.x, entry.x) : exit.x
      };
    }
    if (!fromHorizontal && !toHorizontal) {
      if (exit.x === entry.x) return { axis: "x", value: exit.x };
      const sameDirection = fromDirection.y === toDirection.y;
      const destinationIsAhead = (entry.y - exit.y) * fromDirection.y >= 0;
      return {
        axis: "y",
        value: sameDirection
          ? (fromDirection.y < 0 ? Math.min(exit.y, entry.y) : Math.max(exit.y, entry.y))
          : destinationIsAhead ? midpoint(exit.y, entry.y) : exit.y
      };
    }
    return fromHorizontal ? { axis: "x", value: exit.x } : { axis: "y", value: exit.y };
  }

  function routeStubLength(a, fromDirection, b, toDirection) {
    const portsFaceEachOther = fromDirection.x === -toDirection.x && fromDirection.y === -toDirection.y;
    if (!portsFaceEachOther) return GRID_SIZE;
    const availableDistance = (b.x - a.x) * fromDirection.x + (b.y - a.y) * fromDirection.y;
    if (availableDistance <= 0) return GRID_SIZE;
    return availableDistance >= GRID_SIZE * 2 ? GRID_SIZE : 0;
  }

  function orthogonalGeometry(a, fromSide, b, toSide, savedControl) {
    const fromDirection = sideDirections[fromSide];
    const toDirection = sideDirections[toSide];
    const stubLength = routeStubLength(a, fromDirection, b, toDirection);
    const exit = { x: a.x + fromDirection.x * stubLength, y: a.y + fromDirection.y * stubLength };
    const entry = { x: b.x + toDirection.x * stubLength, y: b.y + toDirection.y * stubLength };
    const initialControl = defaultRouteControl(exit, fromDirection, entry, toDirection);
    const control = savedControl
      && savedControl.axis === initialControl.axis
      && Number.isFinite(savedControl.value)
      ? { axis: savedControl.axis, value: snap(savedControl.value) }
      : initialControl;
    const points = control.axis === "x"
      ? [a, exit, { x: control.value, y: exit.y }, { x: control.value, y: entry.y }, entry, b]
      : [a, exit, { x: exit.x, y: control.value }, { x: entry.x, y: control.value }, entry, b];
    const junctionMidpoint = (start, end) => snap((start + end) / 2);
    const junction = control.axis === "x"
      ? { x: control.value, y: junctionMidpoint(exit.y, entry.y) }
      : { x: junctionMidpoint(exit.x, entry.x), y: control.value };
    const cleanPoints = removeCollinearPoints(points);
    return {
      points: cleanPoints,
      path: cleanPoints.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" "),
      junction,
      control
    };
  }

  function sideFacing(point, target) {
    const dx = point.x - target.x;
    const dy = point.y - target.y;
    return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "top" : "bottom");
  }

  function connectionGeometry(connection, cache, visiting = new Set()) {
    if (cache.has(connection.id)) return cache.get(connection.id);
    if (visiting.has(connection.id)) return null;
    visiting.add(connection.id);
    const from = state.blocks.find((block) => block.id === connection.from);
    if (!from) return null;
    normalizeDecisionSides(from);
    const fromSide = connectionFromSide(connection, from);
    const a = portPoint(from, fromSide);
    let b;
    let toSide;
    if (connection.toConnection) {
      const target = state.connections.find((item) => item.id === connection.toConnection);
      const targetGeometry = target ? connectionGeometry(target, cache, visiting) : null;
      if (!targetGeometry) return null;
      b = targetGeometry.junction;
      toSide = sideFacing(a, b);
    } else {
      const to = state.blocks.find((block) => block.id === connection.to);
      if (!to) return null;
      toSide = sides.includes(connection.toSide) ? connection.toSide : "top";
      b = portPoint(to, toSide);
    }
    const geometry = orthogonalGeometry(a, fromSide, b, toSide, connection.routeControl);
    cache.set(connection.id, geometry);
    visiting.delete(connection.id);
    return geometry;
  }

  function drawConnections() {
    const blockElements = [...canvas.querySelectorAll(".flow-block")];
    const contentWidth = blockElements.reduce((maximum, block) => Math.max(maximum, block.offsetLeft + block.offsetWidth + GRID_SIZE * 2), 0);
    const contentHeight = blockElements.reduce((maximum, block) => Math.max(maximum, block.offsetTop + block.offsetHeight + GRID_SIZE * 2), 0);
    const width = Math.max(canvas.clientWidth, contentWidth);
    const height = Math.max(canvas.clientHeight, contentHeight);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.style.width = `${width}px`;
    svg.style.height = `${height}px`;
    svg.innerHTML = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8a98a5"/></marker><marker id="arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#0f7b62"/></marker></defs>`;
    canvas.querySelectorAll(".connection-junction").forEach((node) => node.remove());
    const geometries = new Map();
    state.connections.forEach((connection) => connectionGeometry(connection, geometries));
    state.connections.forEach((connection) => {
      const geometry = geometries.get(connection.id);
      if (!geometry) return;
      const active = run.lastConnection && run.lastConnection.from === connection.from && run.lastConnection.branch === connection.branch;
      const selected = selectedConnectionId === connection.id;
      const hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      hitPath.setAttribute("d", geometry.path);
      hitPath.setAttribute("class", "connection-hit-path");
      hitPath.dataset.connectionId = connection.id;
      svg.appendChild(hitPath);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", geometry.path);
      path.setAttribute("class", `connection-path${active ? " active-path" : ""}${selected ? " selected-path" : ""}`);
      path.setAttribute("marker-end", active ? "url(#arrow-active)" : "url(#arrow)");
      svg.appendChild(path);
    });
    state.connections.forEach((connection) => {
      const geometry = geometries.get(connection.id);
      if (!geometry) return;
      const junction = document.createElement("button");
      junction.type = "button";
      junction.className = `connection-junction${selectedConnectionId === connection.id ? " selected" : ""}${routeDrag?.connectionId === connection.id ? " dragging" : ""}`;
      junction.dataset.connectionId = connection.id;
      junction.dataset.controlAxis = geometry.control.axis;
      junction.style.left = `${geometry.junction.x}px`;
      junction.style.top = `${geometry.junction.y}px`;
      junction.setAttribute("aria-label", "Controle da seta; arraste para ajustar ou use como junção");
      junction.title = "Arraste para ajustar a seta";
      canvas.appendChild(junction);
    });
  }

  function beginConnection(id, branch, side, port) {
    const block = state.blocks.find((item) => item.id === id);
    if (!block || block.type === "end") {
      toast("O bloco Fim só pode receber conexões.");
      return;
    }
    if (block.type === "decision" && !branch) {
      showBranchPicker(block, side, port);
      return;
    }
    selectedConnectionId = null;
    pendingConnection = { from: id, branch: branch || "next", fromSide: side };
    canvas.classList.add("connecting");
    document.querySelectorAll(".port.connecting").forEach((item) => item.classList.remove("connecting"));
    port.classList.add("connecting");
  }

  function showBranchPicker(block, side, port) {
    canvas.querySelectorAll(".branch-picker").forEach((node) => node.remove());
    const canvasRect = canvas.getBoundingClientRect();
    const portRect = port.getBoundingClientRect();
    const picker = document.createElement("div");
    picker.className = "branch-picker";
    picker.style.left = `${portRect.left - canvasRect.left + canvas.scrollLeft + portRect.width / 2}px`;
    picker.style.top = `${portRect.top - canvasRect.top + canvas.scrollTop + portRect.height / 2}px`;
    picker.innerHTML = '<span>Esta saída é</span><button type="button" data-pick-branch="true">V</button><button type="button" data-pick-branch="false">F</button>';
    picker.addEventListener("pointerdown", (event) => event.stopPropagation());
    picker.addEventListener("click", (event) => {
      const button = event.target.closest("[data-pick-branch]");
      if (!button) return;
      const branchName = button.dataset.pickBranch;
      changeDecisionSide(block, branchName, side);
    });
    canvas.appendChild(picker);
  }

  function removeConnections(predicate) {
    const removed = new Set(state.connections.filter(predicate).map((connection) => connection.id));
    let changed = true;
    while (changed) {
      changed = false;
      state.connections.forEach((connection) => {
        if (connection.toConnection && removed.has(connection.toConnection) && !removed.has(connection.id)) {
          removed.add(connection.id);
          changed = true;
        }
      });
    }
    state.connections = state.connections.filter((connection) => !removed.has(connection.id));
    if (removed.has(selectedConnectionId)) selectedConnectionId = null;
  }

  function replaceOutgoing(connection) {
    const existing = state.connections.find((item) => item.from === connection.from && item.branch === connection.branch);
    if (existing) {
      const index = state.connections.indexOf(existing);
      state.connections[index] = { ...connection, id: existing.id };
    } else state.connections.push({ ...connection, id: makeConnectionId() });
  }

  function completeConnection(targetId, toSide) {
    if (!pendingConnection) return;
    const target = state.blocks.find((block) => block.id === targetId);
    if (!target || target.type === "start") {
      toast("O bloco Início não pode receber conexões.");
      return;
    }
    replaceOutgoing({ ...pendingConnection, to: targetId, toSide });
    pendingConnection = null;
    resetExecution(false);
    render();
  }

  function completeConnectionToConnection(connectionId) {
    if (!pendingConnection) return;
    const target = state.connections.find((connection) => connection.id === connectionId);
    if (!target) return;
    replaceOutgoing({ ...pendingConnection, toConnection: connectionId });
    pendingConnection = null;
    resetExecution(false);
    render();
  }

  function removeSelected() {
    if (!selectedId) return;
    state.blocks = state.blocks.filter((block) => block.id !== selectedId);
    removeConnections((connection) => connection.from === selectedId || connection.to === selectedId);
    selectedId = null;
    editingId = null;
    resetExecution(false);
    selectBlock(null);
    render();
  }

  function entryStart() {
    const calledNames = new Set(state.blocks
      .filter((block) => block.type === "call")
      .map((block) => block.code.trim()));
    const starts = state.blocks.filter((block) => block.type === "start");
    return starts.find((block) => !calledNames.has(block.code.trim())) || starts[0] || null;
  }

  function resetExecution(showMessage = true) {
    run = freshRun();
    const start = entryStart();
    run.currentId = start ? start.id : null;
    $("#runBadge").textContent = "NÃO INICIADO";
    $("#runBadge").className = "run-badge";
    $("#stepRun").disabled = false;
    renderHistory();
    render();
    if (showMessage) toast("Execução reiniciada.");
  }

  function setRunStatus(text, mode) {
    $("#runBadge").textContent = text;
    $("#runBadge").className = `run-badge ${mode || ""}`;
  }

  function step() {
    if (run.ended) {
      toast("O fluxo terminou. Clique em Reiniciar para executar novamente.");
      return;
    }
    if (!run.currentId) {
      const start = entryStart();
      if (!start) return runError("Adicione um bloco Início.");
      run.currentId = start.id;
    }
    const block = state.blocks.find((item) => item.id === run.currentId);
    if (!block) return runError("O próximo bloco não existe.");

    let branch = "next";
    let pathLabel = "—";
    const assignedVariables = [];
    let callEntry = null;
    let returnFrame = null;
    try {
      if (block.type === "assignment") {
        assignmentLines(block.code).forEach((line, index) => {
          const assignment = parseAssignment(line, index);
          const value = evaluate(assignment.valueSource, run.variables, false);
          if (assignment.indexSource !== undefined) {
            if (typeof value !== "number") throw new Error(`Linha ${index + 1}: cada posição da lista precisa receber um número.`);
            const listIndex = validateListIndex(evaluate(assignment.indexSource, run.variables, false));
            const current = run.variables[assignment.name];
            if (current !== undefined && !Array.isArray(current)) throw new Error(`A variável “${assignment.name}” não é uma lista.`);
            const list = current || [];
            list[listIndex] = value;
            run.variables[assignment.name] = list;
          } else {
            if (typeof value !== "number" && !Array.isArray(value)) throw new Error(`Linha ${index + 1}: a ação precisa resultar em um número ou uma lista.`);
            run.variables[assignment.name] = value;
          }
          if (!assignedVariables.includes(assignment.name)) assignedVariables.push(assignment.name);
        });
      } else if (block.type === "decision") {
        const result = evaluate(block.code, run.variables, true);
        branch = result ? "true" : "false";
        pathLabel = result ? "Verdadeiro" : "Falso";
      } else if (block.type === "call") {
        const name = block.code.trim();
        const matches = state.blocks.filter((item) => item.type === "start" && item.code.trim() === name);
        if (!matches.length) throw new Error(`não existe um bloco Início chamado “${name}”.`);
        if (matches.length > 1) throw new Error(`há mais de um bloco Início chamado “${name}”.`);
        const connection = state.connections.find((item) => item.from === block.id && item.branch === "next");
        if (!connection) throw new Error("conecte o bloco ao ponto para onde a execução deve retornar.");
        const returnId = resolveConnectionTarget(connection);
        if (!returnId) throw new Error("a conexão de retorno não leva a um bloco válido.");
        const entryConnection = state.connections.find((item) => item.from === matches[0].id && item.branch === "next");
        if (!entryConnection) throw new Error(`o Início “${name}” não está conectado ao primeiro bloco do subfluxo.`);
        const entryId = resolveConnectionTarget(entryConnection);
        if (!entryId) throw new Error(`a saída do Início “${name}” não leva a um bloco válido.`);
        callEntry = { currentId: entryId, connection: entryConnection };
        returnFrame = { currentId: returnId, connectionId: connection.id };
      }
    } catch (error) {
      return runError(`${typeNames[block.type]}: ${error.message}`);
    }

    run.history.push({ step: run.history.length + 1, block: block.code, path: pathLabel, variables: snapshotVariables(run.variables), assignedVariables });
    if (block.type === "end") {
      const frame = run.returnStack.pop();
      if (frame) {
        run.currentId = frame.currentId;
        run.lastConnection = state.connections.find((item) => item.id === frame.connectionId) || null;
        setRunStatus("EM EXECUÇÃO", "running");
      } else {
        run.ended = true;
        run.currentId = null;
        run.lastConnection = null;
        setRunStatus("CONCLUÍDO", "ended");
      }
    } else if (block.type === "call") {
      run.returnStack.push(returnFrame);
      run.currentId = callEntry.currentId;
      run.lastConnection = callEntry.connection;
      setRunStatus("EM EXECUÇÃO", "running");
    } else {
      const expectedSide = block.type === "decision"
        ? branch === "true" ? block.trueSide : block.falseSide
        : null;
      const connection = state.connections.find((item) => item.from === block.id && (
        block.type === "decision" ? item.fromSide === expectedSide : item.branch === branch
      ));
      if (!connection) {
        renderHistory();
        render();
        return runError(block.type === "decision" ? `Conecte a saída ${pathLabel}.` : "Conecte este bloco ao próximo.");
      }
      run.lastConnection = connection;
      run.currentId = resolveConnectionTarget(connection);
      if (!run.currentId) {
        renderHistory();
        render();
        return runError("A conexão de retorno não leva a um bloco válido.");
      }
      setRunStatus("EM EXECUÇÃO", "running");
    }
    renderHistory();
    render();
  }

  function resolveConnectionTarget(connection, visited = new Set()) {
    if (!connection || visited.has(connection.id)) return null;
    if (connection.to) return connection.to;
    visited.add(connection.id);
    return resolveConnectionTarget(state.connections.find((item) => item.id === connection.toConnection), visited);
  }

  function runError(message) {
    setRunStatus("ERRO", "error");
    toast(message);
    render();
  }

  function renderHistory() {
    const variables = [];
    run.history.forEach((row) => Object.keys(row.variables).forEach((name) => {
      if (!variables.includes(name)) variables.push(name);
    }));
    $("#historyHead").innerHTML = `<tr><th>Passo</th><th>Bloco executado</th>${variables.map((name) => `<th class="variable-heading">${escapeHtml(name)}</th>`).join("")}</tr>`;
    if (!run.history.length) {
      $("#historyBody").innerHTML = `<tr class="blank-row"><td colspan="${2 + variables.length}">Clique em <strong>Passo</strong> para iniciar a execução.</td></tr>`;
      return;
    }
    $("#historyBody").innerHTML = run.history.map((row) => {
      const values = variables.map((name) => {
        const exists = Object.hasOwn(row.variables, name);
        const assigned = exists && row.assignedVariables?.includes(name);
        return `<td>${assigned ? formatHistoryValue(row.variables[name]) : ""}</td>`;
      }).join("");
      const decisionResult = row.path === "Verdadeiro"
        ? '<span class="decision-result true-result" aria-label="Verdadeiro">(V)</span>'
        : row.path === "Falso"
          ? '<span class="decision-result false-result" aria-label="Falso">(F)</span>'
          : "";
      return `<tr><td>${row.step}</td><td><div class="history-block-cell"><code>${escapeHtml(row.block)}</code>${decisionResult}</div></td>${values}</tr>`;
    }).join("");
    const wrap = $(".table-wrap");
    wrap.scrollTop = wrap.scrollHeight;
  }

  function tokenize(source) {
    const tokens = [];
    let index = 0;
    while (index < source.length) {
      const rest = source.slice(index);
      const space = rest.match(/^\s+/);
      if (space) { index += space[0].length; continue; }
      const number = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
      if (number) { tokens.push({ type: "number", value: Number(number[0]) }); index += number[0].length; continue; }
      const name = rest.match(/^[A-Za-z_]\w*/);
      if (name) { tokens.push({ type: "name", value: name[0] }); index += name[0].length; continue; }
      const op = rest.match(/^(<=|>=|!=|[+\-*/%<>=(),]|\[|\])/);
      if (op) { tokens.push({ type: "op", value: op[0] }); index += op[0].length; continue; }
      throw new Error(`Símbolo inválido: “${rest[0]}”.`);
    }
    return tokens;
  }

  function evaluate(source, variables, requireComparison) {
    const tokens = tokenize(source);
    let at = 0;
    const peek = () => tokens[at];
    const take = () => tokens[at++];
    const primary = () => {
      const token = take();
      if (!token) throw new Error("Expressão incompleta.");
      if (token.type === "number") return token.value;
      if (token.value === "[") {
        const values = [];
        if (peek()?.value === "]") {
          take();
          return values;
        }
        while (true) {
          const value = sum();
          if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Cada item da lista precisa resultar em um número.");
          values.push(value);
          if (peek()?.value === "]") {
            take();
            return values;
          }
          if (!peek() || take().value !== ",") throw new Error("Separe os itens da lista com vírgulas e feche a lista com ].");
          if (peek()?.value === "]") throw new Error("Não deixe uma vírgula no final da lista.");
        }
      }
      if (token.type === "name") {
        if (!Object.hasOwn(variables, token.value)) throw new Error(`A variável “${token.value}” ainda não recebeu valor.`);
        const value = variables[token.value];
        if (peek()?.value === "[") {
          take();
          const index = validateListIndex(sum());
          if (!peek() || take().value !== "]") throw new Error("Falta fechar o índice da lista com ].");
          if (!Array.isArray(value)) throw new Error(`A variável “${token.value}” não é uma lista.`);
          if (!Object.hasOwn(value, index)) throw new Error(`A posição ${token.value}[${index}] ainda não recebeu valor.`);
          return value[index];
        }
        if (Array.isArray(value)) throw new Error(`Use ${token.value}[índice] para acessar um elemento da lista.`);
        return value;
      }
      if (token.value === "(") {
        const value = comparison();
        if (!peek() || take().value !== ")") throw new Error("Falta fechar parênteses.");
        return value;
      }
      throw new Error("Era esperado um número, variável ou parênteses.");
    };
    const unary = () => {
      if (peek() && ["+", "-"].includes(peek().value)) {
        const op = take().value;
        const value = unary();
        if (typeof value !== "number") throw new Error("Listas não podem receber sinal positivo ou negativo.");
        return op === "-" ? -value : value;
      }
      return primary();
    };
    const product = () => {
      let value = unary();
      while (peek() && ["*", "/", "%"].includes(peek().value)) {
        const op = take().value;
        const right = unary();
        if (typeof value !== "number" || typeof right !== "number") throw new Error("Listas não podem ser usadas em operações aritméticas.");
        if ((op === "/" || op === "%") && right === 0) throw new Error("Divisão por zero.");
        value = op === "*" ? value * right : op === "/" ? value / right : value % right;
      }
      return value;
    };
    const sum = () => {
      let value = product();
      while (peek() && ["+", "-"].includes(peek().value)) {
        const op = take().value;
        const right = product();
        if (typeof value !== "number" || typeof right !== "number") throw new Error("Listas não podem ser usadas em operações aritméticas.");
        value = op === "+" ? value + right : value - right;
      }
      return value;
    };
    let compared = false;
    const comparison = () => {
      let left = sum();
      if (peek() && ["<", "<=", ">", ">=", "=", "!="].includes(peek().value)) {
        compared = true;
        const op = take().value;
        const right = sum();
        if (typeof left !== "number" || typeof right !== "number") throw new Error("Listas não podem ser comparadas diretamente.");
        left = op === "<" ? left < right : op === "<=" ? left <= right : op === ">" ? left > right : op === ">=" ? left >= right : op === "=" ? left === right : left !== right;
      }
      return left;
    };
    const result = comparison();
    if (at < tokens.length) throw new Error(`Trecho inesperado: “${tokens[at].value}”.`);
    if (requireComparison && !compared) throw new Error("A decisão precisa usar um operador de comparação.");
    if (!Array.isArray(result) && !Number.isFinite(result) && typeof result !== "boolean") throw new Error("O resultado não é um número válido.");
    return result;
  }

  function saveJson() {
    const blocks = state.blocks.map(({ layoutWidth, layoutHeight, ...block }) => block);
    const payload = JSON.stringify({ version: 5, title: "Fluxograma", blocks, connections: state.connections }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "fluxograma.json";
    anchor.click();
    URL.revokeObjectURL(url);
    toast("Fluxograma salvo em JSON.");
  }

  function loadJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        validateFlow(data);
        state = {
          blocks: data.blocks.map((block) => {
            const { layoutWidth, layoutHeight, ...savedBlock } = block;
            const normalized = { ...savedBlock, x: snap(block.x, GRID_SIZE), y: snap(block.y, GRID_SIZE) };
            if (normalized.type === "decision") normalizeDecisionSides(normalized);
            return normalized;
          }),
          connections: data.connections.map((connection) => ({
            ...connection,
            id: connection.id || makeConnectionId(),
            fromSide: sides.includes(connection.fromSide) ? connection.fromSide : connection.branch === "true" ? "right" : connection.branch === "false" ? "left" : "bottom",
            ...(connection.to ? { toSide: sides.includes(connection.toSide) ? connection.toSide : "top" } : {}),
            ...(connection.routeControl ? { routeControl: { axis: connection.routeControl.axis, value: snap(connection.routeControl.value) } } : {})
          }))
        };
        selectedId = null;
        pendingConnection = null;
        selectBlock(null);
        resetExecution(false);
        toast("Fluxograma carregado.");
      } catch (error) { toast(`Não foi possível carregar: ${error.message}`); }
    };
    reader.readAsText(file);
  }

  function validateFlow(data) {
    if (!data || !Array.isArray(data.blocks) || !Array.isArray(data.connections)) throw new Error("arquivo JSON incompatível.");
    const ids = new Set();
    data.blocks.forEach((block) => {
      if (!block.id || ids.has(block.id) || !Object.hasOwn(typeNames, block.type) || typeof block.code !== "string" || !Number.isFinite(block.x) || !Number.isFinite(block.y)) throw new Error("há um bloco inválido.");
      if (block.trueSide !== undefined && !sides.includes(block.trueSide)) throw new Error("há uma saída de decisão inválida.");
      if (block.falseSide !== undefined && !sides.includes(block.falseSide)) throw new Error("há uma saída de decisão inválida.");
      ids.add(block.id);
    });
    const connectionIds = new Set();
    data.connections.forEach((connection) => {
      if (connection.id && connectionIds.has(connection.id)) throw new Error("há identificadores de conexão repetidos.");
      if (connection.id) connectionIds.add(connection.id);
    });
    data.connections.forEach((connection) => {
      const validTarget = connection.to ? ids.has(connection.to) : typeof connection.toConnection === "string" && connectionIds.has(connection.toConnection);
      if (!ids.has(connection.from) || !validTarget || !["next", "true", "false"].includes(connection.branch)) throw new Error("há uma conexão inválida.");
      if (connection.fromSide !== undefined && !sides.includes(connection.fromSide)) throw new Error("há um lado de conexão inválido.");
      if (connection.toSide !== undefined && !sides.includes(connection.toSide)) throw new Error("há um lado de conexão inválido.");
      if (connection.routeControl !== undefined
        && (!connection.routeControl || !["x", "y"].includes(connection.routeControl.axis) || !Number.isFinite(connection.routeControl.value))) {
        throw new Error("há um controle de seta inválido.");
      }
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }
  function formatNumber(value) { return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(8))); }
  function formatList(value, start = 0) {
    const entries = [];
    for (let index = start; index < value.length; index += 1) {
      entries.push(Object.hasOwn(value, index) ? formatNumber(value[index]) : "—");
    }
    return `[${entries.join(", ")}]`;
  }
  function formatHistoryValue(value) {
    if (!Array.isArray(value)) return formatNumber(value);
    const full = formatList(value);
    const visible = value.length > 6 ? `[…, ${formatList(value, value.length - 6).slice(1)}` : full;
    const label = `Lista completa: ${full}`;
    return `<span class="list-value" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${escapeHtml(visible)}</span>`;
  }
  function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
  }

  document.querySelectorAll("[data-add]").forEach((button) => button.addEventListener("click", () => addBlock(button.dataset.add)));
  $("#stepRun").addEventListener("click", step);
  $("#resetRun").addEventListener("click", () => resetExecution(true));
  $("#deleteSelected").addEventListener("click", removeSelected);
  $("#togglePalette").addEventListener("click", () => {
    const collapsed = palette.classList.toggle("collapsed");
    appShell.classList.toggle("palette-collapsed", collapsed);
    const button = $("#togglePalette");
    button.setAttribute("aria-expanded", String(!collapsed));
    button.setAttribute("aria-label", collapsed ? "Expandir blocos" : "Recolher blocos");
    button.title = collapsed ? "Expandir blocos" : "Recolher blocos";
    scheduleDrawConnections();
    setTimeout(() => {
      const currentWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--history-width")) || 330;
      setHistoryWidth(currentWidth, false);
      scheduleDrawConnections();
    }, 250);
  });
  $("#toggleHistory").addEventListener("click", () => setHistoryCollapsed(!historyPanel.classList.contains("collapsed"), true));

  historyResize.addEventListener("pointerdown", (event) => {
    if (window.innerWidth <= 800) return;
    panelResize = { pointerId: event.pointerId, startX: event.clientX, startWidth: $(".history").getBoundingClientRect().width };
    historyResize.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-history");
    event.preventDefault();
  });
  historyResize.addEventListener("pointermove", (event) => {
    if (!panelResize || panelResize.pointerId !== event.pointerId) return;
    setHistoryWidth(panelResize.startWidth - (event.clientX - panelResize.startX), false);
  });
  historyResize.addEventListener("pointerup", (event) => {
    if (!panelResize || panelResize.pointerId !== event.pointerId) return;
    panelResize = null;
    document.body.classList.remove("resizing-history");
    const width = $(".history").getBoundingClientRect().width;
    setHistoryWidth(width, true);
  });
  historyResize.addEventListener("pointercancel", () => {
    if (!panelResize) return;
    panelResize = null;
    document.body.classList.remove("resizing-history");
    setHistoryWidth($(".history").getBoundingClientRect().width, true);
  });
  historyResize.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const currentWidth = $(".history").getBoundingClientRect().width;
    setHistoryWidth(currentWidth + (event.key === "ArrowLeft" ? 20 : -20), true);
    event.preventDefault();
  });
  historyResize.addEventListener("dblclick", () => setHistoryWidth(330, true));
  $("#saveFlow").addEventListener("click", saveJson);
  $("#loadFlow").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", (event) => {
    if (event.target.files[0]) loadJson(event.target.files[0]);
    event.target.value = "";
  });
  $("#newFlow").addEventListener("click", () => {
    if (state.blocks.length && !window.confirm("Criar um fluxograma vazio? O atual continuará disponível apenas se já tiver sido salvo.")) return;
    state = { blocks: [], connections: [] };
    selectedId = null;
    selectedConnectionId = null;
    editingId = null;
    pendingConnection = null;
    selectBlock(null);
    resetExecution(false);
  });

  function changeDecisionSide(block, branch, newSide) {
    if (!block || !sides.includes(newSide)) return;
    normalizeDecisionSides(block);
    const key = branch === "true" ? "trueSide" : "falseSide";
    const otherKey = branch === "true" ? "falseSide" : "trueSide";
    const previousSide = block[key];
    if (block[otherKey] === newSide) block[otherKey] = previousSide;
    block[key] = newSide;
    state.connections.filter((connection) => connection.from === block.id).forEach((connection) => { delete connection.routeControl; });
    resetExecution(false);
  }

  canvas.addEventListener("pointerdown", (event) => {
    const connectionPath = event.target.closest(".connection-hit-path");
    if (connectionPath) {
      event.stopPropagation();
      event.preventDefault();
      if (!finishInlineEdit(false)) return;
      pendingConnection = null;
      selectedId = null;
      selectedConnectionId = connectionPath.dataset.connectionId;
      $("#deleteSelected").disabled = true;
      scheduleDrawConnections();
      return;
    }
    const junction = event.target.closest(".connection-junction");
    if (junction) {
      event.stopPropagation();
      if (pendingConnection) completeConnectionToConnection(junction.dataset.connectionId);
      else {
        const connection = state.connections.find((item) => item.id === junction.dataset.connectionId);
        const axis = junction.dataset.controlAxis;
        if (!connection || !["x", "y"].includes(axis)) return;
        selectedId = null;
        selectedConnectionId = connection.id;
        $("#deleteSelected").disabled = true;
        routeDrag = { connectionId: connection.id, pointerId: event.pointerId, axis };
        document.body.classList.add("dragging-route");
        event.preventDefault();
      }
      return;
    }
    if (event.target.closest(".inline-editor")) return;
    const port = event.target.closest(".port");
    const blockEl = event.target.closest(".flow-block");
    if (port && blockEl) {
      event.stopPropagation();
      if (pendingConnection) completeConnection(blockEl.dataset.id, port.dataset.side);
      else beginConnection(blockEl.dataset.id, port.dataset.branch, port.dataset.side, port);
      return;
    }
    if (!blockEl) {
      if (!finishInlineEdit(false)) return;
      pendingConnection = null;
      selectBlock(null);
      render();
      return;
    }
    if (pendingConnection) {
      toast("Clique em um dos quatro pontos do bloco de destino.");
      return;
    }
    if (editingId && editingId !== blockEl.dataset.id && !finishInlineEdit(false)) return;
    selectBlock(blockEl.dataset.id);
    const block = state.blocks.find((item) => item.id === blockEl.dataset.id);
    const rect = canvas.getBoundingClientRect();
    const localX = event.clientX - rect.left + canvas.scrollLeft;
    const localY = event.clientY - rect.top + canvas.scrollTop;
    drag = { id: block.id, pointerId: event.pointerId, dx: localX - block.x, dy: localY - block.y, startX: event.clientX, startY: event.clientY, moved: false };
    blockEl.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
    drag.moved = true;
    if (editingId) finishInlineEdit(false);
    const block = state.blocks.find((item) => item.id === drag.id);
    if (!block) return;
    const rect = canvas.getBoundingClientRect();
    const localX = event.clientX - rect.left + canvas.scrollLeft;
    const localY = event.clientY - rect.top + canvas.scrollTop;
    block.x = snap(localX - drag.dx, GRID_SIZE);
    block.y = snap(localY - drag.dy, GRID_SIZE);
    const el = canvas.querySelector(`[data-id="${CSS.escape(block.id)}"]`);
    el.style.left = `${block.x}px`;
    el.style.top = `${block.y}px`;
    scheduleDrawConnections();
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const id = drag.id;
    const moved = drag.moved;
    drag = null;
    if (!moved) startInlineEdit(id);
    else render();
  });
  window.addEventListener("pointermove", (event) => {
    if (!routeDrag || routeDrag.pointerId !== event.pointerId) return;
    const connection = state.connections.find((item) => item.id === routeDrag.connectionId);
    if (!connection) return;
    const rect = canvas.getBoundingClientRect();
    const localX = event.clientX - rect.left + canvas.scrollLeft;
    const localY = event.clientY - rect.top + canvas.scrollTop;
    const rawValue = routeDrag.axis === "x" ? localX : localY;
    connection.routeControl = { axis: routeDrag.axis, value: snap(rawValue) };
    scheduleDrawConnections();
    event.preventDefault();
  });
  function finishRouteDrag(event) {
    if (!routeDrag || routeDrag.pointerId !== event.pointerId) return;
    routeDrag = null;
    document.body.classList.remove("dragging-route");
    scheduleDrawConnections();
  }
  window.addEventListener("pointerup", finishRouteDrag);
  window.addEventListener("pointercancel", finishRouteDrag);
  canvas.addEventListener("keydown", (event) => {
    const junction = event.target.closest(".connection-junction");
    if (junction && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      const connection = state.connections.find((item) => item.id === junction.dataset.connectionId);
      const geometry = connection ? connectionGeometry(connection, new Map()) : null;
      const axis = geometry?.control.axis;
      const delta = axis === "x"
        ? (event.key === "ArrowLeft" ? -GRID_SIZE : event.key === "ArrowRight" ? GRID_SIZE : 0)
        : (event.key === "ArrowUp" ? -GRID_SIZE : event.key === "ArrowDown" ? GRID_SIZE : 0);
      if (connection && geometry && delta) {
        connection.routeControl = { axis, value: geometry.control.value + delta };
        event.preventDefault();
        scheduleDrawConnections();
      }
      return;
    }
    const editor = event.target.closest(".inline-editor");
    if (editor && event.key === "Enter" && !(editor.matches("textarea") && event.shiftKey)) {
      event.preventDefault();
      finishInlineEdit(false);
    } else if (editor && event.key === "Escape") {
      event.preventDefault();
      finishInlineEdit(true);
    }
  });
  canvas.addEventListener("input", (event) => {
    const editor = event.target.closest(".inline-editor");
    if (!editor) return;
    const blockEl = editor.closest(".flow-block.assignment, .flow-block.decision");
    if (!blockEl) return;
    const block = state.blocks.find((item) => item.id === blockEl.dataset.id);
    const dimensions = blockDimensions({ type: block.type, code: editor.value });
    const previousWidth = Number.isFinite(block?.layoutWidth) ? block.layoutWidth : GRID_SIZE * 8;
    const previousHeight = Number.isFinite(block?.layoutHeight) ? block.layoutHeight : blockDimensions(block).height;
    blockEl.style.left = `${snap((block?.x || 0) - (dimensions.width - previousWidth) / 2, 0)}px`;
    blockEl.style.top = `${snap((block?.y || 0) - (dimensions.height - previousHeight) / 2, 0)}px`;
    blockEl.style.width = `${dimensions.width}px`;
    blockEl.style.height = `${dimensions.height}px`;
    scheduleDrawConnections();
  });
  canvas.addEventListener("focusout", (event) => {
    if (event.target.matches(".inline-editor")) setTimeout(() => {
      if (editingId && !canvas.querySelector(".inline-editor:focus")) finishInlineEdit(false);
    }, 0);
  });
  canvas.addEventListener("keydown", (event) => {
    if ((event.key === "Delete" || event.key === "Backspace") && selectedId && !event.target.matches(".inline-editor")) { event.preventDefault(); removeSelected(); }
  });
  document.addEventListener("keydown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const isEditing = target?.closest("input, textarea, [contenteditable='true'], .inline-editor");
    if (event.key === "ArrowRight" && !event.defaultPrevented && !event.repeat && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !isEditing) {
      event.preventDefault();
      step();
      return;
    }
    if (event.key === "Escape" && (selectedId || selectedConnectionId) && !editingId) {
      selectBlock(null);
      render();
    }
  });
  window.addEventListener("resize", () => {
    const currentWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--history-width")) || 330;
    setHistoryWidth(currentWidth, false);
    scheduleDrawConnections();
  });

  const canvasResizeObserver = new ResizeObserver(() => {
    scheduleDrawConnections();
  });
  canvasResizeObserver.observe(canvas);

  try {
    const savedHistoryWidth = Number(localStorage.getItem("fluxo-history-width"));
    if (Number.isFinite(savedHistoryWidth) && savedHistoryWidth >= 250) setHistoryWidth(savedHistoryWidth, false);
    setHistoryCollapsed(localStorage.getItem("fluxo-history-collapsed") === "1", false);
  } catch (_) { /* Preferência opcional. */ }
  resetExecution(false);
})();
