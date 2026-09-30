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
     Nivel1 ∈ {Financiero, Académicos, PQRS, Tecnologías, Bienestar} (confirmado
     con Natalia el 2026-sep); cualquier otro valor cae en "Otros / Histórico".
     Los casos históricos toman nivel1 de 'TIPO SERVICIO' y nivel2 de 'CATEGORÍA
     NUEVA (TIPO DE SERVICIO)', salvo los del proyecto PQRS, que van a PQRS con
     el tipo (Petición, Queja…) como nivel2. Lo calcula el pipeline, que además
     une los casos migrados al Aranda nuevo con su fecha de registro original.
   - ANS: el histórico trae el resultado en 'cumplimiento_ans' (A TIEMPO, EN
     RIESGO, CRITICO, VENCIDO); para el nuevo se deriva del Progreso (ver ansResultado).
   - Tareas es una fuente independiente (sin Progreso/SLA), con sus propios
     filtros y KPIs, y se cruza con Responsables por nombre (namesMatch).

   PROGRESO — "% del ANS consumido" (puede superar 100) en ambas fuentes.
     Verificado el 2026-09-30 con 524 casos del Aranda nuevo: progreso ≈
     horas transcurridas / horas de ANS × 100 (RQ-2187: 9,5 h de 160 h = 5,94).
     Antes se multiplicaba ×100 (inferido de 50 casos recién creados, con
     valores pequeños) y eso marcaba como vencidos casos que no lo estaban.
   ============================================================================= */

