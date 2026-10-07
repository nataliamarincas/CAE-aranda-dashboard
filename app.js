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
    metasSource: "data/metas.json",
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
    metas: "Metas y progreso",
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
  const CASOS_FILTER = { nivel1: [], nivel2: [], nivel3: [], grupo: [], responsable: [], estado: [], fuente: [], tipoRegistro: [], condicion: [], ansReal: [],
    clasificacion: [], autor: [], fechaDesde: "", fechaHasta: "" };
  const TAREAS_FILTER = { tipoServicio: [], linea: [], causa: [], criterios: [], responsable: [], estado: [], fechaDesde: "", fechaHasta: "" };
  const RESP_FILTER = { responsable: [], grupo: [], nivel1: [], fechaDesde: "", fechaHasta: "" };
  const GRUPO_FILTER = { grupo: [], nivel1: [], fechaDesde: "", fechaHasta: "" };
  // Resumen ejecutivo: filtros propios (independientes de la pestaña Casos).
  // Las fechas también recortan las Tareas.
  const EXEC_FILTER = { nivel1: [], nivel2: [], clasificacion: [], autor: [], grupo: [], responsable: [], estado: [], condicion: [],
    tipoRegistro: [], fuente: [], fechaDesde: "", fechaHasta: "" };
  // Atención Prioritaria: filtros propios sobre los casos abiertos vencidos o críticos.
  const ATENCION_FILTER = { clasificacion: [], nivel1: [], nivel2: [], grupo: [], responsable: [], estado: [], fechaDesde: "", fechaHasta: "" };

  const ESTADOS_CERRADOS = ["Solucionado", "Cerrado", "Anulado"];

  const chartRegistry = {};
  const dtRegistry = {};
  let _casosActiveCat = null;     // categoría (nivel1) activa en Casos; null = todas
  let _vistaActual = "resumen";
  let _respDetalleActual = null;
  let _respDia = isoToday();       // fecha de referencia de la "Gestión" en Responsables
  let _respPeriodo = "dia";        // "dia" | "semana" (lunes a domingo) | "mes" que contiene _respDia
  let _respSoloDia = false;        // Responsables: mostrar solo quienes tuvieron gestión en el período
  let _respSoloAsesores = false;   // Responsables: mostrar solo a los asesores del CAE (AUTORES_GESTORES)
  let _respDetalleTab = "casos";  // "casos" | "tareas" dentro del panel de detalle
  let TENDENCY_PERIOD = "mes";  // por meses se ve el año de histórico completo

  /* ============================ UTILIDADES ============================ */

  function esc(str) {
    if (str === null || str === undefined) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function pct(n, total) { return !total ? 0 : Math.round((n / total) * 1000) / 10; }
  // Duración en días (decimal) -> "2 d 3 h 15 min". Para los tiempos promedio.
  function fmtDuracion(dias) {
    if (dias === null || dias === undefined || isNaN(dias)) return "—";
    const min = Math.round(dias * 1440), d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
    return d + " d " + h + " h " + m + " min";
  }

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
      // pctTotal: total de TODAS las claves (no solo el top N), para el % de las etiquetas.
      datasets: [{ data: entries.map(function (e) { return e[1]; }), pctTotal: sumar(Object.values(counts)), backgroundColor: color || "#8C0F13", borderRadius: 4, maxBarThickness: 26 }] };
  }
  function toChartDataBarMulti(counts, limit) {
    const entries = sortedEntries(counts, limit || 10);
    return { labels: entries.map(function (e) { return e[0]; }),
      datasets: [{ data: entries.map(function (e) { return e[1]; }), pctTotal: sumar(Object.values(counts)),
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
  // Franja horaria: casos por hora del día (00:00 a 23:00) dentro del rango de
  // fechas de los filtros. Usa '<dateField>_dt' (fecha y hora de registro); las
  // tareas no traen hora, así que para ellas no aplica.
  function getHourlyCounts(records, dateField, filterObj) {
    const buckets = [];
    for (let h = 0; h < 24; h++) buckets.push({ label: String(h).padStart(2, "0") + ":00", count: 0 });
    const desde = filterObj && filterObj.fechaDesde, hasta = filterObj && filterObj.fechaHasta;
    records.forEach(function (r) {
      const f = r[dateField], dt = r[dateField + "_dt"];
      if (!dt || String(dt).length < 13) return;
      if (desde && (f || "") < desde) return;
      if (hasta && (f || "") > hasta) return;
      const h = parseInt(String(dt).substring(11, 13), 10);
      if (h >= 0 && h < 24) buckets[h].count++;
    });
    return buckets;
  }
  function horaPico(buckets) {
    let mejor = null; buckets.forEach(function (b) { if (!mejor || b.count > mejor.count) mejor = b; });
    return mejor && mejor.count ? mejor : null;
  }
  // Opciones para el gráfico por horas: barras (apiladas si hay varias series).
  function horasOpts(apilado) {
    // Tendencia por horas: etiquetas con la cantidad (ver pctLabelsPlugin).
    const o = stackedBarOpts(); o.plugins.pctLabels = { modo: "valor" };
    return Object.assign(o, { scales: {
      x: { stacked: apilado, grid: { display: false }, title: { display: true, text: "Hora de registro" } },
      y: { stacked: apilado, beginAtZero: true, grid: gridOpts(), ticks: { precision: 0 } } } });
  }

  function getTendenciaCounts(records, period, dateField, filterObj, desdeMin) {
    if (period === "hora") return getHourlyCounts(records, dateField, filterObj);
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
  // conHoras: agrega "Horas" (franja horaria). Tareas no lo tiene: su export no trae hora.
  function buildPeriodBtnsHTML(conHoras) {
    const periodos = [["día", "Días"], ["semana", "Semanas"], ["mes", "Meses"], ["año", "Años"]];
    if (conHoras) periodos.push(["hora", "Horas"]);
    const activo = periodoPara(conHoras);
    return '<div class="tend-period-btns">' + periodos.map(function (p) {
      return '<button class="tend-btn' + (activo === p[0] ? ' tend-btn--active' : '') + '" data-period="' + p[0] + '"' +
        (p[0] === "hora" ? ' title="Casos por hora del día: en qué horas se registran más"' : '') + '>' + p[1] + '</button>';
    }).join("") + '</div>';
  }
  // Periodo efectivo de una vista: si no tiene "Horas" y ese está elegido, usa meses.
  function periodoPara(conHoras) { return (!conHoras && TENDENCY_PERIOD === "hora") ? "mes" : TENDENCY_PERIOD; }
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

  // Clientes únicos: casos con cliente_id, código seudónimo que calcula el pipeline
  // (HMAC del campo Cliente con clave secreta). Se cuentan sin saber quiénes son.
  function contarClientes(records) {
    const veces = {}; let conId = 0;
    records.forEach(function (r) { if (r.cliente_id) { conId++; veces[r.cliente_id] = (veces[r.cliente_id] || 0) + 1; } });
    const ids = Object.keys(veces);
    return { unicos: ids.length, conId: conId, total: records.length, recurrentes: ids.filter(function (k) { return veces[k] > 1; }).length };
  }
  function kpiClientes(records) {
    const c = contarClientes(records);
    if (!c.conId) return kpi("Clientes únicos", "—", "info", "bi-person-vcard", "aún sin identificar (llega con la próxima sincronización)");
    return kpi("Clientes únicos", c.unicos, "info", "bi-person-vcard",
      (c.conId / c.unicos).toFixed(1).replace(".", ",") + " casos por cliente · " + c.recurrentes + " con más de un caso" +
      (c.conId < c.total ? " · " + c.conId + " de " + c.total + " casos con cliente" : ""));
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
    if (esFueraReporte(r) || e === "Solucionado" || e === "Cerrado" || e === "Anulado") return "Normal";
    return classify(effectiveProgreso(r));
  }
  function nivel1Effective(r) {
    return NIVEL1_CATS.indexOf(r.nivel1) !== -1 ? r.nivel1 : NIVEL1_OTROS;
  }
  // "Fuera del reporte": el caso dejó de venir en el export de Aranda (normalmente porque
  // se escaló a un grupo que no está en el reporte). Se conserva con su último estado
  // conocido, pero ese estado ya no es confiable: no cuenta como abierto ni como cerrado.
  // Lo marca el pipeline (fuera_export_desde) y se quita solo si el caso vuelve.
  const CONDICIONES = ["Abiertos", "Cerrados", "Fuera del reporte"];
  function esFueraReporte(r) { return !!r.fuera_export_desde; }
  function esAbierto(r) { return !esFueraReporte(r) && ESTADOS_CERRADOS.indexOf(r.estado) === -1; }
  function esCerrado(r) { return !esFueraReporte(r) && ESTADOS_CERRADOS.indexOf(r.estado) !== -1; }
  function condicionCaso(r) { return esFueraReporte(r) ? "Fuera del reporte" : esAbierto(r) ? "Abiertos" : "Cerrados"; }
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

  /* ====================== CONDICIÓN REAL DE ANS ======================
     Indicador oficial de cumplimiento de ANS (pedido de Natalia, 2026-10-01):
     compara la fecha de atención REAL con la fecha de atención ESTIMADA.
       - Cumplido / Incumplido: el caso tiene fecha real; real <= estimada.
       - Vencido sin atender / En plazo: sin fecha real y abierto; ya pasó o no la estimada.
       - Sin fecha real cerrado: se usa el TIEMPO RESPUESTA del histórico (históricos y
         migrados); si tampoco hay, "Sin dato" (no cuenta en el %).
     Con hora cuando el pipeline la trae (_dt); si a alguna le falta, se compara por día.
     La "Clasificación" por Progreso (riesgo de los abiertos) sigue aparte. */
  const ANS_REAL = ["Cumplido", "Incumplido", "Vencido sin atender", "En plazo", "Sin dato"];
  const ANS_REAL_COLORS = { "Cumplido": "#2a7a3b", "Incumplido": "#C0151A", "Vencido sin atender": "#4A0608", "En plazo": "#D9A441", "Sin dato": "#D9CFC6" };
  const ANS_REAL_PILL = { "Cumplido": "normal", "Incumplido": "critico", "Vencido sin atender": "vencido", "En plazo": "riesgo" };
  function ahoraISO() {
    const d = new Date(), p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function fechaValida(v) { return v && v !== "N/A" ? String(v) : null; }
  // "2026-09-21T17:52:22" -> "2026-09-21 17:52" (o solo la fecha si no trae hora).
  function fechaHoraTxt(v, type) {
    const s = fechaValida(v); if (!s) return type === "display" ? "—" : "";
    return type === "display" ? esc(s.slice(0, 16).replace("T", " ")) : s;
  }
  // <0 si a es antes que b. Si alguna no trae hora, compara solo el día.
  function compararFechas(a, b) {
    if (a.indexOf("T") === -1 || b.indexOf("T") === -1) { a = a.slice(0, 10); b = b.slice(0, 10); }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function ansReal(r) {
    if (r._ansReal !== undefined) return r._ansReal;
    const real = fechaValida(r.fecha_atencion_real_dt) || fechaValida(r.fecha_atencion_real);
    const est = fechaValida(r.fecha_estimada_solucion_dt) || fechaValida(r.fecha_estimada_solucion);
    const hist = r.fuente === "historico" ? r.cumplimiento_ans : r.cumplimiento_ans_historico;
    let res;
    if (real && est) res = compararFechas(real, est) <= 0 ? "Cumplido" : "Incumplido";
    else if (!real && esAbierto(r)) res = est ? (compararFechas(ahoraISO(), est) > 0 ? "Vencido sin atender" : "En plazo") : "Sin dato";
    else if (hist && ANS_HISTORICO[hist]) res = hist === "VENCIDO" ? "Incumplido" : "Cumplido";
    else res = "Sin dato";
    // Abiertos: depende de la hora actual, no se memoriza.
    if (!esAbierto(r)) r._ansReal = res;
    return res;
  }
  function ansRealFuera(res) { return res === "Incumplido" || res === "Vencido sin atender"; }
  // % de cumplimiento: Cumplido sobre los casos con resultado (sin "En plazo" ni "Sin dato").
  function pctCumplimiento(cnt) { return pct(cnt["Cumplido"], cnt["Cumplido"] + cnt["Incumplido"] + cnt["Vencido sin atender"]); }
  function contadorAnsReal() { const o = {}; ANS_REAL.forEach(function (k) { o[k] = 0; }); return o; }
  function ansRealPillHTML(c) {
    return ANS_REAL_PILL[c] ? '<span class="status-pill status-pill--' + ANS_REAL_PILL[c] + '">' + esc(c) + '</span>' : '<span class="area-chip">' + esc(c) + '</span>';
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

  // Filtros de selección múltiple. Valor del filtro:
  //   []            -> Todos (sin filtrar): todas las casillas aparecen marcadas.
  //   [MS_NINGUNO]  -> el usuario desmarcó todo: no coincide nada.
  //   [a, b, …]     -> solo esos valores.
  // Así se puede partir de "Todos" y desmarcar los que sobran.
  const MS_NINGUNO = "\u0000ninguno";
  function buildMsDropHTML(key, label, icon, options, filterObj) {
    const sel = filterObj[key] || [];
    const todos = sel.length === 0, ninguno = sel.length === 1 && sel[0] === MS_NINGUNO;
    const marcadas = todos ? options.length : ninguno ? 0 : sel.filter(function (v) { return options.indexOf(v) !== -1; }).length;
    const badgeVis = (!todos && marcadas < options.length) ? "" : "display:none";
    const optsHtml = options.map(function (opt) {
      const checked = (todos || (!ninguno && sel.indexOf(opt) !== -1)) ? " checked" : "";
      return '<label class="ms-opt"><input type="checkbox" class="ms-cb" value="' + esc(opt) + '"' + checked + '><span>' + esc(opt) + '</span></label>';
    }).join("");
    const allChecked = (todos || (options.length > 0 && marcadas === options.length)) ? " checked" : "";
    return ('<div class="ms-drop" data-key="' + key + '">' +
      '<button class="ms-toggle" type="button"><i class="bi ' + icon + '"></i><span class="ms-label">' + label + '</span>' +
      '<span class="ms-badge" style="' + badgeVis + '">' + marcadas + '</span><i class="bi bi-chevron-down ms-chevron"></i></button>' +
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
        // "Todos": marcado = sin filtro (todas las casillas); desmarcado = ninguna.
        if (allCb) allCb.addEventListener("change", function () {
          const marcar = this.checked;
          drop.querySelectorAll(".ms-cb").forEach(function (cb) { cb.checked = marcar; });
          filterObj[key] = marcar ? [] : [MS_NINGUNO];
          badge.textContent = "0"; badge.style.display = marcar ? "none" : "";
          onChange();
        });
        drop.querySelectorAll(".ms-cb").forEach(function (cb) {
          cb.addEventListener("change", function () {
            const vals = []; drop.querySelectorAll(".ms-cb:checked").forEach(function (c) { vals.push(c.value); });
            const totalOpts = drop.querySelectorAll(".ms-cb").length;
            filterObj[key] = vals.length === totalOpts ? [] : vals.length === 0 ? [MS_NINGUNO] : vals;
            if (allCb) allCb.checked = vals.length === totalOpts;
            badge.textContent = vals.length; badge.style.display = vals.length < totalOpts ? "" : "none";
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
      if (CASOS_FILTER.ansReal.length && CASOS_FILTER.ansReal.indexOf(ansReal(r)) === -1) return false;
      if (CASOS_FILTER.autor.length && CASOS_FILTER.autor.indexOf(autorGrupo(r)) === -1) return false;
      if (CASOS_FILTER.condicion.length) {
        const cond = condicionCaso(r);
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
      if (f.clasificacion.length && f.clasificacion.indexOf(clasificacionCaso(r)) === -1) return false;
      if (f.autor.length && f.autor.indexOf(autorGrupo(r)) === -1) return false;
      if (f.grupo.length && f.grupo.indexOf(r.grupo_responsable) === -1) return false;
      if (f.responsable.length && f.responsable.indexOf(r.responsable) === -1) return false;
      if (f.estado.length && f.estado.indexOf(r.estado) === -1) return false;
      if (f.tipoRegistro.length && f.tipoRegistro.indexOf(r.tipo_registro) === -1) return false;
      if (f.fuente.length && f.fuente.indexOf(r.fuente) === -1) return false;
      if (f.condicion.length && f.condicion.indexOf(condicionCaso(r)) === -1) return false;
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
    let vencidos = 0, criticos = 0, riesgo = 0, normal = 0, sumTiempo = 0, abiertos = 0, vencidosCerrados = 0, fueraReporte = 0;
    const vencidosPorResponsable = {}, vencidosPorCategoria = {}, porNivel1 = {};
    const ans = { Normal: 0, Riesgo: 0, Critico: 0, Vencido: 0 };
    const ansRealCnt = contadorAnsReal();
    records.forEach(function (r) {
      const cls = effectiveClass(r);
      const resAns = ansResultado(r);
      const real = ansReal(r);
      // Vencidos cerrados = cerrados fuera de ANS según la Condición real de ANS.
      if (esAbierto(r)) abiertos++; else if (esFueraReporte(r)) fueraReporte++; else if (real === "Incumplido") vencidosCerrados++;
      ans[resAns]++;
      ansRealCnt[real]++;
      if (cls === "Vencido") vencidos++; else if (cls === "Critico") criticos++; else if (cls === "Riesgo") riesgo++; else normal++;
      sumTiempo += (r.tiempo_transcurrido_dias || 0);
      const n1 = nivel1Effective(r);
      if (!porNivel1[n1]) porNivel1[n1] = { total: 0, vencidos: 0, criticos: 0, riesgo: 0, abiertos: 0, vencidosCerrados: 0, ans: { Normal: 0, Riesgo: 0, Critico: 0, Vencido: 0 }, ansReal: contadorAnsReal() };
      porNivel1[n1].total++;
      if (esAbierto(r)) porNivel1[n1].abiertos++; else if (esCerrado(r) && real === "Incumplido") porNivel1[n1].vencidosCerrados++;
      porNivel1[n1].ans[resAns]++;
      porNivel1[n1].ansReal[real]++;
      if (cls === "Vencido") { porNivel1[n1].vencidos++; vencidosPorResponsable[r.responsable || "Sin asignar"] = (vencidosPorResponsable[r.responsable || "Sin asignar"] || 0) + 1; vencidosPorCategoria[r.categoria || "Sin categoría"] = (vencidosPorCategoria[r.categoria || "Sin categoría"] || 0) + 1; }
      else if (cls === "Critico") porNivel1[n1].criticos++;
      else if (cls === "Riesgo") porNivel1[n1].riesgo++;
    });
    return { total: total, vencidos: vencidos, criticos: criticos, riesgo: riesgo, normal: normal,
      abiertos: abiertos, cerrados: total - abiertos - fueraReporte, fueraReporte: fueraReporte, vencidosCerrados: vencidosCerrados, ans: ans, ansReal: ansRealCnt,
      avgTiempo: total ? sumTiempo / total : 0,  // días; se muestra con fmtDuracion
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
    Chart.register(pctLabelsPlugin);
  }

  /* --------- Etiquetas de porcentaje visibles sin pasar el cursor ---------
     Plugin global (aplica a todos los gráficos; se desactiva con
     options.plugins.pctLabels = false):
     - Donas: % de cada porción sobre el total.
     - Barras simples: "n (x%)" sobre el total del conjunto. Si el gráfico solo
       muestra el top N, dataset.pctTotal trae el total real (ver toChartDataBar).
     - Barras apiladas: % de cada segmento dentro de su barra.
     - Líneas: % de cada punto sobre el total de su serie en el periodo (sin "<1%").
     Una etiqueta se omite si no cabe o si se superpone con otra ya dibujada. */
  function fmtPct(v, total) {
    if (!total || !v) return null;
    const p = v / total * 100;
    return p < 1 ? "<1%" : p.toLocaleString("es-CO", { maximumFractionDigits: p < 10 ? 1 : 0 }) + "%";
  }
  function textoSobre(bg) {
    const m = /^#([0-9a-f]{6})/i.exec(typeof bg === "string" ? bg : "");
    if (!m) return "#fff";
    const n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? "#2E2420" : "#fff";
  }
  function colorDe(ds, j, prop) { const c = ds[prop]; return Array.isArray(c) ? c[j % c.length] : c; }
  function sumar(arr) { return arr.reduce(function (s, v) { return s + (+v || 0); }, 0); }

  const pctLabelsPlugin = {
    id: "pctLabels",
    defaults: { modo: null },
    afterDatasetsDraw: function (chart, args, pluginOpts) {
      const ctx = chart.ctx, type = chart.config.type, opts = chart.options;
      const horizontal = opts.indexAxis === "y";
      const stacked = !!(opts.scales && opts.scales.x && opts.scales.x.stacked);
      // Gráficos de tendencia (líneas y barras por hora): la cantidad, no el %.
      const enValor = ((pluginOpts && pluginOpts.modo) || (type === "line" ? "valor" : "pct")) === "valor";
      const visibles = chart.data.datasets.map(function (d, i) { return i; }).filter(function (i) { return chart.isDatasetVisible(i); });
      const ocupados = [];
      ctx.save();
      ctx.font = "600 10.5px " + Chart.defaults.font.family;
      ctx.textBaseline = "middle";

      // Dibuja si cabe en el lienzo y no pisa otra etiqueta. align: left|center|right.
      function poner(texto, x, y, color, align) {
        const w = ctx.measureText(texto).width, h = 12;
        const x0 = align === "left" ? x : align === "right" ? x - w : x - w / 2;
        const r = { x0: x0 - 2, y0: y - h / 2 - 1, x1: x0 + w + 2, y1: y + h / 2 + 1 };
        if (r.x0 < 0 || r.y0 < 0 || r.x1 > chart.width || r.y1 > chart.height) return false;
        if (ocupados.some(function (o) { return r.x0 < o.x1 && r.x1 > o.x0 && r.y0 < o.y1 && r.y1 > o.y0; })) return false;
        ocupados.push(r);
        ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(texto, x, y);
        return true;
      }

      visibles.forEach(function (i) {
        const ds = chart.data.datasets[i], meta = chart.getDatasetMeta(i);
        const tipo = ds.type || type;  // gráficos mixtos: cada serie con su tipo
        meta.data.forEach(function (el, j) {
          const v = +ds.data[j];
          if (!v) return;

          if (tipo === "doughnut" || tipo === "pie") {
            const total = sumar(ds.data.filter(function (x, k) { return chart.getDataVisibility(k); }));
            const t = fmtPct(v, total); if (!t) return;
            const p = el.getProps(["startAngle", "endAngle", "innerRadius", "outerRadius"]);
            const pos = el.tooltipPosition();
            const largoArco = (p.endAngle - p.startAngle) * (p.innerRadius + p.outerRadius) / 2;
            if (largoArco < ctx.measureText(t).width + 6 || p.outerRadius - p.innerRadius < 14) return;
            poner(t, pos.x, pos.y, textoSobre(colorDe(ds, j, "backgroundColor")), "center");

          } else if (tipo === "bar" && stacked && enValor) {
            // Una etiqueta por barra: el total, sobre la última serie con valor (la de más arriba).
            const arriba = visibles.filter(function (k) { return +chart.data.datasets[k].data[j]; }).pop();
            if (i !== arriba) return;
            const tot = sumar(visibles.map(function (k) { return chart.data.datasets[k].data[j]; })); if (!tot) return;
            const b = el.getProps(["x", "y"]);
            if (horizontal) poner(tot.toLocaleString("es-CO"), b.x + 5, b.y, "#4A3F38", "left");
            else poner(tot.toLocaleString("es-CO"), b.x, b.y - 8, "#4A3F38", "center");

          } else if (tipo === "bar" && stacked) {
            const total = sumar(visibles.map(function (k) { return chart.data.datasets[k].data[j]; }));
            const t = fmtPct(v, total); if (!t) return;
            const b = el.getProps(["x", "y", "base", "width", "height"]);
            const largo = horizontal ? Math.abs(b.x - b.base) : Math.abs(b.base - b.y);
            const grosor = horizontal ? b.height : b.width;
            if (largo < ctx.measureText(t).width + 6 || grosor < 12) return;
            const cx = horizontal ? (b.x + b.base) / 2 : b.x, cy = horizontal ? b.y : (b.y + b.base) / 2;
            poner(t, cx, cy, textoSobre(colorDe(ds, j, "backgroundColor")), "center");

          } else if (tipo === "bar") {
            const t = fmtPct(v, ds.pctTotal || sumar(ds.data)); if (!t) return;
            const texto = enValor ? v.toLocaleString("es-CO") : v.toLocaleString("es-CO") + " (" + t + ")";
            const b = el.getProps(["x", "y", "base"]);
            const dentro = textoSobre(colorDe(ds, j, "backgroundColor"));
            if (horizontal) { poner(texto, b.x + 5, b.y, "#4A3F38", "left") || poner(texto, b.x - 5, b.y, dentro, "right"); }
            else { const tv = enValor ? texto : t; poner(tv, b.x, b.y - 8, "#4A3F38", "center") || poner(tv, b.x, b.y + 9, dentro, "center"); }

          } else if (tipo === "line") {
            // Tendencia: la cantidad. (Si se pidiera %, se omite "<1%" para no llenar el fondo.)
            const t = enValor ? v.toLocaleString("es-CO") + (ds.sufijo || "") : fmtPct(v, sumar(ds.data)); if (!t || t === "<1%") return;
            poner(t, el.x, el.y - 9, colorDe(ds, j, "borderColor") || "#4A3F38", "center");
          }
        });
      });
      ctx.restore();
    }
  };

  // Margen extra para que las etiquetas de % que van fuera de la barra/punto no se corten.
  function paddingPct(type, options) {
    const o = options || {}, stacked = !!(o.scales && o.scales.x && o.scales.x.stacked);
    const enValor = !!(o.plugins && o.plugins.pctLabels && o.plugins.pctLabels.modo === "valor");
    if (type === "bar" && (!stacked || enValor)) return o.indexAxis === "y" ? { right: 78 } : { top: 18 };
    if (type === "line") return { top: 16 };
    return null;
  }
  function renderChart(canvasId, type, data, options) {
    const el = document.getElementById(canvasId); if (!el) return null;
    if (chartRegistry[canvasId]) chartRegistry[canvasId].destroy();
    const ctx = el.getContext("2d"); el.classList.remove("chart-skeleton");
    options = options || {};
    const pad = paddingPct(type, options);
    if (pad && !(options.layout && options.layout.padding !== undefined)) options.layout = Object.assign({}, options.layout, { padding: pad });
    chartRegistry[canvasId] = new Chart(ctx, { type: type, data: data, options: options });
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
  // Metas (Notion): opcional. Si el archivo aún no existe, la sección muestra cómo activarla.
  function loadMetas() {
    return fetch(CONFIG.metasSource, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (json) {
        if (json && json.generado_en !== STATE.genMetas) { STATE.metas = json; STATE.genMetas = json.generado_en; STATE.datosCambiaron = true; }
      })
      .catch(function () { /* sin metas.json todavía */ });
  }
  function loadAllData(isManual) {
    setSyncStatus("syncing");
    STATE.datosCambiaron = false;
    return Promise.all([loadCasos(), loadTareas(), loadMetas()]).then(function () {
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
    metas: [["Metas y progreso", renderMetas]],
    gestion: [["Atención Prioritaria", renderAttention], ["Responsables", renderResponsables], ["Grupos", renderGrupos], ["Fuera del reporte", renderFueraReporte]]
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
    // Mismo criterio que la pestaña Atención prioritaria (vencidos, vencidos por fecha y críticos).
    if (navAtencion) navAtencion.textContent = casosEnAtencion().length;
    const navCasos = document.getElementById("navBadgeCasos");
    if (navCasos) navCasos.textContent = STATE.statsCasos.abiertos;
    const navMetas = document.getElementById("navBadgeMetas");
    if (navMetas) {
      const venc = STATE.metas ? STATE.metas.tareas.filter(function (t) { return situacionTarea(t) === "vencida"; }).length : 0;
      navMetas.textContent = venc; navMetas.style.display = venc ? "" : "none";
    }
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
      buildMsDropHTML("clasificacion", "Clasificación", "bi-exclamation-triangle", CLASIFICACIONES, EXEC_FILTER) +
      buildMsDropHTML("autor", "Autor", "bi-person-plus", AUTORES_GESTORES, EXEC_FILTER) +
      buildMsDropHTML("grupo", "Grupo", "bi-building", uniqueVals("grupo_responsable"), EXEC_FILTER) +
      buildMsDropHTML("responsable", "Responsable", "bi-person", uniqueVals("responsable"), EXEC_FILTER) +
      buildMsDropHTML("estado", "Estado", "bi-circle-half", uniqueVals("estado"), EXEC_FILTER) +
      buildMsDropHTML("condicion", "Condición", "bi-toggle2-on", CONDICIONES, EXEC_FILTER) +
      buildMsDropHTML("tipoRegistro", "Canal de registro", "bi-tag", uniqueVals("tipo_registro"), EXEC_FILTER) +
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
        kpi("Total de casos", s.total, "info", "bi-collection", s.abiertos + " abiertos · " + s.cerrados + " cerrados" + (s.fueraReporte ? " · " + s.fueraReporte + " fuera del reporte" : "")) +
        kpiClientes(STATE.execCasos) +
        kpi("Cumplimiento ANS", pctCumplimiento(s.ansReal) + "%", "sla", "bi-stopwatch", s.ansReal["Cumplido"] + " cumplidos · Condición real de ANS") +
        kpi("Vencidos", s.vencidos, "vencido", "bi-x-octagon", "abiertos · " + pct(s.vencidos, s.abiertos) + "% de los abiertos") +
        kpi("Vencidos cerrados", s.vencidosCerrados, "vencido", "bi-archive", pct(s.vencidosCerrados, s.cerrados) + "% de los cerrados") +
        kpi("Críticos", s.criticos, "critico", "bi-exclamation-triangle", "abiertos · " + pct(s.criticos, s.abiertos) + "% de los abiertos") +
        kpi("En riesgo", s.riesgo, "riesgo", "bi-shield-exclamation", "abiertos · " + pct(s.riesgo, s.abiertos) + "% de los abiertos") +
        kpi("Tiempo promedio", fmtDuracion(s.avgTiempo), "normal", "bi-clock-history", "transcurrido por caso") +
        kpi("Tareas totales", st.total, "info", "bi-list-task", st.completadas + " completadas · " + st.pendientes + " pendientes") +
        kpi("Tareas pendientes", st.pendientes, "info", "bi-list-check", pct(st.pendientes, st.total) + "% del total");
    }
    renderExecCharts();
    renderComparativoNivel1();
  }

  function renderExecCharts() {
    const periodContainer = document.getElementById("execTendPeriod");
    if (periodContainer) { periodContainer.innerHTML = buildPeriodBtnsHTML(true); wireTendencyBtns(periodContainer); }
    const execTitle = document.getElementById("execTendTitle");

    if (TENDENCY_PERIOD === "hora") {
      // Por horas solo casos: las tareas no traen hora de creación.
      const hb = getTendenciaCounts(STATE.execCasos, "hora", "fecha_registro", EXEC_FILTER);
      const pico = horaPico(hb);
      if (execTitle) execTitle.textContent = "Casos por hora de registro" + (pico ? " · pico " + pico.label + " (" + pico.count.toLocaleString("es-CO") + ")" : "");
      ajustarScrollTendencia("execTendInner", hb.length);
      renderChart("chartExecTendencia", "bar", { labels: hb.map(function (b) { return b.label; }),
        datasets: [{ label: "Casos creados (las tareas no traen hora)", data: hb.map(function (b) { return b.count; }), backgroundColor: "#8C0F13", borderRadius: 3 }] }, horasOpts(false));
      renderChart("chartExecClasificacion", "doughnut", toChartDataDoughnut(STATE.statsExec.ansReal, null, ANS_REAL_COLORS), doughnutOpts());
      return;
    }
    if (execTitle) execTitle.textContent = "Tendencia de creación: Casos y Tareas";

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

    renderChart("chartExecClasificacion", "doughnut", toChartDataDoughnut(STATE.statsExec.ansReal, null, ANS_REAL_COLORS), doughnutOpts());
  }

  function renderComparativoNivel1() {
    const cats = catsPresentes();
    const s = STATE.statsExec;
    // Destruir la tabla ANTES de reescribir las filas: si se destruye después,
    // DataTables restaura las filas anteriores y la tabla no reflejaba los filtros.
    const selComp = "#tableComparativo";
    if (dtRegistry[selComp]) { try { dtRegistry[selComp].destroy(); } catch (e) {} delete dtRegistry[selComp]; }
    const tbody = document.querySelector(selComp + " tbody");
    if (tbody) {
      let html = "";
      cats.forEach(function (c) {
        const d = s.porNivel1[c] || { total: 0, vencidos: 0, criticos: 0, riesgo: 0, abiertos: 0, vencidosCerrados: 0, ansReal: contadorAnsReal() };
        const aTiempo = pctCumplimiento(d.ansReal);
        html += '<tr>' +
          '<td>' + nivel1ChipHTML(c) + '</td>' +
          '<td data-order="' + d.total + '">' + d.total.toLocaleString("es-CO") + '</td>' +
          '<td data-order="' + d.abiertos + '">' + d.abiertos + '</td>' +
          '<td data-order="' + aTiempo + '">' + (d.total ? aTiempo + '%' : '—') + '</td>' +
          '<td data-order="' + d.vencidos + '">' + d.vencidos + '</td>' +
          '<td data-order="' + d.criticos + '">' + d.criticos + '</td>' +
          '<td data-order="' + d.riesgo + '">' + d.riesgo + '</td>' +
          '<td data-order="' + d.vencidosCerrados + '">' + d.vencidosCerrados + '</td>' +
          '</tr>';
      });
      tbody.innerHTML = html;
    }
    initDataTable("#tableComparativo", { paging: false, searching: false, info: false, order: [] });

    renderAnsPorCategoria("chartComparativoStack", s, cats);
  }

  // Barras apiladas: Condición real de ANS por categoría.
  function renderAnsPorCategoria(canvasId, stats, cats) {
    renderChart(canvasId, "bar", { labels: cats, datasets: datasetsAnsReal(cats, function (c) { const d = stats.porNivel1[c]; return d ? d.ansReal : null; }) }, stackedBarOpts());
  }
  // Un dataset por resultado de la Condición real de ANS; cntDe(etiqueta) da su contador.
  function datasetsAnsReal(labels, cntDe) {
    return ANS_REAL.map(function (res) {
      return { label: res, backgroundColor: ANS_REAL_COLORS[res], data: labels.map(function (l, i) { const c = cntDe(l, i); return c ? c[res] : 0; }) };
    });
  }

  /* ---------------------- ATENCIÓN PRIORITARIA ---------------------- */

  // Atención Prioritaria mira todos los casos (no depende de los filtros de Casos)
  // y tiene su propia barra de filtros sobre los casos abiertos vencidos o críticos.
  // Atención prioritaria (opción B, pedido de Natalia 2026-10-07): casos abiertos
  //   - Vencido / Crítico según el Progreso, o
  //   - "Vencido por fecha": Condición real = Vencido sin atender (la fecha estimada ya
  //     pasó sin atención real) aunque el Progreso no avance (p. ej. En Espera).
  const MOTIVOS_ATENCION = ["Vencido", "Crítico", "Vencido por fecha"];
  function motivoAtencion(r) {
    if (!esAbierto(r)) return null;
    const cls = effectiveClass(r);
    if (cls === "Vencido") return "Vencido";
    if (cls === "Critico") return "Crítico";
    return ansReal(r) === "Vencido sin atender" ? "Vencido por fecha" : null;
  }
  function casosEnAtencion() {
    return STATE.rawCasos.filter(function (r) { return motivoAtencion(r) !== null; });
  }
  function populateAtencionFilterBar() {
    const bar = document.getElementById("atencionFilterBar"); if (!bar) return;
    const base = casosEnAtencion();
    const enCat = base.filter(function (r) { return !ATENCION_FILTER.nivel1.length || ATENCION_FILTER.nivel1.indexOf(nivel1Effective(r)) !== -1; });
    function uniqueVals(records, field) { return Array.from(new Set(records.map(function (r) { return r[field] || ""; }).filter(function (v) { return v && v !== "N/A"; }))).sort(); }
    const dropsHtml =
      buildMsDropHTML("clasificacion", "Motivo", "bi-exclamation-triangle", MOTIVOS_ATENCION, ATENCION_FILTER) +
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
  /* ---------------------- FUERA DEL REPORTE ---------------------- */
  // Casos que dejaron de venir en el export (ver esFueraReporte): listado completo, sin
  // filtros de otras vistas, con su último estado conocido. Más recientes primero.
  function renderFueraReporte() {
    const casos = STATE.rawCasos.filter(esFueraReporte)
      .sort(function (a, b) { return (b.fuera_export_desde || "").localeCompare(a.fuera_export_desde || ""); });
    const badge = document.getElementById("badgeFueraReporte");
    if (badge) { badge.textContent = casos.length; badge.style.display = casos.length ? "" : "none"; }
    const resumen = document.getElementById("fueraReporteResumen");
    if (resumen) {
      const grupos = countBy(casos, "grupo_responsable");
      const top = sortedEntries(grupos, 3).map(function (e) { return e[0] + " (" + e[1] + ")"; }).join(" · ");
      resumen.textContent = casos.length + (casos.length === 1 ? " caso" : " casos") + (top ? " · últimos grupos: " + top : "");
    }
    const sel = "#tableFueraReporte";
    const txt = function (d) { return esc(d); };
    if (dtRegistry[sel]) { try { dtRegistry[sel].destroy(); } catch (e) {} delete dtRegistry[sel]; }
    dtRegistry[sel] = $(sel).DataTable({
      language: DT_LANG_ES, data: casos, deferRender: true,
      columns: [
        { data: "caso", render: txt }, { data: "fecha_registro", render: txt },
        { data: "estado", render: txt }, { data: "fuera_export_desde", render: txt },
        { data: "grupo_responsable", render: txt }, { data: "responsable", render: txt }, { data: "autor", render: txt },
        { data: null, render: function (d, type, r) { const n1 = nivel1Effective(r); return type === "display" ? nivel1ChipHTML(n1) : n1; } },
        { data: "categoria", render: txt },
        { data: null, render: function (d, type, r) { const c = ansReal(r); return type === "display" ? ansRealPillHTML(c) : c; } },
        { data: null, render: function (d, type, r) { return fechaHoraTxt(r.fecha_estimada_solucion_dt || r.fecha_estimada_solucion, type); } },
        { data: null, render: function (d, type, r) { return fechaHoraTxt(r.fecha_atencion_real_dt || r.fecha_atencion_real, type); } },
        { data: "fecha_modificacion", render: txt }
      ],
      columnDefs: [{ targets: "_all", defaultContent: "" }],
      paging: true, pageLength: 15, order: [], dom: "frtipB", buttons: DT_BUTTONS
    });
  }

  function renderAttention() { populateAtencionFilterBar(); renderAttentionContent(); }

  function renderAttentionContent() {
    const f = ATENCION_FILTER;
    const filtrados = casosEnAtencion().filter(function (r) {
      const n1 = nivel1Effective(r);
      if (f.clasificacion.length && f.clasificacion.indexOf(motivoAtencion(r)) === -1) return false;
      if (f.nivel1.length && f.nivel1.indexOf(n1) === -1) return false;
      if (f.nivel2.length && f.nivel2.indexOf(r.nivel2) === -1) return false;
      if (f.grupo.length && f.grupo.indexOf(r.grupo_responsable) === -1) return false;
      if (f.responsable.length && f.responsable.indexOf(r.responsable) === -1) return false;
      if (f.estado.length && f.estado.indexOf(r.estado) === -1) return false;
      if (f.fechaDesde && (r.fecha_registro || "") < f.fechaDesde) return false;
      if (f.fechaHasta && (r.fecha_registro || "") > f.fechaHasta) return false;
      return true;
    });
    const porMotivo = { "Vencido": 0, "Crítico": 0, "Vencido por fecha": 0 };
    const vencPorResp = {}, vencPorCat = {}, vencPorN1 = {};
    filtrados.forEach(function (r) {
      const m = motivoAtencion(r); porMotivo[m]++;
      if (m === "Crítico") return;  // los destacados cuentan vencidos (por progreso o por fecha)
      const suma = function (o, k) { o[k] = (o[k] || 0) + 1; };
      suma(vencPorResp, r.responsable || "Sin asignar"); suma(vencPorCat, r.categoria || "Sin categoría"); suma(vencPorN1, nivel1Effective(r));
    });
    const grid = document.getElementById("kpiAttentionGrid");
    if (grid) {
      grid.innerHTML =
        kpi("Vencidos", porMotivo["Vencido"], "vencido", "bi-x-octagon", "por Progreso · requieren acción inmediata") +
        kpi("Vencidos por fecha", porMotivo["Vencido por fecha"], "vencido", "bi-calendar-x", "pasó la fecha estimada sin atención (p. ej. En Espera)") +
        kpi("Críticos", porMotivo["Crítico"], "critico", "bi-exclamation-triangle", "por vencer en horas") +
        kpi("Total en atención", filtrados.length, "atencion", "bi-megaphone", "vencidos + vencidos por fecha + críticos");
    }
    setSpotlight("spotlightResponsable", topEntry(vencPorResp)); setSpotlight("spotlightCategoria", topEntry(vencPorCat)); setSpotlight("spotlightArea", topEntry(vencPorN1));

    // Orden: vencidos, vencidos por fecha, críticos; dentro de cada uno, mayor progreso primero.
    const atencionCases = filtrados.slice().sort(function (a, b) {
      return (MOTIVOS_ATENCION.indexOf(motivoAtencion(a)) - MOTIVOS_ATENCION.indexOf(motivoAtencion(b))) ||
        (effectiveProgreso(b) - effectiveProgreso(a));
    });

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
    // Vencido por Progreso o, aunque el Progreso no avance (p. ej. En Espera), por Condición real de ANS.
    const real = ansReal(r);
    const rowClass = (cls === "Vencido" || real === "Vencido sin atender") ? "row--vencido" : (cls === "Critico" ? "row--critico" : "");
    const prog = effectiveProgreso(r);
    let html = '<tr class="' + rowClass + '">';
    html += '<td>' + esc(r.caso) + '</td>';
    html += '<td>' + nivel1ChipHTML(nivel1Effective(r)) + '</td>';
    if (includeFecha) html += '<td>' + esc(r.fecha_registro) + '</td>';
    html += '<td>' + esc(r.estado) + '</td>';
    html += '<td data-order="' + ANS_REAL.indexOf(real) + '">' + ansRealPillHTML(real) + '</td>';
    html += '<td>' + esc(r.categoria) + '</td>';
    html += '<td>' + esc(r.responsable) + '</td>';
    html += '<td data-order="' + esc(r.fecha_estimada_solucion_dt || r.fecha_estimada_solucion || "") + '">' + fechaHoraTxt(r.fecha_estimada_solucion_dt || r.fecha_estimada_solucion, "display") + '</td>';
    html += '<td data-order="' + (r.tiempo_transcurrido_dias || 0) + '">' + fmtDuracion(r.tiempo_transcurrido_dias || 0) + '</td>';
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
      { key: "ansReal", label: "Condición real ANS", icon: "bi-stopwatch", opts: ANS_REAL },
      { key: "autor", label: "Autor", icon: "bi-person-plus", opts: AUTORES_GESTORES },
      { key: "grupo", label: "Grupo", icon: "bi-building", field: "grupo_responsable" },
      { key: "responsable", label: "Responsable", icon: "bi-person", field: "responsable" },
      { key: "estado", label: "Estado", icon: "bi-circle-half", field: "estado" },
      { key: "condicion", label: "Condición", icon: "bi-toggle2-on", opts: CONDICIONES },
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
        kpiClientes(STATE.casos) +
        kpi("Abiertos", s.abiertos, "info", "bi-folder2-open", pct(s.abiertos, s.total) + "% del total") +
        kpi("Cerrados", s.cerrados, "sla", "bi-check2-all", pct(s.cerrados, s.total) + "% del total") +
        kpi("Cumplimiento ANS", pctCumplimiento(s.ansReal) + "%", "sla", "bi-stopwatch", (s.ansReal["Incumplido"] + s.ansReal["Vencido sin atender"]) + " fuera de ANS · Condición real") +
        kpi("Vencidos abiertos", s.vencidos, "vencido", "bi-x-octagon", s.criticos + " críticos · " + s.riesgo + " en riesgo") +
        kpi("Vencidos cerrados", s.vencidosCerrados, "vencido", "bi-archive", pct(s.vencidosCerrados, s.cerrados) + "% de los cerrados se cerró fuera del ANS") +
        kpi("Tiempo promedio", fmtDuracion(s.avgTiempo), "normal", "bi-clock-history", "transcurrido por caso");
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
            const cond = esFueraReporte(r) ? "Fuera del reporte" : esAbierto(r) ? "Abierto" : "Cerrado";
            if (type === "display" && esFueraReporte(r)) return '<span class="cond-chip cond-chip--fuera" title="Dejó de venir en el export desde ' + esc(r.fuera_export_desde) + ' (p. ej. escalado a un grupo fuera del reporte). Estado: último conocido.">Fuera del reporte</span>';
            return type === "display" ? '<span class="cond-chip cond-chip--' + cond.toLowerCase() + '">' + cond + '</span>' : cond;
          } },
          { data: null, render: function (d, type, r) {
            const c = clasificacionCaso(r);
            if (type === "display") return clasificacionPillHTML(c);
            return type === "sort" ? CLASIFICACIONES.indexOf(c) : c;  // ordena Vencido primero
          } },
          { data: null, render: function (d, type, r) {
            const c = ansReal(r);
            if (type === "display") return ansRealPillHTML(c);
            return type === "sort" ? ANS_REAL.indexOf(c) : c;
          } },
          { data: null, render: function (d, type, r) { const n1 = nivel1Effective(r); return type === "display" ? nivel1ChipHTML(n1) : n1; } },
          { data: "categoria", render: txt }, { data: "autor", render: txt }, { data: "responsable", render: txt },
          { data: "grupo_responsable", render: txt }, { data: "tipo_registro", render: txt },
          { data: null, render: function (d, type, r) { return fechaHoraTxt(r.fecha_estimada_solucion_dt || r.fecha_estimada_solucion, type); } },
          { data: null, render: function (d, type, r) { return fechaHoraTxt(r.fecha_atencion_real_dt || r.fecha_atencion_real, type); } },
          { data: "fecha_modificacion", render: txt },
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
        paging: true, pageLength: 15, order: [[16, "desc"], [15, "desc"]], dom: "frtipB", buttons: DT_BUTTONS
      });
    }
  }

  function renderCasosCharts(s, cats) {
    const recs = STATE.casos;

    // Tendencia: una serie por categoría (o solo la activa).
    const periodContainer = document.getElementById("casosTendPeriod");
    if (periodContainer) { periodContainer.innerHTML = buildPeriodBtnsHTML(true); wireTendencyBtns(periodContainer); }
    const series = _casosActiveCat ? [_casosActiveCat] : cats;
    const tendTitle = document.getElementById("casosTendTitle");
    if (tendTitle) tendTitle.textContent = _casosActiveCat ? "Casos registrados" : "Casos registrados por categoría";
    if (TENDENCY_PERIOD === "hora") {
      // Franja horaria: barras por hora, apiladas por tipo de servicio.
      const porHora = series.map(function (c) {
        return getTendenciaCounts(recs.filter(function (r) { return nivel1Effective(r) === c; }), "hora", "fecha_registro", CASOS_FILTER);
      });
      const totales = porHora[0] ? porHora[0].map(function (b, h) { return { label: b.label, count: porHora.reduce(function (s, p) { return s + p[h].count; }, 0) }; }) : [];
      const pico = horaPico(totales);
      if (tendTitle) tendTitle.textContent = "Casos por hora de registro" + (pico ? " · pico " + pico.label + " (" + pico.count.toLocaleString("es-CO") + ")" : "");
      ajustarScrollTendencia("casosTendInner", 24);
      renderChart("chartCasosTendencia", "bar", { labels: totales.map(function (b) { return b.label; }),
        datasets: series.map(function (c, i) {
          return { label: c, data: porHora[i].map(function (b) { return b.count; }), backgroundColor: SERIES_PALETTE[i % SERIES_PALETTE.length] };
        }) }, horasOpts(true));
    } else {
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
    }

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
      if (!porGrupo[g]) porGrupo[g] = { abiertos: 0, cerrados: 0, fuera: 0 };
      porGrupo[g][esAbierto(r) ? "abiertos" : esFueraReporte(r) ? "fuera" : "cerrados"]++;
    });
    const topGrupos = Object.keys(porGrupo).sort(function (a, b) {
      return (porGrupo[b].abiertos + porGrupo[b].cerrados + porGrupo[b].fuera) - (porGrupo[a].abiertos + porGrupo[a].cerrados + porGrupo[a].fuera);
    }).slice(0, 15);
    const cvGrupo = document.getElementById("chartCasosGrupo");
    if (cvGrupo && cvGrupo.parentElement) cvGrupo.parentElement.style.height = Math.max(200, topGrupos.length * 30 + 70) + "px";
    renderChart("chartCasosGrupo", "bar", { labels: topGrupos, datasets: [
      { label: "Abiertos", data: topGrupos.map(function (g) { return porGrupo[g].abiertos; }), backgroundColor: "#C0151A" },
      { label: "Cerrados", data: topGrupos.map(function (g) { return porGrupo[g].cerrados; }), backgroundColor: "#9C8C7E" }
    ].concat(topGrupos.some(function (g) { return porGrupo[g].fuera; }) ? [
      { label: "Fuera del reporte", data: topGrupos.map(function (g) { return porGrupo[g].fuera; }), backgroundColor: "#D9CFC6" }] : [])
    }, Object.assign(stackedBarOpts(), { indexAxis: "y", scales: { x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }, y: { stacked: true, grid: { display: false } } } }));
    renderChart("chartCasosAns", "doughnut", toChartDataDoughnut(s.ansReal, null, ANS_REAL_COLORS), doughnutOpts());
    // En "Todas": ANS por categoría. Dentro de una categoría: ANS por subcategoría (top 10).
    const ansTitle = document.getElementById("casosAnsCatTitle");
    if (ansTitle) ansTitle.textContent = _casosActiveCat ? "Cumplimiento de ANS por subcategoría" : "Cumplimiento de ANS por categoría";
    if (_casosActiveCat) {
      const topSub = sortedEntries(porNivel2, 10).map(function (e) { return e[0]; });
      const ansSub = {};
      recs.forEach(function (r) {
        if (topSub.indexOf(r.nivel2) === -1) return;
        if (!ansSub[r.nivel2]) ansSub[r.nivel2] = contadorAnsReal();
        ansSub[r.nivel2][ansReal(r)]++;
      });
      renderChart("chartCasosAnsCat", "bar", { labels: topSub, datasets: datasetsAnsReal(topSub, function (n2) { return ansSub[n2]; }) }, Object.assign(stackedBarOpts(), { indexAxis: "y", scales: { x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }, y: { stacked: true, grid: { display: false } } } }));
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
    if (periodContainer) { periodContainer.innerHTML = buildPeriodBtnsHTML(false); wireTendencyBtns(periodContainer); }
    const buckets = getTendenciaCounts(STATE.tareas, periodoPara(false), "fecha_creacion", TAREAS_FILTER);
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
      if (esAbierto(r)) {
        d.abiertos++;
        const cls = classify(effectiveProgreso(r));
        if (cls === "Vencido") d.vencidosActivos++; else if (cls === "Critico") d.criticosActivos++;
      } else if (esCerrado(r)) {
        d.solucionados++;
        if (ansReal(r) === "Incumplido") d.vencidosCerrados++;  // cerrado fuera del ANS (Condición real)
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
      d.avgTiempoSol = d.tiemposSol.length ? d.tiemposSol.reduce(function (s, v) { return s + v; }, 0) / d.tiemposSol.length : null;  // días
    });
    return byResp;
  }

  /* ---------- Evaluación por período (día / semana / mes) ----------
     Por persona, en el rango de rangoGestion():
       - Registrados: casos que creó (Autor) con fecha de registro en el rango. Cuentan
         igual los que resolvió y los que pasó a otra área (no se evalúa el escalamiento).
       - Desarrollados: casos de los que es Responsable con atención real o cierre en el rango
         (incluye los que le asigna el sistema).
       - Gestionados: casos distintos registrados, desarrollados o modificados (sin duplicar).
       - ANS real y horas de atención de lo que atendió en el rango (horas: solo casos
         nacidos en el Aranda nuevo; los migrados conservan su fecha de registro original).
       - Pendientes: foto de HOY (abiertos, vencidos sin atender, antigüedad), no del rango.
     Atribución: Responsable ACTUAL del caso (el export no dice quién hizo cada cambio;
     el historial que guarda el pipeline desde 2026-10-01 permitirá afinarlo). */
  function nombreNorm(r) { if (r._nResp === undefined) r._nResp = normalizeName(r.responsable); return r._nResp; }
  function autorNorm(r) { if (r._nAutor === undefined) r._nAutor = normalizeName(r.autor); return r._nAutor; }
  function enRango(v, rg) { const s = (fechaValida(v) || "").slice(0, 10); return s !== "" && s >= rg.desde && s <= rg.hasta; }
  function mismaPersona(a, b) { return a === b || (a && b && (a.indexOf(b) === 0 || b.indexOf(a) === 0)); }
  function mediana(arr) {
    if (!arr.length) return null;
    const s = arr.slice().sort(function (a, b) { return a - b; }), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function evaluarPersona(nombre, rg) {
    const n = normalizeName(nombre), hoy = new Date(isoToday() + "T00:00:00");
    const e = { nombre: nombre, registrados: 0, desarrollados: 0, modificados: 0, gestionados: 0, tareas: 0, clientesSet: new Set(),
      ansCumplido: 0, ansIncumplido: 0, horas: [], abiertos: 0, vencidosSinAtender: 0, edades: [] };
    const llaves = new Set();
    STATE.rawCasos.forEach(function (r) {
      if (RESP_FILTER.nivel1.length && RESP_FILTER.nivel1.indexOf(nivel1Effective(r)) === -1) return;
      if (autorNorm(r) === n && enRango(r.fecha_registro, rg)) { e.registrados++; llaves.add(r.llave); if (r.cliente_id) e.clientesSet.add(r.cliente_id); }
      if (nombreNorm(r) !== n) return;
      const at = enRango(r.fecha_atencion_real, rg), ce = enRango(r.fecha_cierre, rg), mo = enRango(r.fecha_modificacion, rg);
      if (at || ce) e.desarrollados++;
      if (mo) e.modificados++;
      if (at || ce || mo) { llaves.add(r.llave); if (r.cliente_id) e.clientesSet.add(r.cliente_id); }
      if (at) {
        const res = ansReal(r);
        if (res === "Cumplido") e.ansCumplido++; else if (res === "Incumplido") e.ansIncumplido++;
        if (r.fuente === "nuevo" && !r.caso_anterior && fechaValida(r.fecha_registro_dt) && fechaValida(r.fecha_atencion_real_dt)) {
          const h = (new Date(r.fecha_atencion_real_dt) - new Date(r.fecha_registro_dt)) / 3600000;
          if (h >= 0) e.horas.push(h);
        }
      }
      if (esAbierto(r)) {
        e.abiertos++;
        if (ansReal(r) === "Vencido sin atender") e.vencidosSinAtender++;
        if (fechaValida(r.fecha_registro)) e.edades.push((hoy - new Date(r.fecha_registro.slice(0, 10) + "T00:00:00")) / 86400000);
      }
    });
    STATE.rawTareas.forEach(function (t) { if (enRango(t.fecha_creacion, rg) && mismaPersona(nombreNorm(t), n)) e.tareas++; });
    e.gestionados = llaves.size;
    e.clientes = e.clientesSet.size;  // clientes distintos detrás de sus casos gestionados
    e.ansPct = (e.ansCumplido + e.ansIncumplido) ? pct(e.ansCumplido, e.ansCumplido + e.ansIncumplido) : null;
    e.horasMediana = mediana(e.horas);
    e.edadPromedio = e.edades.length ? e.edades.reduce(function (s, v) { return s + v; }, 0) / e.edades.length : null;
    e.actividad = e.gestionados + e.tareas;
    return e;
  }
  // Clientes distintos entre varias personas (un cliente atendido por dos asesores cuenta una vez).
  function clientesUnion(evals) {
    const todos = new Set();
    evals.forEach(function (e) { e.clientesSet.forEach(function (c) { todos.add(c); }); });
    return todos.size;
  }
  function esAsesorCAE(nombre) { return AUTORES_GESTORES.some(function (a) { return namesMatch(a, nombre); }); }
  // Mediana de atención (horas) con el mismo formato de los tiempos promedio: "0 d 2 h 15 min".
  function fmtHoras(h) { return h === null ? "—" : fmtDuracion(h / 24); }

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

  // Rango de la Gestión: el día elegido, su semana (lunes a domingo) o su mes.
  function rangoGestion() {
    const p = function (n) { return String(n).padStart(2, "0"); };
    const iso = function (d) { return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };
    const ref = new Date(_respDia + "T00:00:00");
    if (_respPeriodo === "semana") {
      const lunes = new Date(ref); lunes.setDate(ref.getDate() - ((ref.getDay() + 6) % 7));
      const domingo = new Date(lunes); domingo.setDate(lunes.getDate() + 6);
      return { desde: iso(lunes), hasta: iso(domingo), nombre: "semana", texto: "semana del " + iso(lunes) + " al " + iso(domingo) };
    }
    if (_respPeriodo === "mes") {
      const ini = new Date(ref.getFullYear(), ref.getMonth(), 1), fin = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
      return { desde: iso(ini), hasta: iso(fin), nombre: "mes", texto: ref.toLocaleDateString("es-CO", { month: "long", year: "numeric" }) };
    }
    return { desde: _respDia, hasta: _respDia, nombre: "día", texto: _respDia === isoToday() ? "hoy" : _respDia };
  }

  // Controles del período (fecha, día/semana/mes y casillas de filtro).
  function wireControlesPeriodo() {
    const input = document.getElementById("respDia");
    if (input) {
      input.value = _respDia;
      if (!input._wired) { input._wired = true; input.addEventListener("change", function () { _respDia = this.value || isoToday(); renderResponsablesContent(); }); }
    }
    const btns = document.getElementById("respPeriodoBtns");
    if (btns) btns.querySelectorAll(".tend-btn").forEach(function (b) {
      b.classList.toggle("tend-btn--active", b.getAttribute("data-periodo") === _respPeriodo);
      if (!b._wired) { b._wired = true; b.addEventListener("click", function () { _respPeriodo = this.getAttribute("data-periodo"); renderResponsablesContent(); }); }
    });
    const solo = document.getElementById("respSoloDia");
    if (solo) {
      solo.checked = _respSoloDia;
      if (!solo._wired) { solo._wired = true; solo.addEventListener("change", function () { _respSoloDia = this.checked; renderResponsablesContent(); }); }
    }
    const asesores = document.getElementById("respSoloAsesores");
    if (asesores) {
      asesores.checked = _respSoloAsesores;
      if (!asesores._wired) { asesores._wired = true; asesores.addEventListener("change", function () { _respSoloAsesores = this.checked; renderResponsablesContent(); }); }
    }
  }

  // KPIs y tabla de evaluación del período.
  function renderEvaluacion(evals, rg) {
    const titulo = document.getElementById("respGestionTitulo");
    if (titulo) titulo.textContent = { "día": "Gestión del día", "semana": "Gestión de la semana", "mes": "Gestión del mes" }[rg.nombre];
    document.querySelectorAll(".resp-per-lbl").forEach(function (el) { el.textContent = rg.nombre; });
    const sum = function (k) { return evals.reduce(function (s, e) { return s + e[k]; }, 0); };
    const todasHoras = [].concat.apply([], evals.map(function (e) { return e.horas; }));
    const activos = evals.filter(function (e) { return e.actividad > 0; }).sort(function (a, b) { return b.actividad - a.actividad; });
    const grid = document.getElementById("kpiRespDia");
    if (grid) grid.innerHTML =
      kpi("Casos gestionados", sum("gestionados"), "info", "bi-calendar-check", rg.texto + " · registrados, desarrollados o modificados") +
      kpi("Clientes atendidos", clientesUnion(evals), "info", "bi-person-vcard", "clientes distintos detrás de esos casos") +
      kpi("Registrados", sum("registrados"), "info", "bi-pencil-square", "creados como autor (resueltos o escalados)") +
      kpi("Desarrollados", sum("desarrollados"), "sla", "bi-check2-circle", "como responsable: con atención real o cierre") +
      kpi("Tareas", sum("tareas"), "info", "bi-list-check", "tareas/eventos creados") +
      kpi("Mediana de atención", fmtHoras(mediana(todasHoras)), "normal", "bi-clock-history", "del registro a la atención real (" + todasHoras.length + " casos)") +
      kpi("Vencidos sin atender", sum("vencidosSinAtender"), "vencido", "bi-x-octagon", "hoy · " + sum("abiertos") + " abiertos") +
      kpi("Con gestión", activos.length, "info", "bi-people",
        activos.length ? "más activo: " + activos[0].nombre + " (" + activos[0].gestionados + " casos, " + activos[0].tareas + " tareas)" : "sin gestión registrada");

    const sel = "#tableRespEval";
    if (dtRegistry[sel]) { try { dtRegistry[sel].destroy(); } catch (x) {} delete dtRegistry[sel]; }
    const tbody = document.querySelector(sel + " tbody");
    if (tbody) tbody.innerHTML = evals.map(function (e) {
      return '<tr class="resp-row" data-resp="' + esc(e.nombre) + '">' +
        '<td><strong>' + esc(e.nombre) + '</strong></td>' +
        '<td data-order="' + e.gestionados + '"><strong>' + e.gestionados + '</strong></td>' +
        '<td data-order="' + e.clientes + '">' + e.clientes + '</td>' +
        '<td data-order="' + e.registrados + '">' + e.registrados + '</td>' +
        '<td data-order="' + e.desarrollados + '">' + e.desarrollados + '</td>' +
        '<td data-order="' + e.modificados + '">' + e.modificados + '</td>' +
        '<td data-order="' + e.tareas + '">' + e.tareas + '</td>' +
        '<td data-order="' + (e.horasMediana === null ? 1e9 : e.horasMediana) + '">' + fmtHoras(e.horasMediana) + '</td>' +
        '<td data-order="' + e.abiertos + '">' + e.abiertos + '</td>' +
        '<td data-order="' + e.vencidosSinAtender + '">' + (e.vencidosSinAtender ? '<span class="resp-badge resp-badge--vencido">' + e.vencidosSinAtender + '</span>' : "0") + '</td>' +
        '<td data-order="' + (e.edadPromedio === null ? -1 : e.edadPromedio) + '">' + (e.edadPromedio === null ? "—" : Math.round(e.edadPromedio) + " d") + '</td></tr>';
    }).join("");
    dtRegistry[sel] = $(sel).DataTable(Object.assign({ language: DT_LANG_ES }, { paging: true, pageLength: 10, order: [[1, "desc"]], dom: "frtipB", buttons: DT_BUTTONS }));
    renderComparativaResponsables(evals);
  }

  function renderResponsablesContent() {
    const rg = rangoGestion();
    wireControlesPeriodo();
    const byResp = computeResponsablesCombined();
    // Asesores del CAE: aparecen aunque los filtros los dejen sin casos en el histórico de la vista.
    if (_respSoloAsesores && !RESP_FILTER.responsable.length) AUTORES_GESTORES.forEach(function (a) {
      if (!Object.keys(byResp).some(function (k) { return namesMatch(k, a); }))
        byResp[a] = { nombre: a, totalCasos: 0, abiertos: 0, vencidosActivos: 0, criticosActivos: 0, vencidosCerrados: 0, solucionados: 0,
          tiemposSol: [], totalTareas: 0, tareasPendientes: 0, categorias: {}, tasaResolucion: 0, avgTiempoSol: null };
    });
    const evalDe = {};
    // "Solo asesores del CAE" y "Solo con gestión en el período" filtran ambas tablas y los KPIs.
    const responsables = Object.values(byResp)
      .filter(function (r) { return !_respSoloAsesores || esAsesorCAE(r.nombre); })
      .filter(function (r) { evalDe[r.nombre] = evaluarPersona(r.nombre, rg); return !_respSoloDia || evalDe[r.nombre].actividad > 0; })
      .sort(function (a, b) { return b.totalCasos - a.totalCasos; });
    renderEvaluacion(responsables.map(function (r) { return evalDe[r.nombre]; }), rg);

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

    // Clic en una fila de cualquiera de las dos tablas abre el detalle.
    $("#tableRespResumen tbody, #tableRespEval tbody").off("click.resp").on("click.resp", "tr.resp-row", function () {
      const nombre = $(this).attr("data-resp");
      if (nombre && byResp[nombre]) { _respDetalleActual = nombre; renderResponsableDetalle(byResp[nombre], evalDe[nombre]); }
    });
    const closeBtn = document.getElementById("btnCerrarRespDetalle");
    if (closeBtn && !closeBtn._wired) { closeBtn._wired = true; closeBtn.addEventListener("click", function () { const p = document.getElementById("panelRespDetalle"); if (p) p.style.display = "none"; _respDetalleActual = null; }); }
    if (_respDetalleActual && byResp[_respDetalleActual]) renderResponsableDetalle(byResp[_respDetalleActual], evalDe[_respDetalleActual]);
  }

  /* ---------- Series semanales (tendencia del responsable y comparativa) ----------
     Mismas reglas que evaluarPersona(), pero por semana (lunes a domingo) y en una sola
     pasada por los datos para todas las personas pedidas. */
  const _lunesDe = {};
  function lunesDe(fecha) {
    const s = (fechaValida(fecha) || "").slice(0, 10); if (!s) return null;
    if (_lunesDe[s] === undefined) {
      const d = new Date(s + "T00:00:00"); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      _lunesDe[s] = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }
    return _lunesDe[s];
  }
  // { semanas: ["2026-09-07", …], por: { nombre: { registrados:{sem:n}, desarrollados, gestionados, tareas, cumplidos, atendidosAns } } }
  function seriesSemanales(nombres) {
    const idx = {}, por = {};
    nombres.forEach(function (nm) {
      idx[normalizeName(nm)] = nm;
      por[nm] = { registrados: {}, desarrollados: {}, gestionados: {}, tareas: {}, cumplidos: {}, atendidosAns: {} };
    });
    const suma = function (obj, sem) { if (sem) obj[sem] = (obj[sem] || 0) + 1; };
    let min = null;
    const verSem = function (sem) { if (sem && (!min || sem < min)) min = sem; };
    STATE.rawCasos.forEach(function (r) {
      if (RESP_FILTER.nivel1.length && RESP_FILTER.nivel1.indexOf(nivel1Effective(r)) === -1) return;
      const autor = idx[autorNorm(r)], resp = idx[nombreNorm(r)];
      if (!autor && !resp) return;
      const gest = {};  // semanas en que este caso cuenta como gestionado, por persona
      if (autor) { const s = lunesDe(r.fecha_registro); suma(por[autor].registrados, s); verSem(s); if (s) gest[autor + "|" + s] = [autor, s]; }
      if (resp) {
        const sa = lunesDe(r.fecha_atencion_real), sc = lunesDe(r.fecha_cierre), sm = lunesDe(r.fecha_modificacion);
        [sa, sc].filter(function (s, i, a) { return s && a.indexOf(s) === i; }).forEach(function (s) { suma(por[resp].desarrollados, s); verSem(s); });
        [sa, sc, sm].forEach(function (s) { if (s) gest[resp + "|" + s] = [resp, s]; });
        if (sa) {
          const res = ansReal(r);
          if (res === "Cumplido" || res === "Incumplido") { suma(por[resp].atendidosAns, sa); if (res === "Cumplido") suma(por[resp].cumplidos, sa); }
        }
      }
      Object.keys(gest).forEach(function (k) { suma(por[gest[k][0]].gestionados, gest[k][1]); });
    });
    STATE.rawTareas.forEach(function (t) {
      const tn = nombreNorm(t); if (!tn) return;
      const nm = Object.keys(idx).find(function (n) { return mismaPersona(tn, n); });
      if (nm) { const s = lunesDe(t.fecha_creacion); suma(por[idx[nm]].tareas, s); verSem(s); }
    });
    // Semanas desde la primera con actividad hasta la de la fecha elegida (máx. 2 años).
    const fin = lunesDe(_respDia), semanas = [];
    if (min && fin) {
      const d = new Date(fin + "T00:00:00"), limite = new Date(min + "T00:00:00");
      for (let k = 0; k < 104 && d >= limite; k++) { semanas.unshift(lunesDe(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"))); d.setDate(d.getDate() - 7); }
    }
    return { semanas: semanas, por: por };
  }
  function valorSemanal(p, indicador, sem) {
    if (indicador === "ans") return p.atendidosAns[sem] ? pct(p.cumplidos[sem] || 0, p.atendidosAns[sem]) : null;
    return p[indicador][sem] || 0;
  }
  // Ancho del lienzo para series semanales con barra de desplazamiento (≈70 px por semana).
  function anchoSemanal(innerId, n) {
    const inner = document.getElementById(innerId); if (!inner) return;
    const wrap = inner.parentElement, pW = wrap ? wrap.clientWidth : 0;
    inner.style.width = Math.max(n * 70, pW || 300) + "px";
    if (wrap) requestAnimationFrame(function () { wrap.scrollLeft = wrap.scrollWidth; });
  }
  // "28 sep – 4 oct": la semana completa (lunes a domingo), para que se vea que incluye hoy.
  const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  function etiquetaSemana(sem) {
    const ini = new Date(sem + "T00:00:00"), fin = new Date(ini); fin.setDate(ini.getDate() + 6);
    const f = function (d) { return d.getDate() + " " + MESES_CORTOS[d.getMonth()]; };
    return f(ini) + " – " + f(fin);
  }

  // Tendencia semanal de una persona: todas las semanas con actividad (con barra de desplazamiento).
  function renderTendenciaResponsable(nombre) {
    const ss = seriesSemanales([nombre]), p = ss.por[nombre], sem = ss.semanas;
    anchoSemanal("respTendInner", sem.length);
    renderChart("chartRespTendencia", "bar", { labels: sem.map(etiquetaSemana), datasets: [
      { label: "Registrados", data: sem.map(function (s) { return valorSemanal(p, "registrados", s); }), backgroundColor: "#8C0F13", borderRadius: 3, yAxisID: "y" },
      { label: "Desarrollados", data: sem.map(function (s) { return valorSemanal(p, "desarrollados", s); }), backgroundColor: "#4A6B8C", borderRadius: 3, yAxisID: "y" },
      { label: "Tareas", data: sem.map(function (s) { return valorSemanal(p, "tareas", s); }), backgroundColor: "#D9A441", borderRadius: 3, yAxisID: "y" },
      { type: "line", label: "ANS real %", data: sem.map(function (s) { return valorSemanal(p, "ans", s); }), sufijo: "%",
        borderColor: "#2a7a3b", backgroundColor: "#2a7a3b", yAxisID: "y1", spanGaps: true, tension: 0.3, pointRadius: 3 }
    ] }, {
      maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 11, boxHeight: 11, padding: 14 } }, pctLabels: { modo: "valor" } },
      scales: { x: { grid: { display: false } },
        y: { beginAtZero: true, grid: gridOpts(), ticks: { precision: 0 }, title: { display: true, text: "Casos / tareas" } },
        y1: { position: "right", min: 0, max: 100, grid: { display: false }, ticks: { callback: function (v) { return v + "%"; } }, title: { display: true, text: "ANS real" } } }
    });
  }

  // Comparativa semanal: una línea por persona de la evaluación (máx. 8, las de más actividad).
  const COMPARATIVA_INDICADORES = { gestionados: "Casos gestionados", registrados: "Registrados", desarrollados: "Desarrollados", tareas: "Tareas", ans: "ANS real %" };
  let _respComparativa = "gestionados";
  function renderComparativaResponsables(evals) {
    const btns = document.getElementById("respCompBtns");
    if (btns) btns.querySelectorAll(".tend-btn").forEach(function (b) {
      b.classList.toggle("tend-btn--active", b.getAttribute("data-ind") === _respComparativa);
      if (!b._wired) { b._wired = true; b.addEventListener("click", function () { _respComparativa = this.getAttribute("data-ind"); renderComparativaResponsables(_ultimasEvals); }); }
    });
    _ultimasEvals = evals;
    const personas = evals.slice().sort(function (a, b) { return b.actividad - a.actividad; }).slice(0, 8).map(function (e) { return e.nombre; });
    const nota = document.getElementById("respCompNota");
    if (nota) nota.textContent = evals.length > 8 ? "Se muestran las 8 personas con más actividad en el período; use \"Solo asesores del CAE\" o el filtro de Responsable para elegir." : "";
    const ss = seriesSemanales(personas), sem = ss.semanas, esAns = _respComparativa === "ans";
    anchoSemanal("respCompInner", sem.length);
    renderChart("chartRespComparativa", "line", { labels: sem.map(etiquetaSemana), datasets: personas.map(function (nm, i) {
      const color = COLORES_PERSONAS[i % COLORES_PERSONAS.length];
      return { label: nm, data: sem.map(function (s) { return valorSemanal(ss.por[nm], _respComparativa, s); }), sufijo: esAns ? "%" : "",
        borderColor: color, backgroundColor: color, spanGaps: true, tension: 0.3, pointRadius: 3, fill: false };
    }) }, lineOpts({ scales: { x: { grid: { display: false } },
      y: Object.assign({ beginAtZero: true, grid: gridOpts(), ticks: { precision: 0 } }, esAns ? { max: 100, ticks: { callback: function (v) { return v + "%"; } } } : {}) } }));
  }
  let _ultimasEvals = [];
  // Colores bien distinguibles entre sí para una línea por persona.
  const COLORES_PERSONAS = ["#8C0F13", "#4A6B8C", "#D9A441", "#2a7a3b", "#6B4E8C", "#B5654A", "#4A0608", "#9C8C7E"];

  function renderResponsableDetalle(d, ev) {
    if (!d) return;
    const panel = document.getElementById("panelRespDetalle"); if (panel) panel.style.display = "";
    const nameEl = document.getElementById("respDetalleNombre"); if (nameEl) nameEl.innerHTML = '<i class="bi bi-person-circle"></i> ' + esc(d.nombre);

    const kpiGrid = document.getElementById("kpiRespDetalle");
    if (kpiGrid) {
      const tiempoStr = fmtDuracion(d.avgTiempoSol);
      kpiGrid.innerHTML =
        kpi("Casos abiertos", d.abiertos, "info", "bi-folder2-open", "En Espera · En Proceso · Registrado") +
        kpi("Vencidos abiertos", d.vencidosActivos, "vencido", "bi-x-octagon", "") +
        kpi("Críticos abiertos", d.criticosActivos, "critico", "bi-exclamation-triangle", "") +
        kpi("Vencidos cerrados", d.vencidosCerrados, "vencido", "bi-archive", pct(d.vencidosCerrados, d.solucionados) + "% de sus cerrados") +
        kpi("% Resolución", d.tasaResolucion + "%", "sla", "bi-graph-up", d.solucionados + " solucionados") +
        kpi("Tiempo prom. solución", tiempoStr, "normal", "bi-clock-history", "") +
        kpi("Tareas (total / pendientes)", d.totalTareas + " / " + d.tareasPendientes, "info", "bi-list-check", "") +
        (ev ? kpi("Gestión (" + rangoGestion().nombre + ")", ev.gestionados, "info", "bi-calendar-check", rangoGestion().texto + " · " +
          ev.registrados + " registrados · " + ev.desarrollados + " desarrollados · " + ev.tareas + " tareas") +
          kpi("ANS real (" + rangoGestion().nombre + ")", ev.ansPct === null ? "—" : ev.ansPct + "%", "sla", "bi-stopwatch", (ev.ansCumplido + ev.ansIncumplido) + " atendidos en el período") +
          kpi("Mediana de atención", fmtHoras(ev.horasMediana), "normal", "bi-clock-history", "registro → atención real") : "");
    }
    renderChart("chartRespCategorias", "bar", toChartDataBar(d.categorias, "#8C0F13", 8), horizontalBarOpts());
    renderTendenciaResponsable(d.nombre);

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

    const casosResp = STATE.rawCasos.filter(function (r) { return r.responsable === d.nombre && esAbierto(r); })
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
        ansReal: contadorAnsReal(), sumTiempo: 0, responsables: {} };
      const d = byGrupo[g];
      d.total++;
      d.sumTiempo += (r.tiempo_transcurrido_dias || 0);
      d.responsables[r.responsable || "Sin asignar"] = true;
      // Igual que en Responsables: vencidos abiertos (según Progreso actual) y
      // vencidos cerrados (cerrados Incumplidos según la Condición real de ANS).
      const res = ansReal(r);
      d.ansReal[res]++;
      if (esAbierto(r)) {
        d.abiertos++;
        const cls = effectiveClass(r);
        if (cls === "Vencido") d.vencidosAbiertos++; else if (cls === "Critico") d.criticosAbiertos++;
      } else if (esCerrado(r) && res === "Incumplido") d.vencidosCerrados++;
    });
    Object.keys(byGrupo).forEach(function (g) {
      const d = byGrupo[g];
      d.avgTiempo = d.total ? d.sumTiempo / d.total : 0;  // días; se muestra con fmtDuracion
      // % fuera de ANS (Condición real) sobre los casos con resultado (sin "En plazo" ni "Sin dato").
      const conResultado = d.ansReal["Cumplido"] + d.ansReal["Incumplido"] + d.ansReal["Vencido sin atender"];
      d.pctVencidos = pct(d.ansReal["Incumplido"] + d.ansReal["Vencido sin atender"], conResultado);
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
          '<td data-order="' + g.avgTiempo + '">' + fmtDuracion(g.avgTiempo) + '</td>' +
          '<td data-order="' + g.nResponsables + '">' + g.nResponsables + '</td></tr>');
      }).join("");
    }
    dtRegistry[selG] = $(selG).DataTable(Object.assign({ language: DT_LANG_ES }, { paging: true, pageLength: 15, order: [[1, "desc"]], dom: "frtipB", buttons: DT_BUTTONS }));

    // Resultado de ANS de todos los casos (abiertos y cerrados) de los 10 grupos con más casos.
    const top10 = grupos.slice(0, 10);
    const etiquetas = top10.map(function (g) { return g.grupo; });
    renderChart("chartGruposStack", "bar", { labels: etiquetas, datasets: datasetsAnsReal(etiquetas, function (n, i) { return top10[i].ansReal; }) }, stackedBarOpts());
  }


  /* ---------------------- METAS Y PROGRESO (Notion · TAREAS CAE) ---------------------- */
  // Datos: data/metas.json, que arma el pipeline desde Notion (Proyectos, Tareas y
  // Sub tareas). Progreso como en Notion: proyecto = % de tareas finalizadas o
  // canceladas; tarea = % de sub tareas listas.

  const METAS_FILTER = { proyecto: [], estado: [], prioridad: [], asignado: [] };
  const PRIORIDAD_ORDEN = { "Urgente": 0, "Alta": 1, "Medio": 2, "Bajo": 3 };
  const ESTADO_PROYECTO_CLASE = { "En curso": "en-curso", "Atrasado": "atrasado", "En espera": "en-espera",
    "No iniciado": "no-iniciado", "Terminado": "terminado", "Perdido": "perdido" };

  function diasHasta(fechaISO) {
    if (!fechaISO) return null;
    return Math.round((new Date(fechaISO.substring(0, 10) + "T00:00:00") - new Date(isoToday() + "T00:00:00")) / DIA_MS);
  }
  // Situación de una tarea según su fecha de vencimiento.
  function situacionTarea(t) {
    if (t.grupo === "completo") return "completa";
    const d = diasHasta(t.vencimiento);
    if (d === null) return "sin_fecha";
    if (d < 0) return "vencida";
    if (d <= 7) return "proxima";
    return "a_tiempo";
  }
  function tareasMetasFiltradas() {
    const f = METAS_FILTER;
    return (STATE.metas ? STATE.metas.tareas : []).filter(function (t) {
      if (f.proyecto.length && f.proyecto.indexOf(t.proyecto) === -1) return false;
      if (f.estado.length && f.estado.indexOf(t.estado) === -1) return false;
      if (f.prioridad.length && f.prioridad.indexOf(t.prioridad) === -1) return false;
      if (f.asignado.length && !t.asignados.some(function (a) { return f.asignado.indexOf(a) !== -1; })) return false;
      return true;
    });
  }

  const SUB_CLASE = { completo: "listo", en_curso: "en-curso", pendiente: "pendiente" };
  function subtareasHTML(tareaId) {
    const subs = (STATE.metas ? STATE.metas.subtareas : []).filter(function (s) { return s.tareas.indexOf(tareaId) !== -1; })
      .sort(function (a, b) { return ({ completo: 2, en_curso: 0, pendiente: 1 })[a.grupo] - ({ completo: 2, en_curso: 0, pendiente: 1 })[b.grupo]; });
    if (!subs.length) return '<div class="subs-lista">Sin sub tareas</div>';
    return '<div class="subs-lista">' + subs.map(function (s) {
      return '<div class="subs-item"><i class="bi ' + (s.grupo === "completo" ? "bi-check-circle-fill" : "bi-circle") + '"></i>' +
        '<span class="subs-nombre">' + esc(s.nombre) + '</span>' +
        '<span class="subs-estado subs-estado--' + SUB_CLASE[s.grupo] + '">' + esc(s.estado) + '</span>' +
        '<span class="subs-fecha">' + (s.fecha ? esc(s.fecha) : "Sin fecha") + '</span></div>';
    }).join("") + '</div>';
  }

  function populateMetasFilterBar() {
    const bar = document.getElementById("metasFilterBar"); if (!bar || !STATE.metas) return;
    const tareas = STATE.metas.tareas;
    const uniq = function (arr) { return Array.from(new Set(arr.filter(Boolean))).sort(); };
    const dropsHtml =
      buildMsDropHTML("proyecto", "Proyecto", "bi-kanban", uniq(tareas.map(function (t) { return t.proyecto; })), METAS_FILTER) +
      buildMsDropHTML("estado", "Estado", "bi-circle-half", uniq(tareas.map(function (t) { return t.estado; })), METAS_FILTER) +
      buildMsDropHTML("prioridad", "Prioridad", "bi-flag", uniq(tareas.map(function (t) { return t.prioridad; })), METAS_FILTER) +
      buildMsDropHTML("asignado", "Asignada a", "bi-person", uniq([].concat.apply([], tareas.map(function (t) { return t.asignados; }))), METAS_FILTER);
    bar.innerHTML = '<div class="gfb-inner"><span class="gfb-title"><i class="bi bi-funnel-fill"></i> Filtros</span>' +
      '<div class="gfb-drops" id="metasFilterDrops">' + dropsHtml + '</div>' +
      '<button class="gfb-clear" id="metasFilterClear"><i class="bi bi-x-circle"></i> Limpiar</button></div>';
    wireFilterBar("metasFilterBar", "metasFilterDrops", METAS_FILTER, function () { renderMetasContent(); }, []);
    const clearBtn = document.getElementById("metasFilterClear");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      Object.keys(METAS_FILTER).forEach(function (k) { METAS_FILTER[k] = []; });
      populateMetasFilterBar(); renderMetasContent();
    });
  }

  function renderMetas() {
    const vacio = document.getElementById("metasSinDatos"), contenido = document.getElementById("metasContenido");
    if (!STATE.metas) {
      if (vacio) vacio.style.display = ""; if (contenido) contenido.style.display = "none";
      return;
    }
    if (vacio) vacio.style.display = "none"; if (contenido) contenido.style.display = "";
    const fuente = document.getElementById("metasFuente");
    if (fuente) {
      const g = STATE.metas.generado_en ? new Date(STATE.metas.generado_en) : null;
      fuente.innerHTML = 'Fuente: <a href="' + esc(STATE.metas.fuente_url) + '" target="_blank" rel="noopener">' + esc(STATE.metas.fuente) +
        ' <i class="bi bi-box-arrow-up-right"></i></a>' + (g ? ' · actualizado ' + g.toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" }) : '');
    }
    populateMetasFilterBar();
    renderMetasContent();
  }

  function renderMetasContent() {
    const m = STATE.metas; if (!m) return;
    const tareas = tareasMetasFiltradas();
    const idsTareas = {}; tareas.forEach(function (t) { idsTareas[t.id] = true; });
    const completas = tareas.filter(function (t) { return t.grupo === "completo"; }).length;
    const activas = tareas.filter(function (t) { return t.grupo !== "completo"; });
    const vencidas = activas.filter(function (t) { return situacionTarea(t) === "vencida"; });
    const proximas = activas.filter(function (t) { return situacionTarea(t) === "proxima"; });
    const subs = m.subtareas.filter(function (s) { return s.tareas.some(function (id) { return idsTareas[id]; }); });
    const subsListas = subs.filter(function (s) { return s.grupo === "completo"; }).length;
    const proyEnCurso = m.proyectos.filter(function (p) { return p.grupo === "en_curso"; }).length;
    const proyTerminados = m.proyectos.filter(function (p) { return p.grupo === "completo"; }).length;

    const grid = document.getElementById("kpiMetasGrid");
    if (grid) grid.innerHTML =
      kpi("Avance general", pct(completas, tareas.length) + "%", "sla", "bi-bullseye", completas + " de " + tareas.length + " tareas finalizadas") +
      kpi("Proyectos", m.proyectos.length, "info", "bi-kanban", proyEnCurso + " en curso · " + proyTerminados + " terminados") +
      kpi("Tareas activas", activas.length, "info", "bi-list-task", "no finalizadas") +
      kpi("Tareas vencidas", vencidas.length, "vencido", "bi-calendar-x", "pasó su fecha y no están finalizadas") +
      kpi("Vencen en 7 días", proximas.length, "riesgo", "bi-calendar-event", "tareas activas") +
      kpi("Sub tareas listas", subsListas + " / " + subs.length, "normal", "bi-check2-square", pct(subsListas, subs.length) + "% completadas");

    // Tarjetas de proyecto (con los filtros: proyecto y, si se filtra, solo los que tienen tareas visibles)
    const hayFiltroTareas = METAS_FILTER.estado.length || METAS_FILTER.prioridad.length || METAS_FILTER.asignado.length;
    const proyectos = m.proyectos.filter(function (p) {
      if (METAS_FILTER.proyecto.length && METAS_FILTER.proyecto.indexOf(p.nombre) === -1) return false;
      return !hayFiltroTareas || tareas.some(function (t) { return t.proyecto_id === p.id; });
    }).sort(function (a, b) {
      const orden = { en_curso: 0, pendiente: 1, completo: 2 };
      return (orden[a.grupo] - orden[b.grupo]) || (b.progreso - a.progreso);
    });
    const cards = document.getElementById("metasProyectos");
    if (cards) cards.innerHTML = proyectos.map(function (p) {
      const ts = m.tareas.filter(function (t) { return t.proyecto_id === p.id; });
      const venc = ts.filter(function (t) { return situacionTarea(t) === "vencida"; }).length;
      const clase = ESTADO_PROYECTO_CLASE[p.estado] || "sin-estado";
      const plazo = p.plazo_fin ? '<span><i class="bi bi-calendar3"></i> Plazo ' + esc(p.plazo_fin) + '</span>' : '';
      return '<div class="meta-card">' +
        '<div class="meta-card-top"><span class="meta-estado meta-estado--' + clase + '">' + esc(p.estado) + '</span>' +
        (p.url ? '<a class="meta-link" href="' + esc(p.url) + '" target="_blank" rel="noopener" title="Abrir en Notion"><i class="bi bi-box-arrow-up-right"></i></a>' : '') + '</div>' +
        '<div class="meta-card-nombre">' + esc(p.nombre) + '</div>' +
        '<div class="meta-progreso"><div class="progress-track"><div class="progress-fill progress-fill--meta" style="width:' + Math.max(2, p.progreso) + '%"></div></div>' +
        '<strong>' + p.progreso.toFixed(0) + '%</strong></div>' +
        '<div class="meta-card-meta"><span><i class="bi bi-list-check"></i> ' + p.tareas_completas + ' de ' + p.tareas_total + ' tareas</span>' + plazo +
        (venc ? '<span class="meta-venc"><i class="bi bi-exclamation-triangle"></i> ' + venc + ' vencida' + (venc === 1 ? '' : 's') + '</span>' : '') +
        (p.responsables.length ? '<span><i class="bi bi-person"></i> ' + esc(p.responsables.join(", ")) + '</span>' : '') + '</div></div>';
    }).join("") || '<div class="spotlight-empty">Sin proyectos con los filtros aplicados</div>';

    // Gráficos: tareas por estado y por persona asignada
    renderChart("chartMetasEstado", "doughnut", toChartDataDoughnut(countBy(tareas, "estado"), null, {
      "Finalizado": "#2a7a3b", "Cancelado": "#9C8C7E", "En proceso": "#6B4E8C", "En espera de aprobación": "#D9A441",
      "Solicitado": "#4A6B8C", "No iniciado": "#D9CFC6" }), doughnutOpts());
    const porPersona = {};
    tareas.forEach(function (t) {
      (t.asignados.length ? t.asignados : ["Sin asignar"]).forEach(function (a) {
        if (!porPersona[a]) porPersona[a] = { completas: 0, activas: 0, vencidas: 0 };
        if (t.grupo === "completo") porPersona[a].completas++;
        else if (situacionTarea(t) === "vencida") porPersona[a].vencidas++;
        else porPersona[a].activas++;
      });
    });
    const personas = Object.keys(porPersona).sort();
    renderChart("chartMetasPersona", "bar", { labels: personas, datasets: [
      { label: "Finalizadas", data: personas.map(function (p) { return porPersona[p].completas; }), backgroundColor: "#2a7a3b" },
      { label: "Activas", data: personas.map(function (p) { return porPersona[p].activas; }), backgroundColor: "#6B4E8C" },
      { label: "Vencidas", data: personas.map(function (p) { return porPersona[p].vencidas; }), backgroundColor: "#C0151A" }
    ] }, Object.assign(stackedBarOpts(), { indexAxis: "y", scales: { x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }, y: { stacked: true, grid: { display: false } } } }));

    // Tabla de tareas: activas primero, luego por fecha de vencimiento
    const SIT = { vencida: ["Vencida", "vencido"], proxima: ["Vence pronto", "riesgo"], a_tiempo: ["A tiempo", "normal"],
      sin_fecha: ["Sin fecha", ""], completa: ["Finalizada", ""] };
    const sel = "#tableMetasTareas";
    if (dtRegistry[sel]) { try { dtRegistry[sel].destroy(); } catch (e) {} delete dtRegistry[sel]; }
    const tbody = document.querySelector(sel + " tbody");
    if (tbody) tbody.innerHTML = tareas.map(function (t) {
      const sit = situacionTarea(t), s = SIT[sit];
      const d = diasHasta(t.vencimiento);
      const vence = t.vencimiento ? esc(t.vencimiento) + (t.grupo !== "completo" && d !== null ? '<span class="progress-text">' + (d < 0 ? "hace " + (-d) + " días" : d === 0 ? "hoy" : "en " + d + " días") + '</span>' : '') : '—';
      const pill = s[1] ? '<span class="status-pill status-pill--' + s[1] + '">' + s[0] + '</span>' : '<span class="area-chip">' + s[0] + '</span>';
      const orden = (t.grupo === "completo" ? "1" : "0") + (t.vencimiento || "9999-12-31");
      return '<tr class="' + (sit === "vencida" ? "row--vencido" : "") + (t.subtareas_total ? " meta-row--subs" : "") + '" data-tarea="' + esc(t.id) + '">' +
        '<td><strong>' + esc(t.nombre) + '</strong>' + (t.descripcion ? '<span class="progress-text">' + esc(t.descripcion) + '</span>' : '') + '</td>' +
        '<td>' + esc(t.proyecto) + '</td><td>' + esc(t.estado) + '</td>' +
        '<td data-order="' + (PRIORIDAD_ORDEN[t.prioridad] !== undefined ? PRIORIDAD_ORDEN[t.prioridad] : 9) + '">' + esc(t.prioridad) + '</td>' +
        '<td data-order="' + orden + '">' + vence + '</td><td>' + pill + '</td>' +
        '<td>' + esc(t.asignados.join(", ") || "Sin asignar") + '</td>' +
        '<td data-order="' + t.progreso + '">' + (t.subtareas_total ? progressCellHTML(t.progreso, "normal").replace('%</div>', '% · ' + t.subtareas_listas + '/' + t.subtareas_total + '</div>') +
          '<span class="subs-toggle"><i class="bi bi-chevron-down"></i> Ver sub tareas</span>' : '<span class="area-chip">Sin sub tareas</span>') + '</td>' +
        '<td>' + (t.url ? '<a href="' + esc(t.url) + '" target="_blank" rel="noopener" title="Abrir en Notion"><i class="bi bi-box-arrow-up-right"></i></a>' : '') + '</td></tr>';
    }).join("");
    dtRegistry[sel] = $(sel).DataTable({ language: DT_LANG_ES, paging: true, pageLength: 15, order: [[4, "asc"]], dom: "frtipB", buttons: DT_BUTTONS,
      columnDefs: [{ targets: 8, orderable: false }] });
    // Clic en una tarea con sub tareas: despliega la lista (nombre, estado y fecha).
    $(sel + " tbody").off("click.subs").on("click.subs", "tr.meta-row--subs", function (e) {
      if ($(e.target).closest("a").length) return;  // el enlace a Notion no despliega
      const fila = dtRegistry[sel].row(this), id = this.getAttribute("data-tarea");
      if (fila.child.isShown()) { fila.child.hide(); this.classList.remove("is-open"); return; }
      fila.child(subtareasHTML(id), "meta-subs-row").show(); this.classList.add("is-open");
    });
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
    // Sin anchos calculados por DataTables: los calcula mal si la tabla se dibuja en una
    // pestaña oculta (Gestión → Responsables/Grupos). El navegador reparte según contenido.
    if (window.jQuery && jQuery.fn.dataTable) jQuery.extend(jQuery.fn.dataTable.defaults, { autoWidth: false });
    wireNav(); wireGestionTabs(); wireSidebarMobile(); wireRefreshButton(); wireGlobalSearch();
    loadAllData(true).then(function () {
      abrirDesdeHash();
      window.addEventListener("hashchange", abrirDesdeHash);
      setInterval(function () { loadAllData(false); }, CONFIG.refreshIntervalMs);
    });
  });

})();
