/* =============================================================================
   Centro de Monitoreo Operativo · Aranda Service Desk · Punto UAO
   app.js — datos, KPIs, gráficos y tablas.

   FUENTES: data/casos.json y data/tareas.json (publicados por el pipeline
   CAE-data-pipeline en cada corrida de GitHub Actions).

   MODELO NUEVO (post-reestructuración de Aranda, sep-2026):
   - Ya no hay tres proyectos separados (PQRS/Servicios Financieros/CAE).
     Todos los casos vienen bajo un único Proyecto ("Punto UAO").
   - La clasificación temática ahora es 'Jerarquía' = Nivel1.Nivel2[.Nivel3][.Nivel4],
     ej. "Financiero.Matrícula financiera.Reliquidación de Matrícula Financiera".
     Nivel1 ∈ {Financiero, Tecnologías, Académicos, Bienestar} (confirmado con
     Natalia el 2026-sep); cualquier otro valor, o los casos históricos (que no
     traen Jerarquía en ese formato), caen en el bucket "Otros / Histórico".
   - Tareas es una fuente independiente (sin Progreso/SLA), con sus propios
     filtros y KPIs, y se cruza con Responsables por nombre (namesMatch).

   PROGRESO — escala sin confirmar oficialmente (ver notas del pipeline):
   - Histórico: 'progreso_raw' ya viene en la escala de "% sobre ANS" (puede
     superar 100).
   - Nuevo Aranda: 'progreso_raw' llega como fracción pequeña (0–70 aprox.) —
     se multiplica ×100 para llevarlo a la misma escala. Es una inferencia
     confirmada solo con una muestra de 50 casos; revisar con más volumen.
   ============================================================================= */