(function () {
  "use strict";

  /* ============================ CONFIGURACIÓN ============================ */

  const CONFIG = {
    casosSource: "data/casos.json",
    tareasSource: "data/tareas.json",
    refreshIntervalMs: 5 * 60 * 1000
  };

  const NIVEL1_CATS = ["Financiero", "Académicos", "PQRS", "Tecnologías", "Bienestar"];
  const NIVEL1_OTROS = "Otros / Histórico";
  const NIVEL1_KEY = { "Financiero": "financiero", "Tecnologías": "tecnologias", "Académicos": "academicos", "Bienestar": "bienestar", "PQRS": "pqrs" };
  const NIVEL1_ICON = { "Financiero": "bi-cash-coin", "Tecnologías": "bi-cpu", "Académicos": "bi-mortarboard", "Bienestar": "bi-heart-pulse", "PQRS": "bi-chat-left-text" };

  const STATUS_COLORS = { "Normal": "#9C8C7E", "Riesgo": "#D9A441", "Critico": "#C0151A", "Vencido": "#4A0608" };
  const STATUS_LABELS = { "Normal": "Normal", "Riesgo": "Riesgo", "Critico": "Crítico", "Vencido": "Vencido" };
  const ANS_LABELS = { "Normal": "A tiempo", "Riesgo": "En riesgo", "Critico": "Crítico", "Vencido": "Vencido" };
  const ANS_COLORS = { "Normal": "#2a7a3b", "Riesgo": "#D9A441", "Critico": "#C0151A", "Vencido": "#4A0608" };
  const ANS_HISTORICO = { "A TIEMPO": "Normal", "EN RIESGO": "Riesgo", "CRITICO": "Critico", "VENCIDO": "Vencido" };

  const SERIES_PALETTE = ["#8C0F13", "#C0151A", "#D9A441", "#9C8C7E", "#4A0608", "#B5654A", "#6B5E54", "#D9B68B", "#7A1E22", "#C98A3E"];

  const VIEW_TITLES = {
    resumen: "Resumen ejecutivo",
    casos: "Casos",
    tareas: "Tareas",
    gestion: "Seguimiento operativo"
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

  // Filtro de autor de Casos: solo ofrece estos gestores de CAE (pedido de Natalia,
  // 2026-09-30). Sin selección no filtra; al elegir nombres, muestra solo sus casos.
  const AUTORES_GESTORES = ["Miguel Angel Chavarro Chamorro", "Yuddy Suleima Rayo Arias", "Duvan Andrey Silva Morales",
    "Oscar Eduardo Cucuname Otero", "Harold Vanegas Muñoz"];
  const AUTOR_OTROS = "Otros autores";
  // Clasificación del caso = resultado de ANS, para abiertos y cerrados (ver ansResultado:
  // histórico = TIEMPO RESPUESTA del archivo; nuevo = según Progreso). Abierto/cerrado es
  // otra cosa: el filtro "Condición".
  const CLASIFICACIONES = ["Vencido", "Crítico", "En riesgo", "A tiempo"];
  const CASOS_FILTER = { nivel1: [], nivel2: [], nivel3: [], grupo: [], responsable: [], estado: [], fuente: [], tipoRegistro: [], condicion: [],
    clasificacion: [], autor: [], fechaDesde: "", fechaHasta: "" };
  const TAREAS_FILTER = { tipoServicio: [], linea: [], causa: [], criterios: [], responsable: [], estado: [], fechaDesde: "", fechaHasta: "" };
  const RESP_FILTER = { responsable: [], grupo: [], nivel1: [], fechaDesde: "", fechaHasta: "" };
  const GRUPO_FILTER = { grupo: [], nivel1: [], fechaDesde: "", fechaHasta: "" };
  // Resumen ejecutivo: filtros propios (independientes de la pestaña Casos).
  // Las fechas también recortan las Tareas.
  const EXEC_FILTER = { nivel1: [], nivel2: [], grupo: [], condicion: [], fuente: [], fechaDesde: "", fechaHasta: "" };
  // Atención Prioritaria: filtros propios sobre los casos abiertos vencidos o críticos.
  const ATENCION_FILTER = { clasificacion: [], nivel1: [], nivel2: [], grupo: [], responsable: [], estado: [], fechaDesde: "", fechaHasta: "" };

  const ESTADOS_CERRADOS = ["Solucionado", "Cerrado", "Anulado"];

  const chartRegistry = {};
  const dtRegistry = {};
  let _casosActiveCat = null;     // categoría (nivel1) activa en Casos; null = todas
  let _vistaActual = "resumen";
  let _respDetalleActual = null;
  let _respDetalleTab = "casos";  // "casos" | "tareas" dentro del panel de detalle
  let TENDENCY_PERIOD = "mes";  // por meses se ve el año de histórico completo

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

  function isoDe(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  const DIA_MS = 86400000;
  function diasEntre(fromISO, fechaISO) { return Math.round((new Date(fechaISO + "T00:00:00") - new Date(fromISO + "T00:00:00")) / DIA_MS); }

  // Los tres agrupadores calculan el índice del bucket directamente (sin recorrer
  // los buckets por registro): con vista diaria de un año son cientos de puntos.
  function getDailyCountsRange(records, fromISO, toISO, dateField) {
    const buckets = [], idx = {}; const cur = new Date(fromISO + "T00:00:00"), to = new Date(toISO + "T00:00:00");
    while (cur <= to) {
      const iso = isoDe(cur); idx[iso] = buckets.length;
      buckets.push({ dateStr: iso, label: cur.toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "2-digit" }), count: 0 });
      cur.setDate(cur.getDate() + 1);
    }
    records.forEach(function (r) { const i = idx[r[dateField]]; if (i !== undefined) buckets[i].count++; });
    return buckets;
  }
  function getWeeklyCountsRange(records, fromISO, toISO, dateField) {
    const buckets = []; const cur = new Date(fromISO + "T00:00:00"), to = new Date(toISO + "T00:00:00");
    while (cur <= to) { buckets.push({ label: weekLabel(cur), count: 0 }); cur.setDate(cur.getDate() + 7); }
    records.forEach(function (r) {
      const fr = r[dateField]; if (!fr || fr < fromISO || fr > toISO) return;
      const i = Math.floor(diasEntre(fromISO, fr) / 7); if (buckets[i]) buckets[i].count++;
    });
    return buckets;
  }
  function getMonthlyCountsRange(records, fromISO, toISO, dateField) {
    const buckets = [], idx = {}; let yr = +fromISO.substring(0, 4), mo = +fromISO.substring(5, 7) - 1;
    const eYr = +toISO.substring(0, 4), eMo = +toISO.substring(5, 7) - 1;
    while (yr < eYr || (yr === eYr && mo <= eMo)) {
      idx[yr + "-" + String(mo + 1).padStart(2, "0")] = buckets.length;
      buckets.push({ label: new Date(yr, mo, 1).toLocaleDateString("es-CO", { month: "short", year: "2-digit" }), count: 0 });
      mo++; if (mo > 11) { mo = 0; yr++; }
    }
    records.forEach(function (r) {
      const fr = r[dateField]; if (!fr || fr < fromISO || fr > toISO) return;
      const i = idx[fr.substring(0, 7)]; if (i !== undefined) buckets[i].count++;
    });
    return buckets;
  }
  function fechaMinima(records, dateField) {
    let min = null;
    records.forEach(function (r) { const f = r[dateField]; if (f && (!min || f < min)) min = f; });
    return min;
  }
  function getYearlyCounts(records, dateField) {
    const map = {};
    records.forEach(function (r) { const fr = r[dateField]; if (!fr) return; map[fr.substring(0, 4)] = (map[fr.substring(0, 4)] || 0) + 1; });
    return Object.keys(map).sort().map(function (y) { return { label: y, count: map[y] }; });
  }
  // Rango: el de los filtros de fecha si los hay; si no, desde el primer dato
  // ('desdeMin', que el llamador pasa igual para series que comparten eje) hasta
  // hoy. El gráfico se desplaza horizontalmente (ver ajustarScrollTendencia).
  // Tope de puntos para no crear un canvas gigante: 400 días / 160 semanas.
  const MAX_PUNTOS = { "día": 400, "semana": 160 };
  function getTendenciaCounts(records, period, dateField, filterObj, desdeMin) {
    if (period === "año") return getYearlyCounts(records, dateField);
    const hasta = (filterObj && filterObj.fechaHasta) || isoToday();
    let desde = (filterObj && filterObj.fechaDesde) || desdeMin || fechaMinima(records, dateField) || hasta;
    if (MAX_PUNTOS[period]) {
      const tope = new Date(hasta + "T00:00:00");
      tope.setDate(tope.getDate() - (period === "día" ? MAX_PUNTOS[period] - 1 : MAX_PUNTOS[period] * 7 - 1));
      if (desde < isoDe(tope)) desde = isoDe(tope);
    }
    if (period === "día") return getDailyCountsRange(records, desde, hasta, dateField);
    if (period === "mes") return getMonthlyCountsRange(records, desde, hasta, dateField);
    return getWeeklyCountsRange(records, desde, hasta, dateField);
  }
  // Ancho del lienzo según la cantidad de puntos; se abre mostrando lo más reciente.
  function ajustarScrollTendencia(innerId, nPuntos) {
    const inner = document.getElementById(innerId); if (!inner) return;
    const wrap = inner.parentElement, pW = wrap ? wrap.clientWidth : 0;
    const px = TENDENCY_PERIOD === "día" ? 30 : 42;
    inner.style.width = Math.max(nPuntos * px, pW || 300) + "px";
    if (wrap) requestAnimationFrame(function () { wrap.scrollLeft = wrap.scrollWidth; });
  }
  // Opciones de línea para lienzos anchos: limita la resolución para no pasar el
  // máximo de ancho de canvas del navegador (~32.000 px).
  function lineOptsAncho(innerId, extra) {
    const inner = document.getElementById(innerId), w = inner ? parseInt(inner.style.width, 10) || 1000 : 1000;
    return Object.assign(lineOpts(extra), { devicePixelRatio: Math.min(window.devicePixelRatio || 1, 30000 / w) });
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
    return r.progreso_raw;  // ya es % del ANS en ambas fuentes (ver cabecera)
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
  function esAbierto(r) { return ESTADOS_CERRADOS.indexOf(r.estado) === -1; }
  const CLASIF_LABEL = { Vencido: "Vencido", Critico: "Crítico", Riesgo: "En riesgo", Normal: "A tiempo" };
  function clasificacionCaso(r) { return CLASIF_LABEL[ansResultado(r)]; }
  const CLASIF_PILL = { "Vencido": "vencido", "Crítico": "critico", "En riesgo": "riesgo", "A tiempo": "normal" };
  function clasificacionPillHTML(c) {
    return CLASIF_PILL[c] ? '<span class="status-pill status-pill--' + CLASIF_PILL[c] + '">' + esc(c) + '</span>' : '<span class="area-chip">' + esc(c) + '</span>';
  }
  // Autor -> uno de los gestores (sin importar tildes/mayúsculas) o "Otros autores". Se memoriza por caso.
  const _autoresNorm = {};
  function autorGrupo(r) {
    if (r._autorGrupo === undefined) {
      if (!_autoresNorm._listo) { AUTORES_GESTORES.forEach(function (a) { _autoresNorm[normalizeName(a)] = a; }); _autoresNorm._listo = true; }
      r._autorGrupo = _autoresNorm[normalizeName(r.autor)] || AUTOR_OTROS;
    }
    return r._autorGrupo;
  }
  // Las cuatro categorías fijas, más "Otros / Histórico" solo si algún caso cae ahí.
  function catsPresentes() {
    const hayOtros = STATE.rawCasos.some(function (r) { return nivel1Effective(r) === NIVEL1_OTROS; });
    return hayOtros ? NIVEL1_CATS.concat([NIVEL1_OTROS]) : NIVEL1_CATS.slice();
  }
  // Resultado de ANS del caso: histórico = columna TIEMPO RESPUESTA; nuevo = según Progreso.
  function ansResultado(r) {
    if (r.fuente === "historico" && ANS_HISTORICO[r.cumplimiento_ans]) return ANS_HISTORICO[r.cumplimiento_ans];
    return classify(effectiveProgreso(r));
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
    STATE.conteoCats = {};
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
      if (CASOS_FILTER.clasificacion.length && CASOS_FILTER.clasificacion.indexOf(clasificacionCaso(r)) === -1) return false;
      if (CASOS_FILTER.autor.length && CASOS_FILTER.autor.indexOf(autorGrupo(r)) === -1) return false;
      if (CASOS_FILTER.condicion.length) {
        const cond = ESTADOS_CERRADOS.indexOf(r.estado) !== -1 ? "Cerrados" : "Abiertos";
        if (CASOS_FILTER.condicion.indexOf(cond) === -1) return false;
      }
      if (CASOS_FILTER.fechaDesde && (r.fecha_registro || "") < CASOS_FILTER.fechaDesde) return false;
      if (CASOS_FILTER.fechaHasta && (r.fecha_registro || "") > CASOS_FILTER.fechaHasta) return false;
      // Conteo por categoría para el submenú (con los filtros, sin la categoría activa).
      STATE.conteoCats[n1] = (STATE.conteoCats[n1] || 0) + 1;
      if (_casosActiveCat && n1 !== _casosActiveCat) return false;
      return true;
    });
  }
  function filtrarCasosExec() {
    const f = EXEC_FILTER;
    return STATE.rawCasos.filter(function (r) {
      if (f.nivel1.length && f.nivel1.indexOf(nivel1Effective(r)) === -1) return false;
      if (f.nivel2.length && f.nivel2.indexOf(r.nivel2) === -1) return false;
      if (f.grupo.length && f.grupo.indexOf(r.grupo_responsable) === -1) return false;
      if (f.fuente.length && f.fuente.indexOf(r.fuente) === -1) return false;
      if (f.condicion.length && f.condicion.indexOf(esAbierto(r) ? "Abiertos" : "Cerrados") === -1) return false;
      if (f.fechaDesde && (r.fecha_registro || "") < f.fechaDesde) return false;
      if (f.fechaHasta && (r.fecha_registro || "") > f.fechaHasta) return false;
      return true;
    });
  }
  function filtrarTareasExec() {
    const f = EXEC_FILTER;
    return STATE.rawTareas.filter(function (t) {
      if (f.fechaDesde && (t.fecha_creacion || "") < f.fechaDesde) return false;
      if (f.fechaHasta && (t.fecha_creacion || "") > f.fechaHasta) return false;
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
    let vencidos = 0, criticos = 0, riesgo = 0, normal = 0, sumTiempo = 0, abiertos = 0, vencidosCerrados = 0;
    const vencidosPorResponsable = {}, vencidosPorCategoria = {}, porNivel1 = {};
    const ans = { Normal: 0, Riesgo: 0, Critico: 0, Vencido: 0 };
    records.forEach(function (r) {
      const cls = effectiveClass(r);
      const resAns = ansResultado(r);
      if (esAbierto(r)) abiertos++; else if (resAns === "Vencido") vencidosCerrados++;
      ans[resAns]++;
      if (cls === "Vencido") vencidos++; else if (cls === "Critico") criticos++; else if (cls === "Riesgo") riesgo++; else normal++;
      sumTiempo += (r.tiempo_transcurrido_dias || 0);
      const n1 = nivel1Effective(r);
      if (!porNivel1[n1]) porNivel1[n1] = { total: 0, vencidos: 0, criticos: 0, riesgo: 0, abiertos: 0, ans: { Normal: 0, Riesgo: 0, Critico: 0, Vencido: 0 } };
      porNivel1[n1].total++;
      if (esAbierto(r)) porNivel1[n1].abiertos++;
      porNivel1[n1].ans[ansResultado(r)]++;
      if (cls === "Vencido") { porNivel1[n1].vencidos++; vencidosPorResponsable[r.responsable || "Sin asignar"] = (vencidosPorResponsable[r.responsable || "Sin asignar"] || 0) + 1; vencidosPorCategoria[r.categoria || "Sin categoría"] = (vencidosPorCategoria[r.categoria || "Sin categoría"] || 0) + 1; }
      else if (cls === "Critico") porNivel1[n1].criticos++;
      else if (cls === "Riesgo") porNivel1[n1].riesgo++;
    });
    return { total: total, vencidos: vencidos, criticos: criticos, riesgo: riesgo, normal: normal,
      abiertos: abiertos, cerrados: total - abiertos, vencidosCerrados: vencidosCerrados, ans: ans,
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

  // cache "no-cache": el navegador siempre pregunta al servidor, pero si el archivo
  // no cambió recibe un 304 y no vuelve a descargar los ~10 MB de casos.
  // 'generado_en' (lo pone el pipeline) indica si hay datos nuevos que dibujar.
  function loadCasos() {
    return fetch(CONFIG.casosSource, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (json) {
        const gen = json && json.generado_en;
        if (!gen || gen !== STATE.genCasos) { STATE.rawCasos = (json && Array.isArray(json.casos)) ? json.casos : []; STATE.genCasos = gen; STATE.datosCambiaron = true; }
        STATE.errorCasos = null;
      })
      .catch(function (err) { STATE.errorCasos = "Origen no disponible (" + err.message + ")"; if (!STATE.rawCasos.length) STATE.rawCasos = []; });
  }
  function loadTareas() {
    return fetch(CONFIG.tareasSource, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (json) {
        const gen = json && json.generado_en;
        if (!gen || gen !== STATE.genTareas) { STATE.rawTareas = (json && Array.isArray(json.tareas)) ? json.tareas : []; STATE.genTareas = gen; STATE.datosCambiaron = true; }
        STATE.errorTareas = null;
      })
      .catch(function (err) { STATE.errorTareas = "Origen no disponible (" + err.message + ")"; if (!STATE.rawTareas.length) STATE.rawTareas = []; });
  }
  function loadAllData(isManual) {
    setSyncStatus("syncing");
    STATE.datosCambiaron = false;
    return Promise.all([loadCasos(), loadTareas()]).then(function () {
      STATE.lastUpdated = new Date();
      const hasError = !!(STATE.errorCasos || STATE.errorTareas);
      const allError = !!(STATE.errorCasos && STATE.errorTareas);
      setSyncStatus(allError ? "error" : (hasError ? "partial" : "ok"));
      renderErrorBanners();
      // Sin datos nuevos no hay nada que redibujar (evita congelar la página cada 5 min).
      if (STATE.firstLoadDone && !STATE.datosCambiaron) return;
      if (!STATE.firstLoadDone) { initEstadoFilterCasos(); initEstadoFilterTareas(); }
      populateCasosFilterBar(); populateTareasFilterBar(); populateExecFilterBar();
      renderAll();
      STATE.firstLoadDone = true;
    });
  }

  function initEstadoFilterCasos() {
    // Por defecto todos los estados, para que indicadores y gráficos cubran el
    // histórico completo; "Condición" permite quedarse solo con abiertos o cerrados.
    CASOS_FILTER.estado = [];
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
    _vistaActual = key;
    updateViewTitle();
    renderVista(key);
    document.body.classList.remove("sidebar-is-open");
    const sidebar = document.getElementById("sidebar"), overlay = document.getElementById("sidebarOverlay");
    if (sidebar) sidebar.classList.remove("is-open"); if (overlay) overlay.classList.remove("is-open");
    setTimeout(function () { Object.keys(chartRegistry).forEach(function (id) { if (chartRegistry[id]) { try { chartRegistry[id].resize(); } catch (e) {} } }); }, 60);
  }

  // En Casos el título incluye la categoría activa ("Casos · Financiero").
  function updateViewTitle() {
    let title = VIEW_TITLES[_vistaActual] || _vistaActual;
    if (_vistaActual === "casos" && _casosActiveCat) title += " · " + _casosActiveCat;
    const titleEl = document.getElementById("viewTitle"), crumbEl = document.getElementById("breadcrumbCurrent");
    if (titleEl) titleEl.textContent = title; if (crumbEl) crumbEl.textContent = title;
  }

  // Enlace directo a una vista: #casos/Financiero, #gestion, #tareas…
  function abrirDesdeHash() {
    const partes = decodeURIComponent(location.hash.replace(/^#/, "")).split("/");
    if (!VIEW_TITLES[partes[0]]) return;
    switchView(partes[0]);
    if (partes[0] === "casos" && partes[1] && NIVEL1_CATS.indexOf(partes[1]) !== -1) setCasosCat(partes[1]);
  }

  function wireGestionTabs() {
    const tabsEl = document.getElementById("gestionTabs"); if (!tabsEl) return;
    tabsEl.querySelectorAll(".resp-tab-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const tab = this.getAttribute("data-tab");
        tabsEl.querySelectorAll(".resp-tab-btn").forEach(function (b) { b.classList.toggle("is-active", b === btn); });
        document.querySelectorAll(".gestion-sub").forEach(function (sv) { sv.classList.toggle("is-active", sv.id === "gestionSub-" + tab); });
        closeAllDropdowns();
        // Los gráficos dibujados con la sub-vista oculta quedan en 0×0: se reajustan al mostrarla.
        setTimeout(function () { Object.keys(chartRegistry).forEach(function (id) { try { chartRegistry[id].resize(); } catch (e) {} }); }, 60);
      });
    });
  }

  /* ============================ RENDERIZADO ============================ */

  // Qué dibuja cada vista. Solo se dibuja la vista visible; las demás quedan
  // pendientes y se dibujan al entrar (switchView). Así un cambio de filtro no
  // redibuja tablas y gráficos ocultos, y los gráficos nunca se crean en 0×0.
  const VIEW_RENDERERS = {
    resumen: [["Resumen ejecutivo", renderExecutive]],
    casos: [["Casos", renderCasosView]],
    tareas: [["Tareas", renderTareasView]],
    gestion: [["Atención Prioritaria", renderAttention], ["Responsables", renderResponsables], ["Grupos", renderGrupos]]
  };
  let _vistasPendientes = {};

  function renderAll() {
    applyCasosFilter(); applyTareasFilter();
    STATE.statsCasos = computeCasosStats(STATE.casos);
    STATE.statsTareas = computeTareasStats(STATE.tareas);
    updateLastUpdatedUI();
    updateSidebarBadges();
    renderNavCasosSub();
    STATE.errorRender = [];
    Object.keys(VIEW_RENDERERS).forEach(function (k) { _vistasPendientes[k] = true; });
    renderVista(_vistaActual);
  }

  function renderVista(key) {
    if (!_vistasPendientes[key]) return;
    delete _vistasPendientes[key];
    // Cada sección en su propio try/catch: si una falla (p.ej. falta Chart.js o
    // DataTables), las demás igual se dibujan.
    (VIEW_RENDERERS[key] || []).forEach(function (sec) {
      try { sec[1](); } catch (e) { console.error("[render] " + sec[0] + ":", e); STATE.errorRender.push(sec[0] + " (" + e.message + ")"); }
    });
    renderErrorBanners();
  }

  function updateSidebarBadges() {
    const navAtencion = document.getElementById("navBadgeAtencion");
    // Vencidos + críticos: solo pueden ser casos abiertos, así que basta con recorrer esos.
    if (navAtencion) navAtencion.textContent = STATE.rawCasos.filter(function (r) {
      if (!esAbierto(r)) return false;
      const cls = effectiveClass(r); return cls === "Vencido" || cls === "Critico";
    }).length;
    const navCasos = document.getElementById("navBadgeCasos");
    if (navCasos) navCasos.textContent = STATE.statsCasos.abiertos;
    const navTareas = document.getElementById("navBadgeTareas");
    if (navTareas) navTareas.textContent = STATE.statsTareas.pendientes;
  }

  /* ---------------------- RESUMEN EJECUTIVO ---------------------- */

  function populateExecFilterBar() {
    const bar = document.getElementById("execFilterBar"); if (!bar) return;
    function uniqueVals(field) { return Array.from(new Set(STATE.rawCasos.map(function (r) { return r[field] || ""; }).filter(Boolean))).sort(); }
    const nivel2Opts = Array.from(new Set(STATE.rawCasos.filter(function (r) {
      return !EXEC_FILTER.nivel1.length || EXEC_FILTER.nivel1.indexOf(nivel1Effective(r)) !== -1;
    }).map(function (r) { return r.nivel2; }).filter(function (v) { return v && v !== "N/A"; }))).sort();
    const dropsHtml =
      buildMsDropHTML("nivel1", "Tipo de servicio", "bi-collection", catsPresentes(), EXEC_FILTER) +
      buildMsDropHTML("nivel2", "Subcategoría", "bi-diagram-2", nivel2Opts, EXEC_FILTER) +
      buildMsDropHTML("grupo", "Grupo", "bi-building", uniqueVals("grupo_responsable"), EXEC_FILTER) +
      buildMsDropHTML("condicion", "Condición", "bi-toggle2-on", ["Abiertos", "Cerrados"], EXEC_FILTER) +
      buildMsDropHTML("fuente", "Origen", "bi-database", uniqueVals("fuente"), EXEC_FILTER);
    bar.innerHTML = '<div class="gfb-inner"><span class="gfb-title"><i class="bi bi-funnel-fill"></i> Filtros</span>' +
      '<div class="gfb-drops" id="execFilterDrops">' + dropsHtml + '</div>' +
      '<div class="gfb-dates"><div class="filter-group"><label for="execFechaDesde">Desde</label>' +
      '<input type="date" id="execFechaDesde" class="filter-select filter-select--sm"' + (EXEC_FILTER.fechaDesde ? ' value="' + EXEC_FILTER.fechaDesde + '"' : '') + '></div>' +
      '<div class="filter-group"><label for="execFechaHasta">Hasta</label>' +
      '<input type="date" id="execFechaHasta" class="filter-select filter-select--sm"' + (EXEC_FILTER.fechaHasta ? ' value="' + EXEC_FILTER.fechaHasta + '"' : '') + '></div></div>' +
      '<button class="gfb-clear" id="execFilterClear"><i class="bi bi-x-circle"></i> Limpiar</button></div>';
    let nivel1Previo = EXEC_FILTER.nivel1.join("|");
    wireFilterBar("execFilterBar", "execFilterDrops", EXEC_FILTER, function () {
      // Si cambió la categoría, las subcategorías disponibles cambian: se rearma la barra.
      if (EXEC_FILTER.nivel1.join("|") !== nivel1Previo) { EXEC_FILTER.nivel2 = []; populateExecFilterBar(); }
      renderAll();
    }, ["execFechaDesde", "execFechaHasta"]);
    const clearBtn = document.getElementById("execFilterClear");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      Object.keys(EXEC_FILTER).forEach(function (k) { EXEC_FILTER[k] = Array.isArray(EXEC_FILTER[k]) ? [] : ""; });
      populateExecFilterBar(); renderAll();
    });
  }

  function renderExecutive() {
    STATE.execCasos = filtrarCasosExec(); STATE.execTareas = filtrarTareasExec();
    STATE.statsExec = computeCasosStats(STATE.execCasos);
    STATE.statsExecTareas = computeTareasStats(STATE.execTareas);
    const s = STATE.statsExec, st = STATE.statsExecTareas;
    const grid = document.getElementById("kpiExecGrid");
    if (grid) {
      grid.innerHTML =
        kpi("Total de casos", s.total, "info", "bi-collection", s.abiertos + " abiertos · " + s.cerrados + " cerrados") +
        kpi("Cumplimiento ANS", pct(s.ans.Normal, s.total) + "%", "sla", "bi-stopwatch", s.ans.Normal + " casos a tiempo") +
        kpi("Vencidos", s.vencidos, "vencido", "bi-x-octagon", "abiertos · " + pct(s.vencidos, s.abiertos) + "% de los abiertos") +
        kpi("Vencidos cerrados", s.vencidosCerrados, "vencido", "bi-archive", pct(s.vencidosCerrados, s.cerrados) + "% de los cerrados") +
        kpi("Críticos", s.criticos, "critico", "bi-exclamation-triangle", "abiertos · " + pct(s.criticos, s.abiertos) + "% de los abiertos") +
        kpi("En riesgo", s.riesgo, "riesgo", "bi-shield-exclamation", "abiertos · " + pct(s.riesgo, s.abiertos) + "% de los abiertos") +
        kpi("Tiempo promedio", s.avgTiempo + " días", "normal", "bi-clock-history", "transcurrido por caso") +
        kpi("Tareas pendientes", st.pendientes, "info", "bi-list-check", st.total + " tareas en total");
    }
    renderExecCharts();
    renderComparativoNivel1();
  }

  function renderExecCharts() {
    const periodContainer = document.getElementById("execTendPeriod");
    if (periodContainer) { periodContainer.innerHTML = buildPeriodBtnsHTML(); wireTendencyBtns(periodContainer); }

    // Casos y Tareas sobre el mismo periodo (el rango de fechas de los filtros del
    // resumen, o el rango por defecto), para que ambas series compartan etiquetas.
    const minC = fechaMinima(STATE.execCasos, "fecha_registro"), minT = fechaMinima(STATE.execTareas, "fecha_creacion");
    const desdeMin = [minC, minT].filter(Boolean).sort()[0];
    const casosBuckets = getTendenciaCounts(STATE.execCasos, TENDENCY_PERIOD, "fecha_registro", EXEC_FILTER, desdeMin);
    const tareasBuckets = getTendenciaCounts(STATE.execTareas, TENDENCY_PERIOD, "fecha_creacion", EXEC_FILTER, desdeMin);
    // Días/semanas/meses: mismo rango, así que los buckets coinciden uno a uno.
    // Años: cada serie trae sus propios años y se alinean por etiqueta.
    let labels = casosBuckets.map(function (b) { return b.label; });
    let serie = function (buckets) { return buckets.map(function (b) { return b.count; }); };
    if (TENDENCY_PERIOD === "año") {
      labels = Array.from(new Set(labels.concat(tareasBuckets.map(function (b) { return b.label; })))).sort();
      serie = function (buckets) { const m = {}; buckets.forEach(function (b) { m[b.label] = b.count; }); return labels.map(function (l) { return m[l] || 0; }); };
    }
    ajustarScrollTendencia("execTendInner", labels.length);
    renderChart("chartExecTendencia", "line", { labels: labels, datasets: [
      { label: "Casos creados", data: serie(casosBuckets), borderColor: "#8C0F13", backgroundColor: "#8C0F1322", fill: true },
      { label: "Tareas creadas", data: serie(tareasBuckets), borderColor: "#4A6B8C", backgroundColor: "#4A6B8C22", fill: true }
    ] }, lineOptsAncho("execTendInner"));

    renderChart("chartExecClasificacion", "doughnut", toChartDataDoughnut(STATE.statsExec.ans, ANS_LABELS, ANS_COLORS), doughnutOpts());
  }

  function renderComparativoNivel1() {
    const cats = catsPresentes();
    const s = STATE.statsExec;
    const tbody = document.querySelector("#tableComparativo tbody");
    if (tbody) {
      let html = "";
      cats.forEach(function (c) {
        const d = s.porNivel1[c] || { total: 0, vencidos: 0, criticos: 0, riesgo: 0, abiertos: 0, ans: { Normal: 0 } };
        const aTiempo = pct(d.ans.Normal, d.total);
        html += '<tr>' +
          '<td>' + nivel1ChipHTML(c) + '</td>' +
          '<td data-order="' + d.total + '">' + d.total + '</td>' +
          '<td data-order="' + d.abiertos + '">' + d.abiertos + '</td>' +
          '<td data-order="' + aTiempo + '">' + (d.total ? aTiempo + '%' : '—') + '</td>' +
          '<td data-order="' + d.vencidos + '">' + d.vencidos + '</td>' +
          '<td data-order="' + d.criticos + '">' + d.criticos + '</td>' +
          '<td data-order="' + d.riesgo + '">' + d.riesgo + '</td>' +
          '</tr>';
      });
      tbody.innerHTML = html;
    }
    initDataTable("#tableComparativo", { paging: false, searching: false, info: false, order: [] });

    renderAnsPorCategoria("chartComparativoStack", s, cats);
  }

  // Barras apiladas: resultado de ANS (a tiempo / riesgo / crítico / vencido) por categoría.
  function renderAnsPorCategoria(canvasId, stats, cats) {
    const datasets = ["Normal", "Riesgo", "Critico", "Vencido"].map(function (cls) {
      return { label: ANS_LABELS[cls], backgroundColor: ANS_COLORS[cls],
        data: cats.map(function (c) { const d = stats.porNivel1[c]; return d ? d.ans[cls] : 0; }) };
    });
    renderChart(canvasId, "bar", { labels: cats, datasets: datasets }, stackedBarOpts());
  }

  /* ---------------------- ATENCIÓN PRIORITARIA ---------------------- */

  // Atención Prioritaria mira todos los casos (no depende de los filtros de Casos)
  // y tiene su propia barra de filtros sobre los casos abiertos vencidos o críticos.
  function casosEnAtencion() {
    return STATE.rawCasos.filter(function (r) {
      if (!esAbierto(r)) return false;
      const cls = effectiveClass(r); return cls === "Vencido" || cls === "Critico";
    });
  }
  function populateAtencionFilterBar() {
    const bar = document.getElementById("atencionFilterBar"); if (!bar) return;
    const base = casosEnAtencion();
    const enCat = base.filter(function (r) { return !ATENCION_FILTER.nivel1.length || ATENCION_FILTER.nivel1.indexOf(nivel1Effective(r)) !== -1; });
    function uniqueVals(records, field) { return Array.from(new Set(records.map(function (r) { return r[field] || ""; }).filter(function (v) { return v && v !== "N/A"; }))).sort(); }
    const dropsHtml =
      buildMsDropHTML("clasificacion", "Clasificación", "bi-exclamation-triangle", ["Vencido", "Crítico"], ATENCION_FILTER) +
      buildMsDropHTML("nivel1", "Tipo de servicio", "bi-collection", catsPresentes().filter(function (c) { return base.some(function (r) { return nivel1Effective(r) === c; }); }), ATENCION_FILTER) +
      buildMsDropHTML("nivel2", "Subcategoría", "bi-diagram-2", uniqueVals(enCat, "nivel2"), ATENCION_FILTER) +
      buildMsDropHTML("grupo", "Grupo", "bi-building", uniqueVals(base, "grupo_responsable"), ATENCION_FILTER) +
      buildMsDropHTML("responsable", "Responsable", "bi-person", uniqueVals(base, "responsable"), ATENCION_FILTER) +
      buildMsDropHTML("estado", "Estado", "bi-circle-half", uniqueVals(base, "estado"), ATENCION_FILTER);
    bar.innerHTML = '<div class="gfb-inner"><span class="gfb-title"><i class="bi bi-funnel-fill"></i> Filtros</span>' +
      '<div class="gfb-drops" id="atencionFilterDrops">' + dropsHtml + '</div>' +
      '<div class="gfb-dates"><div class="filter-group"><label for="atencionFechaDesde">Desde</label>' +
      '<input type="date" id="atencionFechaDesde" class="filter-select filter-select--sm"' + (ATENCION_FILTER.fechaDesde ? ' value="' + ATENCION_FILTER.fechaDesde + '"' : '') + '></div>' +
      '<div class="filter-group"><label for="atencionFechaHasta">Hasta</label>' +
      '<input type="date" id="atencionFechaHasta" class="filter-select filter-select--sm"' + (ATENCION_FILTER.fechaHasta ? ' value="' + ATENCION_FILTER.fechaHasta + '"' : '') + '></div></div>' +
      '<button class="gfb-clear" id="atencionFilterClear"><i class="bi bi-x-circle"></i> Limpiar</button></div>';
    const nivel1Previo = ATENCION_FILTER.nivel1.join("|");
    wireFilterBar("atencionFilterBar", "atencionFilterDrops", ATENCION_FILTER, function () {
      // Si cambió la categoría, las subcategorías disponibles cambian: se rearma la barra.
      if (ATENCION_FILTER.nivel1.join("|") !== nivel1Previo) { ATENCION_FILTER.nivel2 = []; populateAtencionFilterBar(); }
      renderAttentionContent();
    }, ["atencionFechaDesde", "atencionFechaHasta"]);
    const clearBtn = document.getElementById("atencionFilterClear");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      Object.keys(ATENCION_FILTER).forEach(function (k) { ATENCION_FILTER[k] = Array.isArray(ATENCION_FILTER[k]) ? [] : ""; });
      populateAtencionFilterBar(); renderAttentionContent();
    });
  }
  function renderAttention() { populateAtencionFilterBar(); renderAttentionContent(); }

  function renderAttentionContent() {
    const f = ATENCION_FILTER;
    const filtrados = casosEnAtencion().filter(function (r) {
      const n1 = nivel1Effective(r);
      if (f.clasificacion.length && f.clasificacion.indexOf(STATUS_LABELS[effectiveClass(r)]) === -1) return false;
      if (f.nivel1.length && f.nivel1.indexOf(n1) === -1) return false;
      if (f.nivel2.length && f.nivel2.indexOf(r.nivel2) === -1) return false;
      if (f.grupo.length && f.grupo.indexOf(r.grupo_responsable) === -1) return false;
      if (f.responsable.length && f.responsable.indexOf(r.responsable) === -1) return false;
      if (f.estado.length && f.estado.indexOf(r.estado) === -1) return false;
      if (f.fechaDesde && (r.fecha_registro || "") < f.fechaDesde) return false;
      if (f.fechaHasta && (r.fecha_registro || "") > f.fechaHasta) return false;
      return true;
    });
    const s = computeCasosStats(filtrados);
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

    const atencionCases = filtrados.slice().sort(function (a, b) { return effectiveProgreso(b) - effectiveProgreso(a); });

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
    // Dentro de una categoría, cada filtro solo ofrece los valores de esa categoría.
    const base = _casosActiveCat ? STATE.rawCasos.filter(function (r) { return nivel1Effective(r) === _casosActiveCat; }) : STATE.rawCasos;
    function uniqueVals(field) { return Array.from(new Set(base.map(function (r) { return r[field] || ""; }).filter(function (v) { return v && v !== "N/A"; }))).sort(); }
    const fields = [
      // Tipo de servicio solo en "Todas": dentro de una categoría ya está fijo.
      _casosActiveCat ? null : { key: "nivel1", label: "Tipo de servicio", icon: "bi-collection", opts: catsPresentes() },
      { key: "nivel2", label: "Subcategoría", icon: "bi-diagram-2", field: "nivel2" },
      { key: "nivel3", label: "Categoría específica", icon: "bi-diagram-3", field: "categoria" },
      { key: "clasificacion", label: "Clasificación", icon: "bi-exclamation-triangle", opts: CLASIFICACIONES },
      { key: "autor", label: "Autor", icon: "bi-person-plus", opts: AUTORES_GESTORES },
      { key: "grupo", label: "Grupo", icon: "bi-building", field: "grupo_responsable" },
      { key: "responsable", label: "Responsable", icon: "bi-person", field: "responsable" },
      { key: "estado", label: "Estado", icon: "bi-circle-half", field: "estado" },
      { key: "condicion", label: "Condición", icon: "bi-toggle2-on", opts: ["Abiertos", "Cerrados"] },
      { key: "tipoRegistro", label: "Canal de registro", icon: "bi-tag", field: "tipo_registro" },
      { key: "fuente", label: "Origen", icon: "bi-database", field: "fuente" }
    ].filter(Boolean);
    const dropsHtml = fields.map(function (f) { return buildMsDropHTML(f.key, f.label, f.icon, f.field ? uniqueVals(f.field) : f.opts, CASOS_FILTER); }).join("");
    bar.innerHTML = '<div class="gfb-inner"><span class="gfb-title"><i class="bi bi-funnel-fill"></i> Filtros</span>' +
      '<div class="gfb-drops" id="casosFilterDrops">' + dropsHtml + '</div>' +
      '<div class="gfb-dates"><div class="filter-group"><label for="casosFechaDesde">Desde</label>' +
      '<input type="date" id="casosFechaDesde" class="filter-select filter-select--sm"' + (CASOS_FILTER.fechaDesde ? ' value="' + CASOS_FILTER.fechaDesde + '"' : '') + '></div>' +
      '<div class="filter-group"><label for="casosFechaHasta">Hasta</label>' +
      '<input type="date" id="casosFechaHasta" class="filter-select filter-select--sm"' + (CASOS_FILTER.fechaHasta ? ' value="' + CASOS_FILTER.fechaHasta + '"' : '') + '></div></div>' +
      '<button class="gfb-clear" id="casosFilterClear"><i class="bi bi-x-circle"></i> Limpiar</button></div>';
    wireFilterBar("casosFilterBar", "casosFilterDrops", CASOS_FILTER, function () { renderAll(); }, ["casosFechaDesde", "casosFechaHasta"]);
    const clearBtn = document.getElementById("casosFilterClear");
    // "Limpiar" deja los filtros en blanco pero se queda en la categoría actual.
    if (clearBtn) clearBtn.addEventListener("click", function () { resetCasosFilter(); populateCasosFilterBar(); renderAll(); });
  }
  function resetCasosFilter() {
    Object.keys(CASOS_FILTER).forEach(function (k) { CASOS_FILTER[k] = Array.isArray(CASOS_FILTER[k]) ? [] : ""; });
  }

  // Único punto para cambiar la categoría activa de Casos (submenú del sidebar y
  // tarjetas de "Todas"). Cada categoría es su propio espacio: al entrar, los
  // filtros empiezan en blanco y solo ofrecen valores de esa categoría.
  function setCasosCat(cat) {
    _casosActiveCat = cat || null;
    resetCasosFilter();
    populateCasosFilterBar();
    updateViewTitle();
    renderAll();
    window.scrollTo(0, 0);
  }

  function renderNavCasosSub() {
    const sub = document.getElementById("navCasosSub"); if (!sub) return;
    // Conteo por categoría con los filtros de Casos pero sin la categoría activa (lo arma applyCasosFilter).
    const counts = STATE.conteoCats || {};
    const items = [["", "Todas", "bi-collection"]].concat(catsPresentes().map(function (c) { return [c, c, NIVEL1_ICON[c] || "bi-folder"]; }));
    sub.innerHTML = items.map(function (it) {
      const active = (_casosActiveCat || "") === it[0] ? " active" : "";
      const n = it[0] ? (counts[it[0]] || 0) : Object.keys(counts).reduce(function (s, k) { return s + counts[k]; }, 0);
      return '<button class="nav-sub-link' + active + '" data-cat="' + esc(it[0]) + '"><i class="bi ' + it[2] + '"></i><span>' + esc(it[1]) + '</span><span class="nav-sub-count">' + n.toLocaleString("es-CO") + '</span></button>';
    }).join("");
    sub.querySelectorAll(".nav-sub-link").forEach(function (btn) {
      btn.addEventListener("click", function () { switchView("casos"); setCasosCat(this.getAttribute("data-cat")); });
    });
  }

  function renderCasosView() {
    const s = STATE.statsCasos;
    const cats = catsPresentes();

    // Tarjetas por categoría: solo en "Todas". Dentro de una categoría no se ven las demás.
    const overview = document.getElementById("casosCatOverview");
    if (overview) overview.style.display = _casosActiveCat ? "none" : "";
    const tablaTitle = document.getElementById("casosTablaTitle");
    if (tablaTitle) tablaTitle.textContent = _casosActiveCat ? "Casos de " + _casosActiveCat : "Todos los casos";

    const catGrid = document.getElementById("kpiCategoriasGrid");
    if (catGrid && !_casosActiveCat) {
      catGrid.innerHTML = cats.map(function (c) {
        const d = s.porNivel1[c] || { total: 0, vencidos: 0, criticos: 0, riesgo: 0 };
        const key = NIVEL1_KEY[c] || "otro";
        const icon = NIVEL1_ICON[c] || "bi-collection";
        const active = _casosActiveCat === c ? " is-active" : "";
        return ('<div class="kpi-card kpi-card--cat-' + key + active + '" data-cat="' + esc(c) + '" style="cursor:pointer">' +
          '<div class="kpi-label"><i class="bi ' + icon + '"></i> ' + esc(c) + '</div>' +
          '<div class="kpi-value">' + d.total + '</div>' +
          '<div class="kpi-foot">' + d.vencidos + ' vencidos · ' + d.criticos + ' críticos</div></div>');
      }).join("");
      catGrid.querySelectorAll(".kpi-card").forEach(function (card) {
        card.addEventListener("click", function () { setCasosCat(this.getAttribute("data-cat")); });
      });
    }

    const kpiGrid = document.getElementById("kpiCasosGrid");
    if (kpiGrid) {
      kpiGrid.innerHTML =
        kpi("Casos en la vista", s.total, "info", "bi-collection", _casosActiveCat || "todas las categorías") +
        kpi("Abiertos", s.abiertos, "info", "bi-folder2-open", pct(s.abiertos, s.total) + "% del total") +
        kpi("Cerrados", s.cerrados, "sla", "bi-check2-all", pct(s.cerrados, s.total) + "% del total") +
        kpi("Cumplimiento ANS", pct(s.ans.Normal, s.total) + "%", "sla", "bi-stopwatch", s.ans.Vencido + " casos fuera de ANS") +
        kpi("Vencidos abiertos", s.vencidos, "vencido", "bi-x-octagon", s.criticos + " críticos · " + s.riesgo + " en riesgo") +
        kpi("Vencidos cerrados", s.vencidosCerrados, "vencido", "bi-archive", pct(s.vencidosCerrados, s.cerrados) + "% de los cerrados se cerró fuera del ANS") +
        kpi("Tiempo promedio", s.avgTiempo + " días", "normal", "bi-clock-history", "transcurrido por caso");
    }
    renderCasosCharts(s, cats);

    // Tabla alimentada con datos (no con HTML): con deferRender solo se crean las
    // filas de la página visible, y al filtrar se reemplazan los datos sin reconstruirla.
    const selAll = "#tableCasosAll";
    if (dtRegistry[selAll]) {
      dtRegistry[selAll].clear().rows.add(STATE.casos).draw();
    } else {
      const txt = function (d) { return esc(d); };
      dtRegistry[selAll] = $(selAll).DataTable({
        language: DT_LANG_ES, data: STATE.casos, deferRender: true,
        columns: [
          // No. de caso + número anterior (proyecto y número del sistema viejo): el número
          // solo se repite entre proyectos (CAE 3483 y PQRS 3483 son casos distintos).
          { data: null, render: function (d, type, r) {
            if (!r.caso_anterior) return esc(r.caso);
            return type === "display" ? esc(r.caso) + '<span class="progress-text"> · ant. ' + esc(r.caso_anterior) + '</span>'
              : r.caso + " " + r.caso_anterior;
          } },
          { data: "fecha_registro", render: txt },
          { data: "estado", render: txt },
          // Condición: Registrado, En Proceso y En Espera cuentan como abiertos (igual que las tarjetas).
          { data: null, render: function (d, type, r) {
            const cond = esAbierto(r) ? "Abierto" : "Cerrado";
            return type === "display" ? '<span class="cond-chip cond-chip--' + cond.toLowerCase() + '">' + cond + '</span>' : cond;
          } },
          { data: null, render: function (d, type, r) {
            const c = clasificacionCaso(r);
            if (type === "display") return clasificacionPillHTML(c);
            return type === "sort" ? CLASIFICACIONES.indexOf(c) : c;  // ordena Vencido primero
          } },
          { data: null, render: function (d, type, r) { const n1 = nivel1Effective(r); return type === "display" ? nivel1ChipHTML(n1) : n1; } },
          { data: "nivel2", render: txt }, { data: "autor", render: txt }, { data: "responsable", render: txt },
          { data: "grupo_responsable", render: txt }, { data: "tipo_registro", render: txt },
          { data: "fecha_estimada_solucion", render: txt }, { data: "fecha_modificacion", render: txt },
          { data: null, render: function (d, type, r) { const p = effectiveProgreso(r); return type === "display" ? progressCellHTML(p, effectiveClass(r)) : p; } },
          // Columna oculta para el orden inicial: abiertos primero (si no, quedan al
          // final porque los cerrados del histórico tienen progresos de miles de %).
          { data: null, visible: false, searchable: false, render: function (d, type, r) { return esAbierto(r) ? 1 : 0; } }
        ],
        columnDefs: [{ targets: "_all", defaultContent: "" }],
        createdRow: function (row, r) {
          const cls = effectiveClass(r);
          if (cls === "Vencido") row.classList.add("row--vencido"); else if (cls === "Critico") row.classList.add("row--critico");
        },
        paging: true, pageLength: 15, order: [[14, "desc"], [13, "desc"]], dom: "frtipB", buttons: DT_BUTTONS
      });
    }
  }

  function renderCasosCharts(s, cats) {
    const recs = STATE.casos;

    // Tendencia: una serie por categoría (o solo la activa).
    const periodContainer = document.getElementById("casosTendPeriod");
    if (periodContainer) { periodContainer.innerHTML = buildPeriodBtnsHTML(); wireTendencyBtns(periodContainer); }
    const series = _casosActiveCat ? [_casosActiveCat] : cats;
    const tendTitle = document.getElementById("casosTendTitle");
    if (tendTitle) tendTitle.textContent = _casosActiveCat ? "Casos registrados" : "Casos registrados por categoría";
    // Todas las series usan el mismo rango (desde el primer caso de la vista) para
    // compartir eje; por años se alinean por etiqueta.
    const desdeMin = fechaMinima(recs, "fecha_registro");
    const porSerie = series.map(function (c) {
      return getTendenciaCounts(recs.filter(function (r) { return nivel1Effective(r) === c; }), TENDENCY_PERIOD, "fecha_registro", CASOS_FILTER, desdeMin);
    });
    const labels = TENDENCY_PERIOD === "año"
      ? Array.from(new Set([].concat.apply([], porSerie).map(function (b) { return b.label; }))).sort()
      : (porSerie[0] || []).map(function (b) { return b.label; });
    const datasets = series.map(function (c, i) {
      const m = {}; porSerie[i].forEach(function (b, j) { m[TENDENCY_PERIOD === "año" ? b.label : j] = b.count; });
      const color = SERIES_PALETTE[i % SERIES_PALETTE.length];
      return { label: c, data: labels.map(function (l, j) { return m[TENDENCY_PERIOD === "año" ? l : j] || 0; }),
        borderColor: color, backgroundColor: color + "22", fill: series.length === 1 };
    });
    ajustarScrollTendencia("casosTendInner", labels.length);
    renderChart("chartCasosTendencia", "line", { labels: labels, datasets: datasets }, lineOptsAncho("casosTendInner"));

    const porNivel2 = {}, porResp = {};
    recs.forEach(function (r) {
      if (r.nivel2 && r.nivel2 !== "N/A") porNivel2[r.nivel2] = (porNivel2[r.nivel2] || 0) + 1;
      const resp = r.responsable && r.responsable !== "N/A" ? r.responsable : "Sin asignar";
      porResp[resp] = (porResp[resp] || 0) + 1;
    });
    renderChart("chartCasosNivel2", "bar", toChartDataBar(porNivel2, "#8C0F13", 12), horizontalBarOpts());

    // Casos por grupo responsable (hasta 15), apilados en abiertos y cerrados.
    const porGrupo = {};
    recs.forEach(function (r) {
      const g = r.grupo_responsable && r.grupo_responsable !== "N/A" ? r.grupo_responsable : "Sin grupo";
      if (!porGrupo[g]) porGrupo[g] = { abiertos: 0, cerrados: 0 };
      porGrupo[g][esAbierto(r) ? "abiertos" : "cerrados"]++;
    });
    const topGrupos = Object.keys(porGrupo).sort(function (a, b) {
      return (porGrupo[b].abiertos + porGrupo[b].cerrados) - (porGrupo[a].abiertos + porGrupo[a].cerrados);
    }).slice(0, 15);
    const cvGrupo = document.getElementById("chartCasosGrupo");
    if (cvGrupo && cvGrupo.parentElement) cvGrupo.parentElement.style.height = Math.max(200, topGrupos.length * 30 + 70) + "px";
    renderChart("chartCasosGrupo", "bar", { labels: topGrupos, datasets: [
      { label: "Abiertos", data: topGrupos.map(function (g) { return porGrupo[g].abiertos; }), backgroundColor: "#C0151A" },
      { label: "Cerrados", data: topGrupos.map(function (g) { return porGrupo[g].cerrados; }), backgroundColor: "#9C8C7E" }
    ] }, Object.assign(stackedBarOpts(), { indexAxis: "y", scales: { x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }, y: { stacked: true, grid: { display: false } } } }));
    renderChart("chartCasosAns", "doughnut", toChartDataDoughnut(s.ans, ANS_LABELS, ANS_COLORS), doughnutOpts());
    // En "Todas": ANS por categoría. Dentro de una categoría: ANS por subcategoría (top 10).
    const ansTitle = document.getElementById("casosAnsCatTitle");
    if (ansTitle) ansTitle.textContent = _casosActiveCat ? "Cumplimiento de ANS por subcategoría" : "Cumplimiento de ANS por categoría";
    if (_casosActiveCat) {
      const topSub = sortedEntries(porNivel2, 10).map(function (e) { return e[0]; });
      const ansSub = {};
      recs.forEach(function (r) {
        if (topSub.indexOf(r.nivel2) === -1) return;
        if (!ansSub[r.nivel2]) ansSub[r.nivel2] = { Normal: 0, Riesgo: 0, Critico: 0, Vencido: 0 };
        ansSub[r.nivel2][ansResultado(r)]++;
      });
      renderChart("chartCasosAnsCat", "bar", { labels: topSub, datasets: ["Normal", "Riesgo", "Critico", "Vencido"].map(function (cls) {
        return { label: ANS_LABELS[cls], backgroundColor: ANS_COLORS[cls], data: topSub.map(function (n2) { return ansSub[n2][cls]; }) };
      }) }, Object.assign(stackedBarOpts(), { indexAxis: "y", scales: { x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }, y: { stacked: true, grid: { display: false } } } }));
    } else {
      renderAnsPorCategoria("chartCasosAnsCat", s, cats);
    }
    renderChart("chartCasosEstado", "doughnut", toChartDataDoughnut(countBy(recs, "estado"), null, null), doughnutOpts());
    renderChart("chartCasosResponsables", "bar", toChartDataBar(porResp, "#4A6B8C", 10), horizontalBarOpts());
    renderChart("chartCasosCanal", "doughnut", toChartDataDoughnut(countBy(recs, "tipo_registro"), null, null), doughnutOpts());
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

    // Tendencia con selector de periodo (días, semanas, meses, años), igual que en Casos.
    const periodContainer = document.getElementById("tareasTendPeriod");
    if (periodContainer) { periodContainer.innerHTML = buildPeriodBtnsHTML(); wireTendencyBtns(periodContainer); }
    const buckets = getTendenciaCounts(STATE.tareas, TENDENCY_PERIOD, "fecha_creacion", TAREAS_FILTER);
    ajustarScrollTendencia("tareasTendInner", buckets.length);
    renderChart("chartTareasTendencia", "line", { labels: buckets.map(function (b) { return b.label; }),
      datasets: [{ label: "Tareas creadas", data: buckets.map(function (b) { return b.count; }), borderColor: "#4A6B8C", backgroundColor: "#4A6B8C22", fill: true }] },
      lineOptsAncho("tareasTendInner", { plugins: { legend: { display: false } } }));

    // Tareas por responsable (top 15 por total), apiladas en completadas y pendientes.
    const porResp = {};
    STATE.tareas.forEach(function (t) {
      const r = t.responsable && t.responsable !== "N/A" ? t.responsable : "Sin asignar";
      if (!porResp[r]) porResp[r] = { completadas: 0, pendientes: 0 };
      porResp[r][tareaCompletada(t) ? "completadas" : "pendientes"]++;
    });
    const topResp = Object.keys(porResp).sort(function (a, b) {
      return (porResp[b].completadas + porResp[b].pendientes) - (porResp[a].completadas + porResp[a].pendientes);
    }).slice(0, 15);
    const wrapResp = document.getElementById("chartTareasResponsable");
    if (wrapResp && wrapResp.parentElement) wrapResp.parentElement.style.height = Math.max(200, topResp.length * 34 + 70) + "px";
    renderChart("chartTareasResponsable", "bar", { labels: topResp, datasets: [
      { label: "Completadas", data: topResp.map(function (r) { return porResp[r].completadas; }), backgroundColor: "#2a7a3b" },
      { label: "Pendientes", data: topResp.map(function (r) { return porResp[r].pendientes; }), backgroundColor: "#D9A441" }
    ] }, Object.assign(stackedBarOpts(), { indexAxis: "y", scales: { x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }, y: { stacked: true, grid: { display: false } } } }));

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

  /* ---------------------- RESPONSABLES (Casos + Tareas combinados) ---------------------- */

  function computeResponsablesCombined() {
    const byResp = {};
    function ensure(nombre) {
      if (!byResp[nombre]) byResp[nombre] = { nombre: nombre, totalCasos: 0, abiertos: 0, vencidosActivos: 0, criticosActivos: 0, vencidosCerrados: 0, solucionados: 0, tiemposSol: [], totalTareas: 0, tareasPendientes: 0, categorias: {} };
      return byResp[nombre];
    }
    STATE.rawCasos.forEach(function (r) {
      const nombre = r.responsable || "Sin asignar";
      if (RESP_FILTER.responsable.length && RESP_FILTER.responsable.indexOf(nombre) === -1) return;
      if (RESP_FILTER.grupo.length && RESP_FILTER.grupo.indexOf(r.grupo_responsable) === -1) return;
      if (RESP_FILTER.nivel1.length && RESP_FILTER.nivel1.indexOf(nivel1Effective(r)) === -1) return;
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
        if (ansResultado(r) === "Vencido") d.vencidosCerrados++;  // cerrado fuera del ANS
        if (r.tiempo_transcurrido_dias != null) d.tiemposSol.push(r.tiempo_transcurrido_dias);
      }
    });
    // Hay pocos responsables distintos en Tareas: se cruza cada nombre una sola vez.
    const cruce = {};
    STATE.rawTareas.forEach(function (t) {
      const f = t.fecha_creacion || "";
      if (RESP_FILTER.fechaDesde && f < RESP_FILTER.fechaDesde) return;
      if (RESP_FILTER.fechaHasta && f > RESP_FILTER.fechaHasta) return;
      const clave = t.responsable || "";
      if (!(clave in cruce)) {
        let match = null;
        Object.keys(byResp).forEach(function (k) { if (namesMatch(t.responsable, k)) match = k; });
        if (!match && RESP_FILTER.responsable.length && !RESP_FILTER.responsable.some(function (r) { return namesMatch(t.responsable, r); })) match = false;
        cruce[clave] = match === null ? (t.responsable || "Sin asignar") : match;
      }
      const nombre = cruce[clave];
      if (nombre === false) return;
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
      buildMsDropHTML("grupo", "Grupo", "bi-building", Array.from(grupoSet).sort(), RESP_FILTER) +
      buildMsDropHTML("nivel1", "Tipo de servicio", "bi-collection", catsPresentes(), RESP_FILTER);
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
      RESP_FILTER.responsable = []; RESP_FILTER.grupo = []; RESP_FILTER.nivel1 = []; RESP_FILTER.fechaDesde = ""; RESP_FILTER.fechaHasta = "";
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
      const vencCerrResp = responsables.reduce(function (s, r) { return s + r.vencidosCerrados; }, 0);
      const cerradosResp = responsables.reduce(function (s, r) { return s + r.solucionados; }, 0);
      kpiGrid.innerHTML =
        kpi("Responsables en vista", responsables.length, "info", "bi-people", "según filtros de sección") +
        kpi("Total de casos", totalCasosResp, "info", "bi-folder2-open", "histórico completo en la vista") +
        kpi("Vencidos cerrados", vencCerrResp, "vencido", "bi-archive", pct(vencCerrResp, cerradosResp) + "% de los cerrados") +
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
          '<td data-order="' + r.totalCasos + '">' + r.totalCasos.toLocaleString("es-CO") + '</td>' +
          '<td data-order="' + r.abiertos + '">' + r.abiertos + '</td>' +
          '<td data-order="' + r.vencidosActivos + '">' + vBadge + '</td>' +
          '<td data-order="' + r.criticosActivos + '">' + cBadge + '</td>' +
          '<td data-order="' + r.vencidosCerrados + '">' + r.vencidosCerrados + '</td>' +
          '<td data-order="' + r.tasaResolucion + '">' + r.tasaResolucion + '%</td>' +
          '<td data-order="' + r.totalTareas + '">' + r.totalTareas + '</td>' +
          '<td data-order="' + r.tareasPendientes + '">' + r.tareasPendientes + '</td></tr>');
      }).join("");
    }
    // Orden por defecto: columna 1 = Total casos.
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
        kpi("Vencidos abiertos", d.vencidosActivos, "vencido", "bi-x-octagon", "") +
        kpi("Críticos abiertos", d.criticosActivos, "critico", "bi-exclamation-triangle", "") +
        kpi("Vencidos cerrados", d.vencidosCerrados, "vencido", "bi-archive", pct(d.vencidosCerrados, d.solucionados) + "% de sus cerrados") +
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
      if (!byGrupo[g]) byGrupo[g] = { grupo: g, total: 0, abiertos: 0, vencidosAbiertos: 0, criticosAbiertos: 0, vencidosCerrados: 0,
        ans: { Normal: 0, Riesgo: 0, Critico: 0, Vencido: 0 }, sumTiempo: 0, responsables: {} };
      const d = byGrupo[g];
      d.total++;
      d.sumTiempo += (r.tiempo_transcurrido_dias || 0);
      d.responsables[r.responsable || "Sin asignar"] = true;
      // Igual que en Responsables: vencidos abiertos (según Progreso actual) y
      // vencidos cerrados (cerrados cuyo resultado de ANS fue Vencido).
      const res = ansResultado(r);
      d.ans[res]++;
      if (esAbierto(r)) {
        d.abiertos++;
        const cls = effectiveClass(r);
        if (cls === "Vencido") d.vencidosAbiertos++; else if (cls === "Critico") d.criticosAbiertos++;
      } else if (res === "Vencido") d.vencidosCerrados++;
    });
    Object.keys(byGrupo).forEach(function (g) {
      const d = byGrupo[g];
      d.avgTiempo = d.total ? +(d.sumTiempo / d.total).toFixed(1) : 0;
      d.pctVencidos = pct(d.ans.Vencido, d.total);  // % de todos sus casos que quedó fuera del ANS
      d.nResponsables = Object.keys(d.responsables).length;
    });
    return byGrupo;
  }

  function populateGrupoFilterBar() {
    const bar = document.getElementById("gruposFilterBar"); if (!bar) return;
    const grupoSet = new Set();
    STATE.rawCasos.forEach(function (r) { if (r.grupo_responsable) grupoSet.add(r.grupo_responsable); });
    const dropsHtml = buildMsDropHTML("grupo", "Grupo", "bi-building", Array.from(grupoSet).sort(), GRUPO_FILTER) +
      buildMsDropHTML("nivel1", "Tipo de servicio", "bi-diagram-2", catsPresentes(), GRUPO_FILTER);
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
      const top = function (campo) { return grupos.reduce(function (m, g) { return g[campo] > m[campo] ? g : m; }, { grupo: "—", vencidosAbiertos: 0, vencidosCerrados: 0 }); };
      const topAb = top("vencidosAbiertos"), topCe = top("vencidosCerrados");
      kpiGrid.innerHTML =
        kpi("Grupos en la vista", grupos.length, "info", "bi-building", "según filtros aplicados") +
        kpi("Más vencidos abiertos", topAb.grupo, "vencido", "bi-x-octagon", topAb.vencidosAbiertos + " vencidos abiertos") +
        kpi("Más vencidos cerrados", topCe.grupo, "vencido", "bi-archive", topCe.vencidosCerrados + " cerrados fuera del ANS") +
        kpi("Total de casos", grupos.reduce(function (s, g) { return s + g.total; }, 0), "info", "bi-collection", "en los grupos filtrados");
    }

    const selG = "#tableGrupos";
    if (dtRegistry[selG]) { try { dtRegistry[selG].destroy(); } catch (e) {} delete dtRegistry[selG]; }
    const tbody = document.querySelector(selG + " tbody");
    if (tbody) {
      tbody.innerHTML = grupos.map(function (g) {
        const rowCls = g.vencidosAbiertos > 0 ? "row--vencido" : (g.criticosAbiertos > 0 ? "row--critico" : "");
        return ('<tr class="' + rowCls + '">' +
          '<td><strong>' + esc(g.grupo) + '</strong></td>' +
          '<td data-order="' + g.total + '">' + g.total.toLocaleString("es-CO") + '</td>' +
          '<td data-order="' + g.abiertos + '">' + g.abiertos + '</td>' +
          '<td data-order="' + g.vencidosAbiertos + '">' + g.vencidosAbiertos + '</td>' +
          '<td data-order="' + g.criticosAbiertos + '">' + g.criticosAbiertos + '</td>' +
          '<td data-order="' + g.vencidosCerrados + '">' + g.vencidosCerrados + '</td>' +
          '<td data-order="' + g.pctVencidos + '">' + g.pctVencidos + '%</td>' +
          '<td data-order="' + g.avgTiempo + '">' + g.avgTiempo + ' días</td>' +
          '<td data-order="' + g.nResponsables + '">' + g.nResponsables + '</td></tr>');
      }).join("");
    }
    dtRegistry[selG] = $(selG).DataTable(Object.assign({ language: DT_LANG_ES }, { paging: true, pageLength: 15, order: [[1, "desc"]], dom: "frtipB", buttons: DT_BUTTONS }));

    // Resultado de ANS de todos los casos (abiertos y cerrados) de los 10 grupos con más casos.
    const top10 = grupos.slice(0, 10);
    const datasets = ["Normal", "Riesgo", "Critico", "Vencido"].map(function (cls) {
      return { label: ANS_LABELS[cls], backgroundColor: ANS_COLORS[cls], data: top10.map(function (g) { return g.ans[cls]; }) };
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
    document.querySelectorAll(".nav-link[data-view]").forEach(function (btn) { btn.addEventListener("click", function () {
      // "Casos" despliega su submenú de categorías; si ya estaba en Casos, lo pliega/despliega.
      if (btn.getAttribute("data-view") === "casos") toggleNavCasosSub(btn.classList.contains("active") ? undefined : true);
      switchView(btn.getAttribute("data-view")); closeAllDropdowns();
    }); });
    toggleNavCasosSub(true);
  }
  function toggleNavCasosSub(open) {
    const sub = document.getElementById("navCasosSub"), btn = document.querySelector('.nav-link[data-view="casos"]');
    if (!sub || !btn) return;
    const isOpen = open === undefined ? !sub.classList.contains("is-open") : open;
    sub.classList.toggle("is-open", isOpen); btn.classList.toggle("is-sub-open", isOpen);
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
    wireNav(); wireGestionTabs(); wireSidebarMobile(); wireRefreshButton(); wireGlobalSearch();
    loadAllData(true).then(function () {
      abrirDesdeHash();
      window.addEventListener("hashchange", abrirDesdeHash);
      setInterval(function () { loadAllData(false); }, CONFIG.refreshIntervalMs);
    });
  });

})();