(function () {
  "use strict";

  /* ============================ CONFIGURACIÓN ============================ */

  const CONFIG = {
    casosSource: "data/casos.json",
    tareasSource: "data/tareas.json",
    refreshIntervalMs: 5 * 60 * 1000
  };

  const NIVEL1_CATS = ["Financiero", "Tecnologías", "Académicos", "Bienestar"];
  const NIVEL1_OTROS = "Otros / Histórico";
  const NIVEL1_KEY = { "Financiero": "financiero", "Tecnologías": "tecnologias", "Académicos": "academicos", "Bienestar": "bienestar" };
  const NIVEL1_ICON = { "Financiero": "bi-cash-coin", "Tecnologías": "bi-cpu", "Académicos": "bi-mortarboard", "Bienestar": "bi-heart-pulse" };

  const STATUS_COLORS = { "Normal": "#9C8C7E", "Riesgo": "#D9A441", "Critico": "#C0151A", "Vencido": "#4A0608" };
  const STATUS_LABELS = { "Normal": "Normal", "Riesgo": "Riesgo", "Critico": "Crítico", "Vencido": "Vencido" };
  const ESTADOS_ABIERTOS_CASOS = ["En Espera", "En Proceso", "Registrado"];

  const SERIES_PALETTE = ["#8C0F13", "#C0151A", "#D9A441", "#9C8C7E", "#4A0608", "#B5654A", "#6B5E54", "#D9B68B", "#7A1E22", "#C98A3E"];

  const VIEW_TITLES = {
    resumen: "Resumen ejecutivo",
    casos: "Casos",
    tareas: "Tareas",
    responsables: "Gestión de Responsables",
    grupos: "Comparativa por Grupos",
    atencion: "Atención Prioritaria",
    solucionados: "Solucionados"
  };

  const DT_LANG_ES = {
    search: "Buscar:", lengthMenu: "Mostrar _MENU_ registros",
    info: "Mostrando _START_ a _END_ de _TOTAL_ registros", infoEmpty: "Mostrando 0 a 0 de 0 registros",
    infoFiltered: "(filtrado de _MAX_ registros totales)", zeroRecords: "No se encontraron registros coincidentes",
    emptyTable: "No hay datos disponibles",
    paginate: { first: "Primero", last: "Último", next: "Siguiente", previous: "Anterior" },
    processing: "Procesando…"
  };

  /* ============================== ESTADO ============================== */

  const STATE = {
    rawCasos: [], rawTareas: [],
    casos: [], tareas: [],
    errorCasos: null, errorTareas: null,
    statsCasos: {}, statsTareas: {},
    lastUpdated: null, firstLoadDone: false
  };

  const CASOS_FILTER = { nivel1: [], nivel2: [], nivel3: [], grupo: [], responsable: [], estado: [], fuente: [], tipoRegistro: [], condicion: [], fechaDesde: "", fechaHasta: "" };
  const TAREAS_FILTER = { tipoServicio: [], linea: [], causa: [], criterios: [], responsable: [], estado: [], fechaDesde: "", fechaHasta: "" };
  const RESP_FILTER = { responsable: [], grupo: [], fechaDesde: "", fechaHasta: "" };
  const GRUPO_FILTER = { grupo: [], nivel1: [], fechaDesde: "", fechaHasta: "" };

  const ESTADOS_CERRADOS = ["Solucionado", "Cerrado", "Anulado"];

  const chartRegistry = {};
  const dtRegistry = {};
  let _casosActiveCat = null;     // nivel1 seleccionado por tarjeta en la pestaña Casos
  let _respDetalleActual = null;
  let _respDetalleTab = "casos";  // "casos" | "tareas" dentro del panel de detalle
  let TENDENCY_PERIOD = "semana";

  /* ============================ UTILIDADES ============================ */

  function esc(str) {
    if (str === null || str === undefined) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function pct(n, total) { return !total ? 0 : Math.round((n / total) * 1000) / 10; }

  function countBy(records, field) {
    const counts = {};
    records.forEach(function (r) {
      const key = (r[field] === undefined || r[field] === null || r[field] === "") ? "Sin dato" : r[field];
      counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
  }
  function topEntry(countsObj) {
    let bestKey = null, bestCount = -1;
    Object.keys(countsObj).forEach(function (k) { if (countsObj[k] > bestCount) { bestCount = countsObj[k]; bestKey = k; } });
    return bestKey === null ? { key: "—", count: 0 } : { key: bestKey, count: bestCount };
  }
  function sortedEntries(countsObj, limit) {
    const entries = Object.keys(countsObj).map(function (k) { return [k, countsObj[k]]; });
    entries.sort(function (a, b) { return b[1] - a[1]; });
    return limit ? entries.slice(0, limit) : entries;
  }
  function toChartDataDoughnut(counts, labelMap, colorMap) {
    const keys = Object.keys(counts);
    return { labels: keys.map(function (k) { return labelMap ? (labelMap[k] || k) : k; }),
      datasets: [{ data: keys.map(function (k) { return counts[k]; }),
        backgroundColor: keys.map(function (k, i) { return colorMap ? (colorMap[k] || SERIES_PALETTE[i % SERIES_PALETTE.length]) : SERIES_PALETTE[i % SERIES_PALETTE.length]; }),
        borderWidth: 0 }] };
  }
  function toChartDataBar(counts, color, limit) {
    const entries = sortedEntries(counts, limit || 10);
    return { labels: entries.map(function (e) { return e[0]; }),
      datasets: [{ data: entries.map(function (e) { return e[1]; }), backgroundColor: color || "#8C0F13", borderRadius: 4, maxBarThickness: 26 }] };
  }
  function toChartDataBarMulti(counts, limit) {
    const entries = sortedEntries(counts, limit || 10);
    return { labels: entries.map(function (e) { return e[0]; }),
      datasets: [{ data: entries.map(function (e) { return e[1]; }),
        backgroundColor: entries.map(function (e, i) { return SERIES_PALETTE[i % SERIES_PALETTE.length]; }), borderRadius: 4, maxBarThickness: 26 }] };
  }

  function weekLabel(d) { return d.toLocaleDateString("es-CO", { day: "2-digit", month: "short" }); }

  function isoToday() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function getDailyCountsRange(records, fromISO, toISO, dateField) {
    const from = new Date(fromISO + "T00:00:00"), to = new Date(toISO + "T00:00:00");
    const buckets = []; const cur = new Date(from);
    while (cur <= to) {
      const y = cur.getFullYear(), m = String(cur.getMonth() + 1).padStart(2, "0"), d = String(cur.getDate()).padStart(2, "0");
      buckets.push({ dateStr: y + "-" + m + "-" + d, label: cur.toLocaleDateString("es-CO", { day: "2-digit", month: "short" }), count: 0 });
      cur.setDate(cur.getDate() + 1);
    }
    records.forEach(function (r) {
      const fr = r[dateField]; if (!fr) return;
      for (let i = 0; i < buckets.length; i++) { if (fr === buckets[i].dateStr) { buckets[i].count++; break; } }
    });
    return buckets;
  }
  function getWeeklyCountsRange(records, fromISO, toISO, dateField) {
    const from = new Date(fromISO + "T00:00:00"), to = new Date(toISO + "T00:00:00");
    const buckets = []; const cur = new Date(from);
    while (cur <= to) {
      const wEnd = new Date(cur); wEnd.setDate(cur.getDate() + 6);
      buckets.push({ start: new Date(cur), end: wEnd > to ? new Date(to) : new Date(wEnd), label: weekLabel(cur), count: 0 });
      cur.setDate(cur.getDate() + 7);
    }
    records.forEach(function (r) {
      const fr = r[dateField]; if (!fr) return;
      const d = new Date(fr + "T00:00:00");
      for (let i = 0; i < buckets.length; i++) { if (d >= buckets[i].start && d <= buckets[i].end) { buckets[i].count++; break; } }
    });
    return buckets;
  }
  function getMonthlyCountsRange(records, fromISO, toISO, dateField) {
    const from = new Date(fromISO + "T00:00:00"), to = new Date(toISO + "T00:00:00");
    const buckets = []; let yr = from.getFullYear(), mo = from.getMonth();
    const eYr = to.getFullYear(), eMo = to.getMonth();
    while (yr < eYr || (yr === eYr && mo <= eMo)) {
      const start = new Date(yr, mo, 1), end = new Date(yr, mo + 1, 0);
      buckets.push({ start: start, end: end, label: start.toLocaleDateString("es-CO", { month: "short", year: "2-digit" }), count: 0 });
      mo++; if (mo > 11) { mo = 0; yr++; }
    }
    records.forEach(function (r) {
      const fr = r[dateField]; if (!fr) return;
      const d = new Date(fr + "T00:00:00");
      for (let i = 0; i < buckets.length; i++) { if (d >= buckets[i].start && d <= buckets[i].end) { buckets[i].count++; break; } }
    });
    return buckets;
  }
  function getYearlyCounts(records, dateField) {
    const map = {};
    records.forEach(function (r) { const fr = r[dateField]; if (!fr) return; map[fr.substring(0, 4)] = (map[fr.substring(0, 4)] || 0) + 1; });
    return Object.keys(map).sort().map(function (y) { return { label: y, count: map[y] }; });
  }
  function getTendenciaCounts(records, period, dateField, filterObj) {
    if (period === "año") return getYearlyCounts(records, dateField);
    const hoy = isoToday();
    const hasta = (filterObj && filterObj.fechaHasta) || hoy;
    let desde = filterObj && filterObj.fechaDesde;
    if (!desde) {
      const d = new Date();
      if (period === "día") d.setDate(d.getDate() - 29);
      else if (period === "mes") { d.setMonth(d.getMonth() - 11); d.setDate(1); }
      else d.setDate(d.getDate() - 83);
      desde = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }
    if (period === "día") return getDailyCountsRange(records, desde, hasta, dateField);
    if (period === "mes") return getMonthlyCountsRange(records, desde, hasta, dateField);
    return getWeeklyCountsRange(records, desde, hasta, dateField);
  }
  function buildPeriodBtnsHTML() {
    return '<div class="tend-period-btns">' + [["día", "Días"], ["semana", "Semanas"], ["mes", "Meses"], ["año", "Años"]].map(function (p) {
      return '<button class="tend-btn' + (TENDENCY_PERIOD === p[0] ? ' tend-btn--active' : '') + '" data-period="' + p[0] + '">' + p[1] + '</button>';
    }).join("") + '</div>';
  }
  function wireTendencyBtns(container) {
    if (!container) return;
    container.querySelectorAll(".tend-btn").forEach(function (btn) {
      btn.addEventListener("click", function () { TENDENCY_PERIOD = this.getAttribute("data-period"); renderAll(); });
    });
  }

  function kpi(label, value, variant, icon, foot, extraClass) {
    return ('<div class="kpi-card kpi-card--' + variant + (extraClass ? " " + extraClass : "") + '">' +
      '<div class="kpi-label"><i class="bi ' + icon + '"></i> ' + esc(label) + '</div>' +
      '<div class="kpi-value">' + esc(value) + '</div>' +
      (foot ? '<div class="kpi-foot">' + esc(foot) + '</div>' : '') + '</div>');
  }

  function progressCellHTML(progreso, cls) {
    const p = progreso === null || progreso === undefined ? 0 : progreso;
    const pctWidth = Math.max(4, Math.min(100, p));
    return ('<div class="progress-track"><div class="progress-fill progress-fill--' + cls.toLowerCase() + '" style="width:' + pctWidth + '%"></div></div>' +
      '<div class="progress-text">' + p.toFixed(1) + '%</div>');
  }

  function nivel1ChipHTML(n1) {
    const key = NIVEL1_KEY[n1] || "otro";
    return '<span class="chip-nivel1 chip-nivel1--' + key + '">' + esc(n1 || NIVEL1_OTROS) + '</span>';
  }

  /* ====================== CLASIFICACIÓN POR PROGRESO ====================== */
  /* Umbrales confirmados con Natalia (2026-sep): Normal <90, Riesgo 90-94,
     Crítico 95-97, Vencido ≥98 — sobre el Progreso ya normalizado a "%". */
  function effectiveProgreso(r) {
    if (r.progreso_raw === null || r.progreso_raw === undefined) return 0;
    // Nuevo Aranda: escala fracción -> ×100 (ver nota de cabecera; sin confirmar con volumen real)
    return r.fuente === "nuevo" ? r.progreso_raw * 100 : r.progreso_raw;
  }
  function classify(progreso) {
    if (progreso >= 98) return "Vencido";
    if (progreso >= 95) return "Critico";
    if (progreso >= 90) return "Riesgo";
    return "Normal";
  }
  function effectiveClass(r) {
    const e = r.estado;
    if (e === "Solucionado" || e === "Cerrado" || e === "Anulado") return "Normal";
    return classify(effectiveProgreso(r));
  }
  function nivel1Effective(r) {
    return NIVEL1_CATS.indexOf(r.nivel1) !== -1 ? r.nivel1 : NIVEL1_OTROS;
  }

  /* ====================== NOMBRES (cruce Casos ↔ Tareas) ====================== */
  const ACCENT_MAP = { "á": "a", "é": "e", "í": "i", "ó": "o", "ú": "u", "ñ": "n", "ü": "u" };
  function normalizeName(s) {
    return (s || "").toString().toLowerCase().replace(/[áéíóúñü]/g, function (c) { return ACCENT_MAP[c] || c; }).replace(/\s+/g, " ").trim();
  }
  function namesMatch(a, b) {
    const na = normalizeName(a), nb = normalizeName(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    return na.indexOf(nb) === 0 || nb.indexOf(na) === 0;
  }

  /* ====================== FILTROS: dropdown multi-select genérico ====================== */

  function buildMsDropHTML(key, label, icon, options, filterObj) {
    const sel = filterObj[key] || [];
    const badgeVis = (sel.length > 0 && sel.length < options.length) ? "" : "display:none";
    const optsHtml = options.map(function (opt) {
      const checked = sel.indexOf(opt) !== -1 ? " checked" : "";
      return '<label class="ms-opt"><input type="checkbox" class="ms-cb" value="' + esc(opt) + '"' + checked + '><span>' + esc(opt) + '</span></label>';
    }).join("");
    const allChecked = (sel.length === 0 || (options.length > 0 && sel.length === options.length)) ? " checked" : "";
    return ('<div class="ms-drop" data-key="' + key + '">' +
      '<button class="ms-toggle" type="button"><i class="bi ' + icon + '"></i><span class="ms-label">' + label + '</span>' +
      '<span class="ms-badge" style="' + badgeVis + '">' + sel.length + '</span><i class="bi bi-chevron-down ms-chevron"></i></button>' +
      '<div class="ms-panel" hidden><input class="ms-search" type="text" placeholder="Buscar…" autocomplete="off">' +
      '<div class="ms-opts-wrap"><label class="ms-opt ms-opt--all"><input type="checkbox" class="ms-cb-all"' + allChecked + '><span>Todos</span></label>' +
      optsHtml + '</div></div></div>');
  }

  function wireFilterBar(containerId, dropsId, filterObj, onChange, dateIds) {
    const bar = document.getElementById(dropsId);
    if (bar) {
      bar.querySelectorAll(".ms-drop").forEach(function (drop) {
        const key = drop.getAttribute("data-key");
        const toggle = drop.querySelector(".ms-toggle"), panel = drop.querySelector(".ms-panel");
        const searchEl = drop.querySelector(".ms-search"), allCb = drop.querySelector(".ms-cb-all"), badge = drop.querySelector(".ms-badge");
        toggle.addEventListener("click", function (e) {
          e.stopPropagation();
          const isOpen = !panel.hidden;
          closeAllDropdowns();
          if (!isOpen) { panel.hidden = false; drop.classList.add("is-open"); if (searchEl) { searchEl.value = ""; filterDropOptions(drop, ""); searchEl.focus(); } }
        });
        panel.addEventListener("click", function (e) { e.stopPropagation(); });
        if (searchEl) { searchEl.addEventListener("input", function () { filterDropOptions(drop, this.value); }); searchEl.addEventListener("click", function (e) { e.stopPropagation(); }); }
        if (allCb) allCb.addEventListener("change", function () {
          drop.querySelectorAll(".ms-cb").forEach(function (cb) { cb.checked = false; });
          this.checked = true; filterObj[key] = []; badge.style.display = "none"; badge.textContent = "0"; onChange();
        });
        drop.querySelectorAll(".ms-cb").forEach(function (cb) {
          cb.addEventListener("change", function () {
            const vals = []; drop.querySelectorAll(".ms-cb:checked").forEach(function (c) { vals.push(c.value); });
            filterObj[key] = vals;
            const totalOpts = drop.querySelectorAll(".ms-cb").length;
            if (allCb) allCb.checked = (vals.length === 0 || vals.length === totalOpts);
            badge.textContent = vals.length; badge.style.display = (vals.length > 0 && vals.length < totalOpts) ? "" : "none";
            onChange();
          });
        });
      });
    }
    (dateIds || []).forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", function () {
        filterObj.fechaDesde = document.getElementById(dateIds[0]) ? document.getElementById(dateIds[0]).value : "";
        filterObj.fechaHasta = document.getElementById(dateIds[1]) ? document.getElementById(dateIds[1]).value : "";
        onChange();
      });
    });
    if (!document._gfbOutside) { document._gfbOutside = true; document.addEventListener("click", closeAllDropdowns); }
  }
  function closeAllDropdowns() {
    document.querySelectorAll(".ms-panel").forEach(function (p) { p.hidden = true; });
    document.querySelectorAll(".ms-drop").forEach(function (d) { d.classList.remove("is-open"); });
  }
  function filterDropOptions(drop, q) {
    const lower = q.toLowerCase();
    drop.querySelectorAll(".ms-opt:not(.ms-opt--all)").forEach(function (opt) { opt.style.display = opt.textContent.trim().toLowerCase().indexOf(lower) !== -1 ? "" : "none"; });
  }

  /* ====================== APLICAR FILTROS ====================== */

  function applyCasosFilter() {
    STATE.casos = STATE.rawCasos.filter(function (r) {
      const n1 = nivel1Effective(r);
      if (CASOS_FILTER.nivel1.length && CASOS_FILTER.nivel1.indexOf(n1) === -1) return false;
      if (CASOS_FILTER.nivel2.length && CASOS_FILTER.nivel2.indexOf(r.nivel2) === -1) return false;
      // Nivel 3 se alimenta de 'categoria' (el nivel más específico que ya calcula Aranda),
      // no del nivel3 parseado de Jerarquía: éste queda vacío cuando la Jerarquía solo tiene
      // 2 niveles (ej. "Académicos.Grados" -> categoria="Grados", nivel3="N/A").
      if (CASOS_FILTER.nivel3.length && CASOS_FILTER.nivel3.indexOf(r.categoria) === -1) return false;
      if (CASOS_FILTER.grupo.length && CASOS_FILTER.grupo.indexOf(r.grupo_responsable) === -1) return false;
      if (CASOS_FILTER.responsable.length && CASOS_FILTER.responsable.indexOf(r.responsable) === -1) return false;
      if (CASOS_FILTER.estado.length && CASOS_FILTER.estado.indexOf(r.estado) === -1) return false;
      if (CASOS_FILTER.fuente.length && CASOS_FILTER.fuente.indexOf(r.fuente) === -1) return false;
      if (CASOS_FILTER.tipoRegistro.length && CASOS_FILTER.tipoRegistro.indexOf(r.tipo_registro) === -1) return false;
      if (CASOS_FILTER.condicion.length) {
        const cond = ESTADOS_CERRADOS.indexOf(r.estado) !== -1 ? "Cerrados" : "Abiertos";
        if (CASOS_FILTER.condicion.indexOf(cond) === -1) return false;
      }
      if (CASOS_FILTER.fechaDesde && (r.fecha_registro || "") < CASOS_FILTER.fechaDesde) return false;
      if (CASOS_FILTER.fechaHasta && (r.fecha_registro || "") > CASOS_FILTER.fechaHasta) return false;
      if (_casosActiveCat && n1 !== _casosActiveCat) return false;
      return true;
    });
  }
  function applyTareasFilter() {
    STATE.tareas = STATE.rawTareas.filter(function (t) {
      if (TAREAS_FILTER.tipoServicio.length && TAREAS_FILTER.tipoServicio.indexOf(t.tipo_servicio) === -1) return false;
      if (TAREAS_FILTER.linea.length && TAREAS_FILTER.linea.indexOf(t.linea_atencion) === -1) return false;
      if (TAREAS_FILTER.causa.length && TAREAS_FILTER.causa.indexOf(t.causa) === -1) return false;
      if (TAREAS_FILTER.criterios.length && TAREAS_FILTER.criterios.indexOf(t.criterios) === -1) return false;
      if (TAREAS_FILTER.responsable.length && TAREAS_FILTER.responsable.indexOf(t.responsable) === -1) return false;
      if (TAREAS_FILTER.estado.length && TAREAS_FILTER.estado.indexOf(t.estado) === -1) return false;
      if (TAREAS_FILTER.fechaDesde && (t.fecha_creacion || "") < TAREAS_FILTER.fechaDesde) return false;
      if (TAREAS_FILTER.fechaHasta && (t.fecha_creacion || "") > TAREAS_FILTER.fechaHasta) return false;
      return true;
    });
  }

  /* ====================== ESTADÍSTICAS DE CASOS ====================== */

  function computeCasosStats(records) {
    const total = records.length;
    let vencidos = 0, criticos = 0, riesgo = 0, normal = 0, sumTiempo = 0;
    const vencidosPorResponsable = {}, vencidosPorCategoria = {}, porNivel1 = {};
    records.forEach(function (r) {
      const cls = effectiveClass(r);
      if (cls === "Vencido") vencidos++; else if (cls === "Critico") criticos++; else if (cls === "Riesgo") riesgo++; else normal++;
      sumTiempo += (r.tiempo_transcurrido_dias || 0);
      const n1 = nivel1Effective(r);
      if (!porNivel1[n1]) porNivel1[n1] = { total: 0, vencidos: 0, criticos: 0, riesgo: 0 };
      porNivel1[n1].total++;
      if (cls === "Vencido") { porNivel1[n1].vencidos++; vencidosPorResponsable[r.responsable || "Sin asignar"] = (vencidosPorResponsable[r.responsable || "Sin asignar"] || 0) + 1; vencidosPorCategoria[r.categoria || "Sin categoría"] = (vencidosPorCategoria[r.categoria || "Sin categoría"] || 0) + 1; }
      else if (cls === "Critico") porNivel1[n1].criticos++;
      else if (cls === "Riesgo") porNivel1[n1].riesgo++;
    });
    return { total: total, vencidos: vencidos, criticos: criticos, riesgo: riesgo, normal: normal,
      avgTiempo: total ? Math.round((sumTiempo / total) * 10) / 10 : 0,
      vencidosPorResponsable: vencidosPorResponsable, vencidosPorCategoria: vencidosPorCategoria, porNivel1: porNivel1 };
  }

  // Una tarea cuenta como completada si su estado es Completada, Aprobado o Atendido.
  const ESTADOS_TAREA_COMPLETADA = ["Completada", "Aprobado", "Atendido"];
  function tareaCompletada(t) { return ESTADOS_TAREA_COMPLETADA.indexOf(t.estado) !== -1; }

  function computeTareasStats(records) {
    const total = records.length;
    let completadas = 0;
    const porCausa = {}, porLinea = {}, porResponsable = {};
    records.forEach(function (t) {
      if (tareaCompletada(t)) completadas++;
      porCausa[t.causa || "Sin causa"] = (porCausa[t.causa || "Sin causa"] || 0) + 1;
      porLinea[t.linea_atencion || "Sin canal"] = (porLinea[t.linea_atencion || "Sin canal"] || 0) + 1;
      porResponsable[t.responsable || "Sin asignar"] = (porResponsable[t.responsable || "Sin asignar"] || 0) + 1;
    });
    return { total: total, completadas: completadas, pendientes: total - completadas, porCausa: porCausa, porLinea: porLinea, porResponsable: porResponsable };
  }

  /* ============================ CHART.JS ============================ */

  function setChartDefaults() {
    if (typeof Chart === "undefined") return;
    Chart.defaults.font.family = "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";
    Chart.defaults.font.size = 11.5; Chart.defaults.color = "#4A3F38";
  }
  function renderChart(canvasId, type, data, options) {
    const el = document.getElementById(canvasId); if (!el) return null;
    if (chartRegistry[canvasId]) chartRegistry[canvasId].destroy();
    const ctx = el.getContext("2d"); el.classList.remove("chart-skeleton");
    chartRegistry[canvasId] = new Chart(ctx, { type: type, data: data, options: options || {} });
    return chartRegistry[canvasId];
  }
  function gridOpts() { return { color: "#EEEBE7", drawBorder: false }; }
  function horizontalBarOpts(extra) {
    return Object.assign({ indexAxis: "y", plugins: { legend: { display: false } },
      scales: { x: { grid: gridOpts(), beginAtZero: true, ticks: { precision: 0 } }, y: { grid: { display: false } } }, maintainAspectRatio: false }, extra || {});
  }
  function barOpts(extra) {
    return Object.assign({ plugins: { legend: { display: false } },
      scales: { x: { grid: { display: false } }, y: { grid: gridOpts(), beginAtZero: true, ticks: { precision: 0 } } }, maintainAspectRatio: false }, extra || {});
  }
  function stackedBarOpts() {
    return { plugins: { legend: { position: "bottom", labels: { boxWidth: 11, boxHeight: 11, padding: 14 } } },
      scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, grid: gridOpts(), beginAtZero: true, ticks: { precision: 0 } } }, maintainAspectRatio: false };
  }
  function doughnutOpts() { return { cutout: "62%", plugins: { legend: { position: "bottom", labels: { boxWidth: 11, boxHeight: 11, padding: 14 } } }, maintainAspectRatio: false }; }
  function lineOpts(extra) {
    const base = { interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 11, boxHeight: 11, padding: 14 } },
        tooltip: { backgroundColor: "rgba(74,6,8,0.9)", titleColor: "#fff", bodyColor: "#e8e0d8", padding: 10, cornerRadius: 6 } },
      scales: { x: { grid: { display: false }, ticks: { maxRotation: 45, autoSkip: true } }, y: { grid: gridOpts(), beginAtZero: true, ticks: { precision: 0 } } },
      elements: { point: { radius: 2, hoverRadius: 5 }, line: { tension: 0.32 } }, maintainAspectRatio: false };
    if (extra) { if (extra.plugins) base.plugins = Object.assign({}, base.plugins, extra.plugins); Object.keys(extra).forEach(function (k) { if (k !== "plugins") base[k] = extra[k]; }); }
    return base;
  }

  function initDataTable(selector, options) {
    if (dtRegistry[selector]) { try { dtRegistry[selector].destroy(); } catch (e) {} }
    dtRegistry[selector] = $(selector).DataTable(Object.assign({ language: DT_LANG_ES }, options || {}));
    return dtRegistry[selector];
  }
  const DT_BUTTONS = [
    { extend: "excelHtml5", text: '<i class="bi bi-file-earmark-excel"></i> Excel', className: "dt-button" },
    { extend: "csvHtml5", text: '<i class="bi bi-filetype-csv"></i> CSV', className: "dt-button" }
  ];

  /* ========================= CARGA DE DATOS ========================= */

  function loadCasos() {
    const url = CONFIG.casosSource + "?_=" + Date.now();
    return fetch(url, { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (json) { STATE.rawCasos = (json && Array.isArray(json.casos)) ? json.casos : []; STATE.errorCasos = null; })
      .catch(function (err) { STATE.errorCasos = "Origen no disponible (" + err.message + ")"; if (!STATE.rawCasos.length) STATE.rawCasos = []; });
  }
  function loadTareas() {
    const url = CONFIG.tareasSource + "?_=" + Date.now();
    return fetch(url, { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (json) { STATE.rawTareas = (json && Array.isArray(json.tareas)) ? json.tareas : []; STATE.errorTareas = null; })
      .catch(function (err) { STATE.errorTareas = "Origen no disponible (" + err.message + ")"; if (!STATE.rawTareas.length) STATE.rawTareas = []; });
  }
  function loadAllData(isManual) {
    setSyncStatus("syncing");
    return Promise.all([loadCasos(), loadTareas()]).then(function () {
      STATE.lastUpdated = new Date();
      const hasError = !!(STATE.errorCasos || STATE.errorTareas);
      const allError = !!(STATE.errorCasos && STATE.errorTareas);
      setSyncStatus(allError ? "error" : (hasError ? "partial" : "ok"));
      renderErrorBanners();
      if (!STATE.firstLoadDone) { initEstadoFilterCasos(); initEstadoFilterTareas(); }
      populateCasosFilterBar(); populateTareasFilterBar();
      renderAll();
      STATE.firstLoadDone = true;
    });
  }

  function initEstadoFilterCasos() {
    const set = new Set(); STATE.rawCasos.forEach(function (r) { if (r.estado) set.add(r.estado); });
    const pre = ESTADOS_ABIERTOS_CASOS.filter(function (e) { return set.has(e); });
    CASOS_FILTER.estado = pre.length ? pre : Array.from(set).sort();
  }
  function initEstadoFilterTareas() {
    const set = new Set(); STATE.rawTareas.forEach(function (t) { if (t.estado) set.add(t.estado); });
    TAREAS_FILTER.estado = Array.from(set).sort(); // Tareas: por defecto se muestran todos los estados
  }

  /* ============================ UI: ESTADO / SYNC ============================ */

  function setSyncStatus(state) {
    const pill = document.getElementById("syncPill"); if (!pill) return;
    const icon = document.getElementById("syncIcon"), text = document.getElementById("syncText");
    pill.classList.remove("is-syncing", "is-error", "is-partial");
    if (state === "syncing") { pill.classList.add("is-syncing"); icon.className = "bi bi-arrow-repeat"; text.textContent = "Sincronizando…"; }
    else if (state === "ok") { icon.className = "bi bi-check-circle"; text.textContent = "Datos al día"; }
    else if (state === "partial") { pill.classList.add("is-partial"); icon.className = "bi bi-exclamation-circle"; text.textContent = "Sincronización parcial"; }
    else if (state === "error") { pill.classList.add("is-error"); icon.className = "bi bi-x-circle"; text.textContent = "Sin conexión a los orígenes"; }
    if (state !== "syncing") updateLastUpdatedUI();
  }
  function updateLastUpdatedUI() {
    const el = document.getElementById("lastUpdateValue"); if (!el || !STATE.lastUpdated) return;
    const d = STATE.lastUpdated;
    el.textContent = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
  }
  function renderErrorBanners() {
    const stack = document.getElementById("errorBannerStack"); if (!stack) return;
    let html = "";
    if (STATE.errorLibs) html += '<div class="error-banner"><i class="bi bi-exclamation-triangle-fill"></i> <strong>Librerías:</strong> ' + esc(STATE.errorLibs) + '</div>';
    if (STATE.errorRender && STATE.errorRender.length) html += '<div class="error-banner"><i class="bi bi-exclamation-triangle-fill"></i> <strong>Error al dibujar:</strong> ' + esc(STATE.errorRender.join(" · ")) + ' — el resto del tablero sí se actualizó.</div>';
    if (STATE.errorCasos) html += '<div class="error-banner"><i class="bi bi-exclamation-triangle-fill"></i> <strong>Casos:</strong> ' + esc(STATE.errorCasos) + ' — mostrando los últimos datos disponibles.</div>';
    if (STATE.errorTareas) html += '<div class="error-banner"><i class="bi bi-exclamation-triangle-fill"></i> <strong>Tareas:</strong> ' + esc(STATE.errorTareas) + ' — mostrando los últimos datos disponibles.</div>';
    stack.innerHTML = html;
  }
  function showToast(message) {
    const stack = document.getElementById("toastStack"); if (!stack) return;
    const item = document.createElement("div"); item.className = "toast-item";
    item.innerHTML = '<i class="bi bi-exclamation-circle"></i> ' + esc(message);
    stack.appendChild(item);
    setTimeout(function () { item.classList.add("is-leaving"); setTimeout(function () { item.remove(); }, 400); }, 6000);
  }

  /* ============================ NAVEGACIÓN ============================ */

  function switchView(key) {
    document.querySelectorAll(".nav-link[data-view]").forEach(function (btn) { btn.classList.toggle("active", btn.getAttribute("data-view") === key); });
    document.querySelectorAll(".view[data-view]").forEach(function (sec) { sec.classList.toggle("active", sec.getAttribute("data-view") === key); });
    const title = VIEW_TITLES[key] || key;
    const titleEl = document.getElementById("viewTitle"), crumbEl = document.getElementById("breadcrumbCurrent");
    if (titleEl) titleEl.textContent = title; if (crumbEl) crumbEl.textContent = title;
    document.body.classList.remove("sidebar-is-open");
    const sidebar = document.getElementById("sidebar"), overlay = document.getElementById("sidebarOverlay");
    if (sidebar) sidebar.classList.remove("is-open"); if (overlay) overlay.classList.remove("is-open");
    setTimeout(function () { Object.keys(chartRegistry).forEach(function (id) { if (chartRegistry[id]) { try { chartRegistry[id].resize(); } catch (e) {} } }); }, 60);
  }

  /* ============================ RENDERIZADO ============================ */

  function renderAll() {
    applyCasosFilter(); applyTareasFilter();
    STATE.statsCasos = computeCasosStats(STATE.casos);
    STATE.statsTareas = computeTareasStats(STATE.tareas);
    updateLastUpdatedUI();
    updateSidebarBadges();
    // Cada sección en su propio try/catch: si una falla (p.ej. falta Chart.js o
    // DataTables), las demás igual se dibujan.
    STATE.errorRender = [];
    [["Resumen ejecutivo", renderExecutive], ["Atención Prioritaria", renderAttention],
     ["Casos", renderCasosView], ["Tareas", renderTareasView], ["Solucionados", renderSolucionados],
     ["Gestión de Responsables", renderResponsables], ["Comparativa por Grupos", renderGrupos]
    ].forEach(function (sec) {
      try { sec[1](); } catch (e) { console.error("[renderAll] " + sec[0] + ":", e); STATE.errorRender.push(sec[0] + " (" + e.message + ")"); }
    });
    renderErrorBanners();
  }

  function updateSidebarBadges() {
    const navAtencion = document.getElementById("navBadgeAtencion");
    if (navAtencion) navAtencion.textContent = STATE.statsCasos.vencidos + STATE.statsCasos.criticos;
    const navCasos = document.getElementById("navBadgeCasos");
    if (navCasos) navCasos.textContent = STATE.statsCasos.total;
    const navTareas = document.getElementById("navBadgeTareas");
    if (navTareas) navTareas.textContent = STATE.statsTareas.pendientes;
    const solEl = document.getElementById("navBadgeSolucionados");
    if (solEl) solEl.textContent = STATE.rawCasos.filter(function (r) { return r.estado === "Solucionado"; }).length;
  }

  /* ---------------------- RESUMEN EJECUTIVO ---------------------- */

  function renderExecutive() {
    const s = STATE.statsCasos, st = STATE.statsTareas;
    const grid = document.getElementById("kpiExecGrid");
    if (grid) {
      grid.innerHTML =
        kpi("Total de casos", s.total, "info", "bi-collection", "Proyecto Punto UAO") +
        kpi("Vencidos", s.vencidos, "vencido", "bi-x-octagon", pct(s.vencidos, s.total) + "% del total") +
        kpi("Críticos", s.criticos, "critico", "bi-exclamation-triangle", pct(s.criticos, s.total) + "% del total") +
        kpi("En riesgo", s.riesgo, "riesgo", "bi-shield-exclamation", pct(s.riesgo, s.total) + "% del total") +
        kpi("Tiempo promedio", s.avgTiempo + " días", "normal", "bi-clock-history", "transcurrido por caso") +
        kpi("Tareas pendientes", st.pendientes, "info", "bi-list-check", st.total + " tareas en total");
    }
    renderExecCharts();
    renderComparativoNivel1();
  }

  function renderExecCharts() {
    const periodContainer = document.getElementById("execTendPeriod");
    if (periodContainer) { periodContainer.innerHTML = buildPeriodBtnsHTML(); wireTendencyBtns(periodContainer); }

    // Vista unificada: Casos y Tareas sobre el mismo periodo (rango por defecto, sin
    // heredar los filtros de fecha propios de cada pestaña, para que ambas series
    // queden alineadas en las mismas etiquetas de tiempo).
    const casosBuckets = getTendenciaCounts(STATE.casos, TENDENCY_PERIOD, "fecha_registro", {});
    const tareasBuckets = getTendenciaCounts(STATE.tareas, TENDENCY_PERIOD, "fecha_creacion", {});
    const labels = casosBuckets.map(function (b) { return b.label; });
    const execTendInner = document.getElementById("execTendInner");
    if (execTendInner) {
      execTendInner.dataset.pts = labels.length;
      const pW = execTendInner.parentElement ? execTendInner.parentElement.clientWidth : 0;
      execTendInner.style.width = (pW > 0 ? Math.max(labels.length * 38, pW) : Math.max(labels.length * 38, 300)) + "px";
    }
    renderChart("chartExecTendencia", "line", { labels: labels, datasets: [
      { label: "Casos creados", data: casosBuckets.map(function (b) { return b.count; }), borderColor: "#8C0F13", backgroundColor: "#8C0F1322", fill: true },
      { label: "Tareas creadas", data: tareasBuckets.map(function (b) { return b.count; }), borderColor: "#4A6B8C", backgroundColor: "#4A6B8C22", fill: true }
    ] }, lineOpts());

    const s = STATE.statsCasos;
    const counts = { Normal: s.normal, Riesgo: s.riesgo, Critico: s.criticos, Vencido: s.vencidos };
    renderChart("chartExecClasificacion", "doughnut", toChartDataDoughnut(counts, STATUS_LABELS, STATUS_COLORS), doughnutOpts());
  }

  function renderComparativoNivel1() {
    const cats = NIVEL1_CATS.concat([NIVEL1_OTROS]);
    const s = STATE.statsCasos;
    const tbody = document.querySelector("#tableComparativo tbody");
    if (tbody) {
      let html = "";
      cats.forEach(function (c) {
        const d = s.porNivel1[c] || { total: 0, vencidos: 0, criticos: 0, riesgo: 0 };
        html += '<tr>' +
          '<td>' + nivel1ChipHTML(c) + '</td>' +
          '<td data-order="' + d.total + '">' + d.total + '</td>' +
          '<td data-order="' + d.vencidos + '">' + d.vencidos + '</td>' +
          '<td data-order="' + d.criticos + '">' + d.criticos + '</td>' +
          '<td data-order="' + d.riesgo + '">' + d.riesgo + '</td>' +
          '</tr>';
      });
      tbody.innerHTML = html;
    }
    initDataTable("#tableComparativo", { paging: false, searching: false, info: false, order: [] });

    const datasets = ["Normal", "Riesgo", "Critico", "Vencido"].map(function (cls) {
      return { label: STATUS_LABELS[cls], backgroundColor: STATUS_COLORS[cls],
        data: cats.map(function (c) {
          const d = s.porNivel1[c] || { total: 0, vencidos: 0, criticos: 0, riesgo: 0 };
          const normal = d.total - d.vencidos - d.criticos - d.riesgo;
          return cls === "Normal" ? normal : (cls === "Riesgo" ? d.riesgo : (cls === "Critico" ? d.criticos : d.vencidos));
        }) };
    });
    renderChart("chartComparativoStack", "bar", { labels: cats, datasets: datasets }, stackedBarOpts());
  }

  /* ---------------------- ATENCIÓN PRIORITARIA ---------------------- */

  function renderAttention() {
    const s = STATE.statsCasos;
    const grid = document.getElementById("kpiAttentionGrid");
    if (grid) {
      grid.innerHTML =
        kpi("Vencidos", s.vencidos, "vencido", "bi-x-octagon", "requieren acción inmediata") +
        kpi("Críticos", s.criticos, "critico", "bi-exclamation-triangle", "por vencer en horas") +
        kpi("Total en atención", s.vencidos + s.criticos, "atencion", "bi-megaphone", "vencidos + críticos");
    }
    const respTop = topEntry(s.vencidosPorResponsable), catTop = topEntry(s.vencidosPorCategoria);
    let n1Top = { key: "—", count: 0 };
    Object.keys(s.porNivel1).forEach(function (n1) { if (s.porNivel1[n1].vencidos > n1Top.count) n1Top = { key: n1, count: s.porNivel1[n1].vencidos }; });
    setSpotlight("spotlightResponsable", respTop); setSpotlight("spotlightCategoria", catTop); setSpotlight("spotlightArea", n1Top);

    const atencionCases = STATE.casos.filter(function (r) { const cls = effectiveClass(r); return cls === "Vencido" || cls === "Critico"; })
      .sort(function (a, b) { return effectiveProgreso(b) - effectiveProgreso(a); });

    const selAt = "#tableAtencion";
    if (dtRegistry[selAt]) { try { dtRegistry[selAt].destroy(); } catch (e) {} delete dtRegistry[selAt]; }
    const tbodyAt = document.querySelector(selAt + " tbody");
    if (tbodyAt) tbodyAt.innerHTML = atencionCases.map(function (r) { return buildCaseRow(r, true); }).join("");
    dtRegistry[selAt] = $(selAt).DataTable(Object.assign({ language: DT_LANG_ES }, { paging: true, pageLength: 15, order: [], dom: "frtipB", buttons: DT_BUTTONS }));
  }
  function setSpotlight(id, entry) {
    const el = document.getElementById(id); if (!el) return;
    if (!entry || entry.count === 0) { el.innerHTML = '<span class="spotlight-empty">Sin casos vencidos</span>'; return; }
    el.innerHTML = esc(entry.key) + '<span class="spotlight-count">' + entry.count + ' vencido' + (entry.count === 1 ? "" : "s") + '</span>';
  }

  function buildCaseRow(r, includeFecha) {
    const cls = effectiveClass(r);
    const rowClass = cls === "Vencido" ? "row--vencido" : (cls === "Critico" ? "row--critico" : "");
    const prog = effectiveProgreso(r);
    let html = '<tr class="' + rowClass + '">';
    html += '<td>' + esc(r.caso) + '</td>';
    html += '<td>' + nivel1ChipHTML(nivel1Effective(r)) + '</td>';
    if (includeFecha) html += '<td>' + esc(r.fecha_registro) + '</td>';
    html += '<td>' + esc(r.estado) + '</td>';
    html += '<td>' + esc(r.categoria) + '</td>';
    html += '<td>' + esc(r.responsable) + '</td>';
    html += '<td>' + esc(r.fecha_estimada_solucion) + '</td>';
    html += '<td data-order="' + (r.tiempo_transcurrido_dias || 0) + '">' + (r.tiempo_transcurrido_dias || 0).toFixed(1) + ' días</td>';
    html += '<td data-order="' + prog + '">' + progressCellHTML(prog, cls) + '</td>';
    html += '</tr>';
    return html;
  }

  /* ---------------------- PESTAÑA CASOS ---------------------- */

  function populateCasosFilterBar() {
    const bar = document.getElementById("casosFilterBar"); if (!bar) return;
    function uniqueVals(field) { return Array.from(new Set(STATE.rawCasos.map(function (r) { return r[field] || ""; }).filter(Boolean))).sort(); }
    const fields = [
      { key: "nivel2", label: "Nivel 2", icon: "bi-diagram-2", opts: uniqueVals("nivel2") },
      { key: "nivel3", label: "Categoría específica", icon: "bi-diagram-3", opts: uniqueVals("categoria") },
      { key: "grupo", label: "Grupo", icon: "bi-building", optsField: "grupo_responsable" },
      { key: "responsable", label: "Responsable", icon: "bi-person", opts: uniqueVals("responsable") },
      { key: "estado", label: "Estado", icon: "bi-circle-half", opts: uniqueVals("estado") },
      { key: "condicion", label: "Condición", icon: "bi-toggle2-on", opts: ["Abiertos", "Cerrados"] },
      { key: "tipoRegistro", label: "Tipo de registro", icon: "bi-tag", optsField: "tipo_registro" },
      { key: "fuente", label: "Origen", icon: "bi-database", opts: uniqueVals("fuente") }
    ];
    const dropsHtml = fields.map(function (f) { return buildMsDropHTML(f.key, f.label, f.icon, f.optsField ? uniqueVals(f.optsField) : f.opts, CASOS_FILTER); }).join("");
    bar.innerHTML = '<div class="gfb-inner"><span class="gfb-title"><i class="bi bi-funnel-fill"></i> Filtros</span>' +
      '<div class="gfb-drops" id="casosFilterDrops">' + dropsHtml + '</div>' +
      '<div class="gfb-dates"><div class="filter-group"><label for="casosFechaDesde">Desde</label>' +
      '<input type="date" id="casosFechaDesde" class="filter-select filter-select--sm"' + (CASOS_FILTER.fechaDesde ? ' value="' + CASOS_FILTER.fechaDesde + '"' : '') + '></div>' +
      '<div class="filter-group"><label for="casosFechaHasta">Hasta</label>' +
      '<input type="date" id="casosFechaHasta" class="filter-select filter-select--sm"' + (CASOS_FILTER.fechaHasta ? ' value="' + CASOS_FILTER.fechaHasta + '"' : '') + '></div></div>' +
      '<button class="gfb-clear" id="casosFilterClear"><i class="bi bi-x-circle"></i> Limpiar</button></div>';
    wireFilterBar("casosFilterBar", "casosFilterDrops", CASOS_FILTER, function () { renderAll(); }, ["casosFechaDesde", "casosFechaHasta"]);
    const clearBtn = document.getElementById("casosFilterClear");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      CASOS_FILTER.nivel2 = []; CASOS_FILTER.nivel3 = []; CASOS_FILTER.grupo = []; CASOS_FILTER.responsable = [];
      CASOS_FILTER.fuente = []; CASOS_FILTER.tipoRegistro = []; CASOS_FILTER.condicion = [];
      CASOS_FILTER.fechaDesde = ""; CASOS_FILTER.fechaHasta = "";
      initEstadoFilterCasos(); _casosActiveCat = null; populateCasosFilterBar(); renderAll();
    });
  }

  function buildCasosTabsHTML() {
    // Tres controles sincronizados (select, pestañas, tarjetas KPI): todos leen y
    // escriben _casosActiveCat y re-renderizan, así cambiar uno refleja los otros.
    const cats = ["Todas"].concat(NIVEL1_CATS, [NIVEL1_OTROS]);
    const selectHTML = '<select class="form-select form-select-sm casos-cat-select" id="casosCatSelect" aria-label="Categoría">' +
      cats.map(function (c) {
        const val = c === "Todas" ? "" : c;
        return '<option value="' + esc(val) + '"' + ((_casosActiveCat || "") === val ? " selected" : "") + '>' + esc(c) + '</option>';
      }).join("") + '</select>';
    return '<div class="casos-cat-nav">' + selectHTML + '<div class="resp-tab-btns" id="casosCatTabs">' + cats.map(function (c) {
      const active = (c === "Todas" && !_casosActiveCat) || c === _casosActiveCat ? " is-active" : "";
      return '<button class="resp-tab-btn' + active + '" data-cat="' + esc(c === "Todas" ? "" : c) + '">' + esc(c) + '</button>';
    }).join("") + '</div></div>';
  }
  function wireCasosTabs() {
    const sel = document.getElementById("casosCatSelect");
    if (sel) sel.addEventListener("change", function () { _casosActiveCat = this.value || null; renderAll(); });
    const tabsEl = document.getElementById("casosCatTabs"); if (!tabsEl) return;
    tabsEl.querySelectorAll(".resp-tab-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        _casosActiveCat = this.getAttribute("data-cat") || null;
        renderAll();
      });
    });
  }

  function renderCasosView() {
    const s = STATE.statsCasos;
    const cats = NIVEL1_CATS.concat([NIVEL1_OTROS]);

    const tabsWrap = document.getElementById("casosCatTabsWrap");
    if (tabsWrap) { tabsWrap.innerHTML = buildCasosTabsHTML(); wireCasosTabs(); }

    const catGrid = document.getElementById("kpiCategoriasGrid");
    if (catGrid) {
      catGrid.innerHTML = cats.map(function (c) {
        const d = s.porNivel1[c] || { total: 0, vencidos: 0, criticos: 0, riesgo: 0 };
        const key = NIVEL1_KEY[c] || "otro";
        const icon = NIVEL1_ICON[c] || "bi-collection";
        const active = _casosActiveCat === c ? " is-active" : "";
        return ('<div class="kpi-card kpi-card--cat-' + key + active + '" data-cat="' + esc(c) + '">' +
          '<div class="kpi-label"><i class="bi ' + icon + '"></i> ' + esc(c) + '</div>' +
          '<div class="kpi-value">' + d.total + '</div>' +
          '<div class="kpi-foot">' + d.vencidos + ' vencidos · ' + d.criticos + ' críticos</div></div>');
      }).join("");
      catGrid.querySelectorAll(".kpi-card").forEach(function (card) {
        card.addEventListener("click", function () {
          const c = this.getAttribute("data-cat");
          _casosActiveCat = (_casosActiveCat === c) ? null : c;
          renderAll();
        });
      });
    }

    const kpiGrid = document.getElementById("kpiCasosGrid");
    if (kpiGrid) {
      kpiGrid.innerHTML =
        kpi("Casos en la vista", s.total, "info", "bi-collection", _casosActiveCat ? esc(_casosActiveCat) : "todas las categorías") +
        kpi("Vencidos", s.vencidos, "vencido", "bi-x-octagon", pct(s.vencidos, s.total) + "%") +
        kpi("Críticos", s.criticos, "critico", "bi-exclamation-triangle", pct(s.criticos, s.total) + "%") +
        kpi("En riesgo", s.riesgo, "riesgo", "bi-shield-exclamation", pct(s.riesgo, s.total) + "%") +
        kpi("Tiempo promedio", s.avgTiempo + " días", "normal", "bi-clock-history", "");
    }

    const selAll = "#tableCasosAll";
    if (dtRegistry[selAll]) { try { dtRegistry[selAll].destroy(); } catch (e) {} delete dtRegistry[selAll]; }
    const tbody = document.querySelector(selAll + " tbody");
    if (tbody) {
      tbody.innerHTML = STATE.casos.map(function (r) {
        const cls = effectiveClass(r); const rowClass = cls === "Vencido" ? "row--vencido" : (cls === "Critico" ? "row--critico" : "");
        const prog = effectiveProgreso(r);
        return ('<tr class="' + rowClass + '">' +
          '<td>' + esc(r.caso) + '</td>' + '<td>' + esc(r.fecha_registro) + '</td>' + '<td>' + esc(r.estado) + '</td>' +
          '<td>' + nivel1ChipHTML(nivel1Effective(r)) + '</td>' + '<td>' + esc(r.nivel2) + '</td>' +
          '<td>' + esc(r.autor) + '</td>' + '<td>' + esc(r.responsable) + '</td>' + '<td>' + esc(r.grupo_responsable) + '</td>' +
          '<td>' + esc(r.tipo_registro) + '</td>' + '<td>' + esc(r.fecha_modificacion) + '</td>' +
          '<td data-order="' + prog + '">' + progressCellHTML(prog, cls) + '</td></tr>');
      }).join("");
    }
    dtRegistry[selAll] = $(selAll).DataTable(Object.assign({ language: DT_LANG_ES }, { paging: true, pageLength: 15, order: [[10, "desc"]], dom: "frtipB", buttons: DT_BUTTONS }));
  }

  /* ---------------------- PESTAÑA TAREAS ---------------------- */

  function populateTareasFilterBar() {
    const bar = document.getElementById("tareasFilterBar"); if (!bar) return;
    function uniqueVals(field) { return Array.from(new Set(STATE.rawTareas.map(function (t) { return t[field] || ""; }).filter(Boolean))).sort(); }
    const fields = [
      { key: "tipoServicio", label: "Ciclo", icon: "bi-diagram-3", field: "tipo_servicio" },
      { key: "linea", label: "Canal", icon: "bi-headset", field: "linea_atencion" },
      { key: "causa", label: "Causa", icon: "bi-tags", field: "causa" },
      { key: "criterios", label: "Criterios", icon: "bi-list-check", field: "criterios" },
      { key: "responsable", label: "Responsable", icon: "bi-person", field: "responsable" },
      { key: "estado", label: "Estado", icon: "bi-circle-half", field: "estado" }
    ];
    const dropsHtml = fields.map(function (f) { return buildMsDropHTML(f.key, f.label, f.icon, uniqueVals(f.field), TAREAS_FILTER); }).join("");
    bar.innerHTML = '<div class="gfb-inner"><span class="gfb-title"><i class="bi bi-funnel-fill"></i> Filtros</span>' +
      '<div class="gfb-drops" id="tareasFilterDrops">' + dropsHtml + '</div>' +
      '<div class="gfb-dates"><div class="filter-group"><label for="tareasFechaDesde">Desde</label>' +
      '<input type="date" id="tareasFechaDesde" class="filter-select filter-select--sm"' + (TAREAS_FILTER.fechaDesde ? ' value="' + TAREAS_FILTER.fechaDesde + '"' : '') + '></div>' +
      '<div class="filter-group"><label for="tareasFechaHasta">Hasta</label>' +
      '<input type="date" id="tareasFechaHasta" class="filter-select filter-select--sm"' + (TAREAS_FILTER.fechaHasta ? ' value="' + TAREAS_FILTER.fechaHasta + '"' : '') + '></div></div>' +
      '<button class="gfb-clear" id="tareasFilterClear"><i class="bi bi-x-circle"></i> Limpiar</button></div>';
    wireFilterBar("tareasFilterBar", "tareasFilterDrops", TAREAS_FILTER, function () { renderAll(); }, ["tareasFechaDesde", "tareasFechaHasta"]);
    const clearBtn = document.getElementById("tareasFilterClear");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      TAREAS_FILTER.tipoServicio = []; TAREAS_FILTER.linea = []; TAREAS_FILTER.causa = []; TAREAS_FILTER.criterios = []; TAREAS_FILTER.responsable = [];
      TAREAS_FILTER.fechaDesde = ""; TAREAS_FILTER.fechaHasta = "";
      initEstadoFilterTareas(); populateTareasFilterBar(); renderAll();
    });
  }

  function renderTareasView() {
    const s = STATE.statsTareas;
    const grid = document.getElementById("kpiTareasGrid");
    if (grid) {
      const topCanal = topEntry(s.porLinea), topCausa = topEntry(s.porCausa);
      grid.innerHTML =
        kpi("Total de tareas", s.total, "info", "bi-list-check", "en la vista filtrada") +
        kpi("Completadas", s.completadas, "sla", "bi-check2-circle", pct(s.completadas, s.total) + "% del total") +
        kpi("Pendientes", s.pendientes, "riesgo", "bi-hourglass-split", pct(s.pendientes, s.total) + "% del total") +
        kpi("Canal más usado", topCanal.key, "info", "bi-headset", topCanal.count + " tareas") +
        kpi("Causa más frecuente", topCausa.key, "critico", "bi-tags", topCausa.count + " tareas");
    }
    renderChart("chartTareasCanal", "doughnut", toChartDataDoughnut(s.porLinea, null, null), doughnutOpts());
    renderChart("chartTareasCausa", "bar", toChartDataBar(s.porCausa, "#8C0F13", 10), horizontalBarOpts());

    const buckets = getTendenciaCounts(STATE.tareas, TENDENCY_PERIOD, "fecha_creacion", TAREAS_FILTER);
    renderChart("chartTareasTendencia", "line", { labels: buckets.map(function (b) { return b.label; }),
      datasets: [{ label: "Tareas creadas", data: buckets.map(function (b) { return b.count; }), borderColor: "#4A6B8C", backgroundColor: "#4A6B8C22", fill: true }] },
      lineOpts({ plugins: { legend: { display: false } } }));

    const selT = "#tableTareas";
    if (dtRegistry[selT]) { try { dtRegistry[selT].destroy(); } catch (e) {} delete dtRegistry[selT]; }
    const tbody = document.querySelector(selT + " tbody");
    if (tbody) {
      tbody.innerHTML = STATE.tareas.slice().sort(function (a, b) { return (b.fecha_creacion || "").localeCompare(a.fecha_creacion || ""); }).map(function (t) {
        const rowClass = tareaCompletada(t) ? "" : "row--critico";
        return ('<tr class="' + rowClass + '"><td>' + esc(t.tarea_id) + '</td><td>' + esc(t.fecha_creacion) + '</td><td>' + esc(t.asunto) + '</td><td>' + esc(t.estado) + '</td>' +
          '<td>' + esc(t.tipo_servicio) + '</td><td>' + esc(t.linea_atencion) + '</td><td>' + esc(t.causa) + '</td><td>' + esc(t.criterios) + '</td><td>' + esc(t.responsable) + '</td></tr>');
      }).join("");
    }
    dtRegistry[selT] = $(selT).DataTable(Object.assign({ language: DT_LANG_ES }, { paging: true, pageLength: 15, order: [], dom: "frtipB", buttons: DT_BUTTONS }));
  }

  /* ---------------------- SOLUCIONADOS ---------------------- */

  function renderSolucionados() {
    const sol = STATE.rawCasos.filter(function (r) {
      if (r.estado !== "Solucionado") return false;
      if (CASOS_FILTER.nivel2.length && CASOS_FILTER.nivel2.indexOf(r.nivel2) === -1) return false;
      if (CASOS_FILTER.grupo.length && CASOS_FILTER.grupo.indexOf(r.grupo_responsable) === -1) return false;
      if (CASOS_FILTER.responsable.length && CASOS_FILTER.responsable.indexOf(r.responsable) === -1) return false;
      if (CASOS_FILTER.fechaDesde && (r.fecha_registro || "") < CASOS_FILTER.fechaDesde) return false;
      if (CASOS_FILTER.fechaHasta && (r.fecha_registro || "") > CASOS_FILTER.fechaHasta) return false;
      return true;
    });
    let vencidos = 0, criticos = 0, riesgo = 0, aTiempo = 0;
    sol.forEach(function (r) { const cls = classify(effectiveProgreso(r));
      if (cls === "Vencido") vencidos++; else if (cls === "Critico") criticos++; else if (cls === "Riesgo") riesgo++; else aTiempo++; });

    const grid = document.getElementById("kpiSolucionadosGrid");
    if (grid) {
      grid.innerHTML =
        kpi("Total solucionados", sol.length, "sla", "bi-check2-circle", "según filtros de Casos") +
        kpi("A tiempo", aTiempo, "normal", "bi-patch-check", "Progreso < 90% al resolver") +
        kpi("Resueltos en riesgo", riesgo, "riesgo", "bi-shield-exclamation", "Progreso 90–95%") +
        kpi("Resueltos críticos", criticos, "critico", "bi-exclamation-triangle", "Progreso 95–98%") +
        kpi("Resueltos vencidos", vencidos, "vencido", "bi-x-octagon", "Progreso ≥ 98%");
    }
    const sorted = sol.slice().sort(function (a, b) { return effectiveProgreso(b) - effectiveProgreso(a); });
    const selSol = "#tableSolucionados";
    if (dtRegistry[selSol]) { try { dtRegistry[selSol].destroy(); } catch (e) {} delete dtRegistry[selSol]; }
    const tbody = document.querySelector(selSol + " tbody");
    if (tbody) tbody.innerHTML = sorted.map(function (r) { return buildCaseRow(r, true); }).join("");
    dtRegistry[selSol] = $(selSol).DataTable(Object.assign({ language: DT_LANG_ES }, { paging: true, pageLength: 15, order: [], dom: "frtipB", buttons: DT_BUTTONS }));
  }

  /* ---------------------- RESPONSABLES (Casos + Tareas combinados) ---------------------- */

  function computeResponsablesCombined() {
    const byResp = {};
    function ensure(nombre) {
      if (!byResp[nombre]) byResp[nombre] = { nombre: nombre, totalCasos: 0, abiertos: 0, vencidosActivos: 0, criticosActivos: 0, solucionados: 0, tiemposSol: [], totalTareas: 0, tareasPendientes: 0, categorias: {} };
      return byResp[nombre];
    }
    STATE.rawCasos.forEach(function (r) {
      const nombre = r.responsable || "Sin asignar";
      if (RESP_FILTER.responsable.length && RESP_FILTER.responsable.indexOf(nombre) === -1) return;
      if (RESP_FILTER.grupo.length && RESP_FILTER.grupo.indexOf(r.grupo_responsable) === -1) return;
      if (RESP_FILTER.fechaDesde && (r.fecha_registro || "") < RESP_FILTER.fechaDesde) return;
      if (RESP_FILTER.fechaHasta && (r.fecha_registro || "") > RESP_FILTER.fechaHasta) return;
      const d = ensure(nombre);
      d.totalCasos++;
      d.categorias[r.categoria || "Sin categoría"] = (d.categorias[r.categoria || "Sin categoría"] || 0) + 1;
      if (r.estado === "En Espera" || r.estado === "En Proceso" || r.estado === "Registrado") {
        d.abiertos++;
        const cls = classify(effectiveProgreso(r));
        if (cls === "Vencido") d.vencidosActivos++; else if (cls === "Critico") d.criticosActivos++;
      } else if (r.estado === "Solucionado" || r.estado === "Cerrado") {
        d.solucionados++;
        if (r.tiempo_transcurrido_dias != null) d.tiemposSol.push(r.tiempo_transcurrido_dias);
      }
    });
    STATE.rawTareas.forEach(function (t) {
      const f = t.fecha_creacion || "";
      if (RESP_FILTER.fechaDesde && f < RESP_FILTER.fechaDesde) return;
      if (RESP_FILTER.fechaHasta && f > RESP_FILTER.fechaHasta) return;
      let nombre = null;
      Object.keys(byResp).forEach(function (k) { if (namesMatch(t.responsable, k)) nombre = k; });
      if (!nombre) {
        if (RESP_FILTER.responsable.length && !RESP_FILTER.responsable.some(function (r) { return namesMatch(t.responsable, r); })) return;
        nombre = t.responsable || "Sin asignar";
      }
      const d = ensure(nombre);
      d.totalTareas++;
      if (!tareaCompletada(t)) d.tareasPendientes++;
    });
    Object.keys(byResp).forEach(function (k) {
      const d = byResp[k];
      d.tasaResolucion = (d.totalCasos > 0) ? +((d.solucionados / d.totalCasos) * 100).toFixed(1) : 0;
      d.avgTiempoSol = d.tiemposSol.length ? +(d.tiemposSol.reduce(function (s, v) { return s + v; }, 0) / d.tiemposSol.length).toFixed(1) : null;
    });
    return byResp;
  }

  function populateRespFilterBar() {
    const bar = document.getElementById("respFilterBar"); if (!bar) return;
    const respSet = new Set(), grupoSet = new Set();
    STATE.rawCasos.forEach(function (r) { if (r.responsable) respSet.add(r.responsable); if (r.grupo_responsable) grupoSet.add(r.grupo_responsable); });
    const dropsHtml = buildMsDropHTML("responsable", "Responsable", "bi-person", Array.from(respSet).sort(), RESP_FILTER) +
      buildMsDropHTML("grupo", "Grupo", "bi-building", Array.from(grupoSet).sort(), RESP_FILTER);
    bar.innerHTML = '<div class="gfb-inner"><span class="gfb-title"><i class="bi bi-funnel-fill"></i> Filtros</span>' +
      '<div class="gfb-drops" id="respFilterDrops">' + dropsHtml + '</div>' +
      '<div class="gfb-dates"><div class="filter-group"><label for="respFechaDesde">Desde</label>' +
      '<input type="date" id="respFechaDesde" class="filter-select filter-select--sm"' + (RESP_FILTER.fechaDesde ? ' value="' + RESP_FILTER.fechaDesde + '"' : '') + '></div>' +
      '<div class="filter-group"><label for="respFechaHasta">Hasta</label>' +
      '<input type="date" id="respFechaHasta" class="filter-select filter-select--sm"' + (RESP_FILTER.fechaHasta ? ' value="' + RESP_FILTER.fechaHasta + '"' : '') + '></div></div>' +
      '<button class="gfb-clear" id="respFilterClear"><i class="bi bi-x-circle"></i> Limpiar</button></div>';
    wireFilterBar("respFilterBar", "respFilterDrops", RESP_FILTER, function () { renderResponsablesContent(); }, ["respFechaDesde", "respFechaHasta"]);
    const clearBtn = document.getElementById("respFilterClear");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      RESP_FILTER.responsable = []; RESP_FILTER.grupo = []; RESP_FILTER.fechaDesde = ""; RESP_FILTER.fechaHasta = "";
      populateRespFilterBar(); renderResponsablesContent();
    });
  }

  function renderResponsables() { populateRespFilterBar(); renderResponsablesContent(); }

  function renderResponsablesContent() {
    const byResp = computeResponsablesCombined();
    const responsables = Object.values(byResp).sort(function (a, b) { return b.totalCasos - a.totalCasos; });

    const kpiGrid = document.getElementById("kpiResponsablesGrid");
    if (kpiGrid) {
      const totalCasosResp = responsables.reduce(function (s, r) { return s + r.totalCasos; }, 0);
      const totalTareasResp = responsables.reduce(function (s, r) { return s + r.totalTareas; }, 0);
      kpiGrid.innerHTML =
        kpi("Responsables en vista", responsables.length, "info", "bi-people", "según filtros de sección") +
        kpi("Total de casos", totalCasosResp, "info", "bi-folder2-open", "histórico completo en la vista") +
        kpi("Total de tareas", totalTareasResp, "info", "bi-list-check", "reporte de tareas/eventos");
    }

    const selSum = "#tableRespResumen";
    if (dtRegistry[selSum]) { try { dtRegistry[selSum].destroy(); } catch (e) {} delete dtRegistry[selSum]; }
    const tbody = document.querySelector(selSum + " tbody");
    if (tbody) {
      tbody.innerHTML = responsables.map(function (r) {
        const rowCls = r.vencidosActivos > 0 ? "row--vencido" : (r.criticosActivos > 0 ? "row--critico" : "");
        const vBadge = r.vencidosActivos > 0 ? '<span class="resp-badge resp-badge--vencido">' + r.vencidosActivos + '</span>' : "0";
        const cBadge = r.criticosActivos > 0 ? '<span class="resp-badge resp-badge--critico">' + r.criticosActivos + '</span>' : "0";
        return ('<tr class="resp-row ' + rowCls + '" data-resp="' + esc(r.nombre) + '">' +
          '<td><strong>' + esc(r.nombre) + '</strong></td>' +
          '<td data-order="' + r.abiertos + '">' + r.abiertos + '</td>' +
          '<td data-order="' + r.vencidosActivos + '">' + vBadge + '</td>' +
          '<td data-order="' + r.criticosActivos + '">' + cBadge + '</td>' +
          '<td data-order="' + r.tasaResolucion + '">' + r.tasaResolucion + '%</td>' +
          '<td data-order="' + r.totalTareas + '">' + r.totalTareas + '</td>' +
          '<td data-order="' + r.tareasPendientes + '">' + r.tareasPendientes + '</td></tr>');
      }).join("");
    }
    dtRegistry[selSum] = $(selSum).DataTable(Object.assign({ language: DT_LANG_ES }, { paging: true, pageLength: 10, order: [[1, "desc"]], dom: "frtipB", buttons: DT_BUTTONS }));

    $(selSum + " tbody").off("click.resp").on("click.resp", "tr.resp-row", function () {
      const nombre = $(this).attr("data-resp");
      if (nombre && byResp[nombre]) { _respDetalleActual = nombre; renderResponsableDetalle(byResp[nombre]); }
    });
    const closeBtn = document.getElementById("btnCerrarRespDetalle");
    if (closeBtn && !closeBtn._wired) { closeBtn._wired = true; closeBtn.addEventListener("click", function () { const p = document.getElementById("panelRespDetalle"); if (p) p.style.display = "none"; _respDetalleActual = null; }); }
    if (_respDetalleActual && byResp[_respDetalleActual]) renderResponsableDetalle(byResp[_respDetalleActual]);
  }

  function renderResponsableDetalle(d) {
    if (!d) return;
    const panel = document.getElementById("panelRespDetalle"); if (panel) panel.style.display = "";
    const nameEl = document.getElementById("respDetalleNombre"); if (nameEl) nameEl.innerHTML = '<i class="bi bi-person-circle"></i> ' + esc(d.nombre);

    const kpiGrid = document.getElementById("kpiRespDetalle");
    if (kpiGrid) {
      const tiempoStr = d.avgTiempoSol !== null ? (+(d.avgTiempoSol * 24).toFixed(1)) + " h" : "—";
      kpiGrid.innerHTML =
        kpi("Casos abiertos", d.abiertos, "info", "bi-folder2-open", "En Espera · En Proceso · Registrado") +
        kpi("Vencidos activos", d.vencidosActivos, "vencido", "bi-x-octagon", "") +
        kpi("Críticos activos", d.criticosActivos, "critico", "bi-exclamation-triangle", "") +
        kpi("% Resolución", d.tasaResolucion + "%", "sla", "bi-graph-up", d.solucionados + " solucionados") +
        kpi("Tiempo prom. solución", tiempoStr, "normal", "bi-clock-history", "") +
        kpi("Tareas (total / pendientes)", d.totalTareas + " / " + d.tareasPendientes, "info", "bi-list-check", "");
    }
    renderChart("chartRespCategorias", "bar", toChartDataBar(d.categorias, "#8C0F13", 8), horizontalBarOpts());

    // Sub-pestañas Casos / Tareas dentro del detalle
    const tabsEl = document.getElementById("respDetalleTabs");
    if (tabsEl && !tabsEl._wired) {
      tabsEl._wired = true;
      tabsEl.querySelectorAll(".resp-tab-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          _respDetalleTab = this.getAttribute("data-tab");
          tabsEl.querySelectorAll(".resp-tab-btn").forEach(function (b) { b.classList.toggle("is-active", b === btn); });
          document.querySelectorAll(".resp-subview").forEach(function (sv) { sv.classList.toggle("is-active", sv.id === "respSub-" + _respDetalleTab); });
        });
      });
    }
    if (tabsEl) tabsEl.querySelectorAll(".resp-tab-btn").forEach(function (b) { b.classList.toggle("is-active", b.getAttribute("data-tab") === _respDetalleTab); });
    document.querySelectorAll(".resp-subview").forEach(function (sv) { sv.classList.toggle("is-active", sv.id === "respSub-" + _respDetalleTab); });

    const casosResp = STATE.rawCasos.filter(function (r) { return r.responsable === d.nombre && (r.estado === "En Espera" || r.estado === "En Proceso" || r.estado === "Registrado"); })
      .sort(function (a, b) { return effectiveProgreso(b) - effectiveProgreso(a); });
    const selCasos = "#tableRespCasos";
    if (dtRegistry[selCasos]) { try { dtRegistry[selCasos].destroy(); } catch (e) {} delete dtRegistry[selCasos]; }
    const tbodyCasos = document.querySelector(selCasos + " tbody");
    if (tbodyCasos) tbodyCasos.innerHTML = casosResp.map(function (r) { return buildCaseRow(r, true); }).join("");
    dtRegistry[selCasos] = $(selCasos).DataTable(Object.assign({ language: DT_LANG_ES }, { paging: true, pageLength: 10, order: [], dom: "frtip" }));

    const tareasResp = STATE.rawTareas.filter(function (t) { return namesMatch(t.responsable, d.nombre); })
      .sort(function (a, b) { return (b.fecha_creacion || "").localeCompare(a.fecha_creacion || ""); });
    const selTareasResp = "#tableRespTareas";
    if (dtRegistry[selTareasResp]) { try { dtRegistry[selTareasResp].destroy(); } catch (e) {} delete dtRegistry[selTareasResp]; }
    const tbodyT = document.querySelector(selTareasResp + " tbody");
    if (tbodyT) tbodyT.innerHTML = tareasResp.map(function (t) {
      return ('<tr><td>' + esc(t.fecha_creacion) + '</td><td>' + esc(t.asunto) + '</td><td>' + esc(t.estado) + '</td><td>' + esc(t.linea_atencion) + '</td><td>' + esc(t.causa) + '</td></tr>');
    }).join("");
    dtRegistry[selTareasResp] = $(selTareasResp).DataTable(Object.assign({ language: DT_LANG_ES }, { paging: true, pageLength: 10, order: [], dom: "frtip" }));

    if (panel && typeof panel.scrollIntoView === "function") panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------------------- COMPARATIVA POR GRUPOS ---------------------- */

  function computeGrupoStats() {
    const filtered = STATE.rawCasos.filter(function (r) {
      if (GRUPO_FILTER.grupo.length && GRUPO_FILTER.grupo.indexOf(r.grupo_responsable) === -1) return false;
      if (GRUPO_FILTER.nivel1.length && GRUPO_FILTER.nivel1.indexOf(nivel1Effective(r)) === -1) return false;
      if (GRUPO_FILTER.fechaDesde && (r.fecha_registro || "") < GRUPO_FILTER.fechaDesde) return false;
      if (GRUPO_FILTER.fechaHasta && (r.fecha_registro || "") > GRUPO_FILTER.fechaHasta) return false;
      return true;
    });
    const byGrupo = {};
    filtered.forEach(function (r) {
      const g = r.grupo_responsable || "Sin grupo";
      if (!byGrupo[g]) byGrupo[g] = { grupo: g, total: 0, vencidos: 0, criticos: 0, riesgo: 0, normal: 0, sumTiempo: 0, solucionados: 0, responsables: {} };
      const d = byGrupo[g];
      d.total++;
      d.sumTiempo += (r.tiempo_transcurrido_dias || 0);
      if (r.estado === "Solucionado") d.solucionados++;
      d.responsables[r.responsable || "Sin asignar"] = true;
      const cls = effectiveClass(r);
      if (cls === "Vencido") d.vencidos++; else if (cls === "Critico") d.criticos++; else if (cls === "Riesgo") d.riesgo++; else d.normal++;
    });
    Object.keys(byGrupo).forEach(function (g) {
      const d = byGrupo[g];
      d.avgTiempo = d.total ? +(d.sumTiempo / d.total).toFixed(1) : 0;
      d.pctVencidos = pct(d.vencidos, d.total);
      d.nResponsables = Object.keys(d.responsables).length;
    });
    return byGrupo;
  }

  function populateGrupoFilterBar() {
    const bar = document.getElementById("gruposFilterBar"); if (!bar) return;
    const grupoSet = new Set();
    STATE.rawCasos.forEach(function (r) { if (r.grupo_responsable) grupoSet.add(r.grupo_responsable); });
    const dropsHtml = buildMsDropHTML("grupo", "Grupo", "bi-building", Array.from(grupoSet).sort(), GRUPO_FILTER) +
      buildMsDropHTML("nivel1", "Categoría", "bi-diagram-2", NIVEL1_CATS.concat([NIVEL1_OTROS]), GRUPO_FILTER);
    bar.innerHTML = '<div class="gfb-inner"><span class="gfb-title"><i class="bi bi-funnel-fill"></i> Filtros</span>' +
      '<div class="gfb-drops" id="gruposFilterDrops">' + dropsHtml + '</div>' +
      '<div class="gfb-dates"><div class="filter-group"><label for="gruposFechaDesde">Desde</label>' +
      '<input type="date" id="gruposFechaDesde" class="filter-select filter-select--sm"' + (GRUPO_FILTER.fechaDesde ? ' value="' + GRUPO_FILTER.fechaDesde + '"' : '') + '></div>' +
      '<div class="filter-group"><label for="gruposFechaHasta">Hasta</label>' +
      '<input type="date" id="gruposFechaHasta" class="filter-select filter-select--sm"' + (GRUPO_FILTER.fechaHasta ? ' value="' + GRUPO_FILTER.fechaHasta + '"' : '') + '></div></div>' +
      '<button class="gfb-clear" id="gruposFilterClear"><i class="bi bi-x-circle"></i> Limpiar</button></div>';
    wireFilterBar("gruposFilterBar", "gruposFilterDrops", GRUPO_FILTER, function () { renderGruposContent(); }, ["gruposFechaDesde", "gruposFechaHasta"]);
    const clearBtn = document.getElementById("gruposFilterClear");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      GRUPO_FILTER.grupo = []; GRUPO_FILTER.nivel1 = []; GRUPO_FILTER.fechaDesde = ""; GRUPO_FILTER.fechaHasta = "";
      populateGrupoFilterBar(); renderGruposContent();
    });
  }

  function renderGrupos() { populateGrupoFilterBar(); renderGruposContent(); }

  function renderGruposContent() {
    const byGrupo = computeGrupoStats();
    const grupos = Object.values(byGrupo).sort(function (a, b) { return b.total - a.total; });

    const kpiGrid = document.getElementById("kpiGruposGrid");
    if (kpiGrid) {
      const topVencidos = grupos.reduce(function (m, g) { return g.vencidos > m.vencidos ? g : m; }, { grupo: "—", vencidos: 0 });
      kpiGrid.innerHTML =
        kpi("Grupos en la vista", grupos.length, "info", "bi-building", "según filtros aplicados") +
        kpi("Grupo con más vencidos", topVencidos.grupo, "vencido", "bi-x-octagon", topVencidos.vencidos + " vencidos") +
        kpi("Total de casos", grupos.reduce(function (s, g) { return s + g.total; }, 0), "info", "bi-collection", "en los grupos filtrados");
    }

    const selG = "#tableGrupos";
    if (dtRegistry[selG]) { try { dtRegistry[selG].destroy(); } catch (e) {} delete dtRegistry[selG]; }
    const tbody = document.querySelector(selG + " tbody");
    if (tbody) {
      tbody.innerHTML = grupos.map(function (g) {
        const rowCls = g.vencidos > 0 ? "row--vencido" : (g.criticos > 0 ? "row--critico" : "");
        return ('<tr class="' + rowCls + '">' +
          '<td><strong>' + esc(g.grupo) + '</strong></td>' +
          '<td data-order="' + g.total + '">' + g.total + '</td>' +
          '<td data-order="' + g.vencidos + '">' + g.vencidos + '</td>' +
          '<td data-order="' + g.criticos + '">' + g.criticos + '</td>' +
          '<td data-order="' + g.riesgo + '">' + g.riesgo + '</td>' +
          '<td data-order="' + g.pctVencidos + '">' + g.pctVencidos + '%</td>' +
          '<td data-order="' + g.avgTiempo + '">' + g.avgTiempo + ' días</td>' +
          '<td data-order="' + g.nResponsables + '">' + g.nResponsables + '</td></tr>');
      }).join("");
    }
    dtRegistry[selG] = $(selG).DataTable(Object.assign({ language: DT_LANG_ES }, { paging: true, pageLength: 15, order: [[2, "desc"]], dom: "frtipB", buttons: DT_BUTTONS }));

    const top10 = grupos.slice(0, 10);
    const datasets = ["Normal", "Riesgo", "Critico", "Vencido"].map(function (cls) {
      return { label: STATUS_LABELS[cls], backgroundColor: STATUS_COLORS[cls],
        data: top10.map(function (g) { return cls === "Normal" ? g.normal : (cls === "Riesgo" ? g.riesgo : (cls === "Critico" ? g.criticos : g.vencidos)); }) };
    });
    renderChart("chartGruposStack", "bar", { labels: top10.map(function (g) { return g.grupo; }), datasets: datasets }, stackedBarOpts());
  }

  /* ====================== BÚSQUEDA GLOBAL ====================== */

  function searchAllTables(val) { Object.keys(dtRegistry).forEach(function (sel) { try { if (dtRegistry[sel]) dtRegistry[sel].search(val).draw(); } catch (e) {} }); }
  function wireGlobalSearch() {
    const input = document.getElementById("globalSearch"); if (!input) return;
    let debounceTimer = null;
    input.addEventListener("input", function () { const val = this.value; clearTimeout(debounceTimer); debounceTimer = setTimeout(function () { searchAllTables(val); }, 250); });
    input.addEventListener("keydown", function (e) { if (e.key === "Escape") { input.value = ""; searchAllTables(""); } });
  }

  /* ============================ EVENTOS UI ============================ */

  function wireNav() {
    document.querySelectorAll(".nav-link[data-view]").forEach(function (btn) { btn.addEventListener("click", function () { switchView(btn.getAttribute("data-view")); closeAllDropdowns(); }); });
  }
  function wireSidebarMobile() {
    const sidebar = document.getElementById("sidebar"), overlay = document.getElementById("sidebarOverlay");
    const openBtn = document.getElementById("sidebarOpen"), closeBtn = document.getElementById("sidebarClose");
    function open() { if (sidebar) sidebar.classList.add("is-open"); if (overlay) overlay.classList.add("is-open"); }
    function close() { if (sidebar) sidebar.classList.remove("is-open"); if (overlay) overlay.classList.remove("is-open"); }
    if (openBtn) openBtn.addEventListener("click", open);
    if (closeBtn) closeBtn.addEventListener("click", close);
    if (overlay) overlay.addEventListener("click", close);
  }
  function wireRefreshButton() {
    const btn = document.getElementById("refreshNowBtn"); if (!btn) return;
    btn.addEventListener("click", function () { btn.classList.add("is-spinning"); loadAllData(true).then(function () { setTimeout(function () { btn.classList.remove("is-spinning"); }, 400); }); });
  }

  /* ============================== INICIO ============================== */

  document.addEventListener("DOMContentLoaded", function () {
    const faltantes = [];
    if (!window.jQuery) faltantes.push("jQuery");
    else if (!window.jQuery.fn || !window.jQuery.fn.DataTable) faltantes.push("DataTables");
    if (!window.Chart) faltantes.push("Chart.js");
    if (faltantes.length) {
      STATE.errorLibs = "No se cargó " + faltantes.join(", ") + " (revise la carpeta lib/). Tablas y/o gráficos no se mostrarán.";
      console.error("[init] " + STATE.errorLibs);
      renderErrorBanners();
    }
    setChartDefaults();
    wireNav(); wireSidebarMobile(); wireRefreshButton(); wireGlobalSearch();
    loadAllData(true).then(function () { setInterval(function () { loadAllData(false); }, CONFIG.refreshIntervalMs); });
  });

})();
