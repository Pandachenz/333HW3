const CONFIG = {
  endpoint: 'https://data.cityofchicago.org/resource/ijzp-q8t2.json',
  fields: ['primary_type','date','latitude','longitude'],
};

const state = {
  raw: [],
  filtered: [],
  timeRange: null,
  selectedTypes: new Set(),
  latLngBounds: null,
  topN: 15,
  timeGranularity: 'monthly',
  dataLimit: 50000,
};

const el = {
  reloadBtn: document.getElementById('reloadBtn'),
  resetBtn: document.getElementById('resetBtn'),
  stats: document.getElementById('stats'),
  timeChart: document.getElementById('timeChart'),
  typeChart: document.getElementById('typeChart'),
  scatter: document.getElementById('scatterCanvas'),
  topNSelect: document.getElementById('topNSelect'),
  timeGranularitySelect: document.getElementById('timeGranularitySelect'),
  dataLimitSlider: document.getElementById('dataLimitSlider'),
  dataLimitValue: document.getElementById('dataLimitValue'),
  dataTable: document.getElementById('dataTable'),
};

async function loadData() {
  const params = new URLSearchParams();
  params.set('$select', CONFIG.fields.join(','));
  params.set('$order', 'date DESC');
  params.set('$limit', String(state.dataLimit));
  const res = await fetch(`${CONFIG.endpoint}?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.map(d => ({
    primaryType: d.primary_type,
    date: d.date ? new Date(d.date) : null,
    latitude: d.latitude != null ? +d.latitude : null,
    longitude: d.longitude != null ? +d.longitude : null,
  })).filter(d => d.date && Number.isFinite(d.latitude) && Number.isFinite(d.longitude));
}

function applyFilters() {
  const inTime = (d) => !state.timeRange || (d.date >= state.timeRange[0] && d.date <= state.timeRange[1]);
  const inTypes = (d) => !state.selectedTypes.size || state.selectedTypes.has(d.primaryType);
  const inBounds = (d) => {
    if (!state.latLngBounds) return true;
    const [[minLng, minLat],[maxLng, maxLat]] = state.latLngBounds;
    return d.longitude >= minLng && d.longitude <= maxLng && d.latitude >= minLat && d.latitude <= maxLat;
  };
  state.filtered = state.raw.filter(d => inTime(d) && inTypes(d) && inBounds(d));
  el.stats.textContent = `Filtered: ${state.filtered.length.toLocaleString()} / ${state.raw.length.toLocaleString()}`;
}

function renderTimeHistogram() {
  const container = d3.select(el.timeChart);
  container.selectAll('*').remove();
  const width = el.timeChart.clientWidth;
  const height = el.timeChart.clientHeight;
  const margin = { top: 20, right: 20, bottom: 40, left: 40 };
  const svg = container.append('svg').attr('width', width).attr('height', height);
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  const dates = state.filtered.map(d => d.date);
  const x = d3.scaleTime().domain(d3.extent(state.raw, d => d.date)).range([0, innerW]).nice();
  
  let thresholds, tickFormat, tickCount;
  switch (state.timeGranularity) {
    case 'weekly':
      thresholds = x.ticks(d3.timeWeek.every(1));
      tickFormat = d3.timeFormat('%b %d');
      tickCount = 8;
      break;
    case 'yearly':
      thresholds = x.ticks(d3.timeYear.every(1));
      tickFormat = d3.timeFormat('%Y');
      tickCount = 6;
      break;
    case 'monthly':
    default:
      thresholds = x.ticks(d3.timeMonth.every(1));
      tickFormat = d3.timeFormat('%b %y');
      tickCount = 6;
      break;
  }
  
  const bins = d3.bin().value(d => d).domain(x.domain()).thresholds(thresholds)(dates);
  const y = d3.scaleLinear().domain([0, d3.max(bins, b => b.length) || 1]).range([innerH, 0]).nice();

  g.append('g').attr('class','axis').attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(tickCount).tickFormat(tickFormat));
  g.append('g').attr('class','axis').call(d3.axisLeft(y).ticks(5));

  g.selectAll('.bar').data(bins).join('rect')
    .attr('class','bar')
    .attr('x', d => x(d.x0))
    .attr('y', d => y(d.length))
    .attr('width', d => Math.max(1, x(d.x1) - x(d.x0) - 1))
    .attr('height', d => innerH - y(d.length));

  const brush = d3.brushX().extent([[0,0],[innerW, innerH]]).on('end', ({selection}) => {
    if (!selection) state.timeRange = null;
    else {
      const [x0, x1] = selection.map(x.invert);
      state.timeRange = [x0, x1];
    }
    applyFilters();
    renderTypeBar();
    renderScatter();
    renderTable();
  });
  g.append('g').attr('class','brush').call(brush);
  if (state.timeRange) {
    const [a,b] = state.timeRange.map(x);
    g.select('.brush').call(brush.move, [a,b]);
  }
}

function renderTypeBar() {
  const container = d3.select(el.typeChart);
  container.selectAll('*').remove();
  const width = el.typeChart.clientWidth;
  const height = el.typeChart.clientHeight;
  const margin = { top: 10, right: 10, bottom: 40, left: 120 };
  const svg = container.append('svg').attr('width', width).attr('height', height);
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  const counts = d3.rollups(state.filtered, v => v.length, d => d.primaryType)
    .sort((a,b) => d3.descending(a[1], b[1]))
    .slice(0, state.topN);

  const y = d3.scaleBand().domain(counts.map(d => d[0])).range([0, innerH]).padding(0.2);
  const x = d3.scaleLinear().domain([0, d3.max(counts, d => d[1]) || 1]).range([0, innerW]).nice();

  g.append('g').attr('class','axis').call(d3.axisLeft(y));
  g.append('g').attr('class','axis').attr('transform', `translate(0,${innerH})`).call(d3.axisBottom(x).ticks(5));

  g.selectAll('rect').data(counts).join('rect')
    .attr('class', d => state.selectedTypes.has(d[0]) ? 'bar selected' : 'bar')
    .attr('y', d => y(d[0]))
    .attr('x', 0)
    .attr('height', y.bandwidth())
    .attr('width', d => x(d[1]))
    .style('cursor', 'pointer')
    .on('click', (_, d) => {
      const type = d[0];
      if (state.selectedTypes.has(type)) state.selectedTypes.delete(type);
      else state.selectedTypes.add(type);
      applyFilters();
      renderAll();
    });
}

function renderScatter() {
  const canvas = el.scatter;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const margin = { top: 20, right: 20, bottom: 40, left: 50 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  ctx.clearRect(0,0,width,height);
  const x = d3.scaleLinear().domain(d3.extent(state.raw, d => d.longitude)).nice().range([margin.left, margin.left + innerW]);
  const y = d3.scaleLinear().domain(d3.extent(state.raw, d => d.latitude)).nice().range([margin.top + innerH, margin.top]);

  const panel = canvas.parentElement;
  d3.select(panel).selectAll('svg').remove();
  const panelRect = panel.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const offsetTop = canvasRect.top - panelRect.top;
  const offsetLeft = canvasRect.left - panelRect.left;
  
  const axisSvg = d3.select(panel).append('svg')
    .attr('width', width).attr('height', height)
    .style('position','absolute')
    .style('left', offsetLeft + 'px')
    .style('top', offsetTop + 'px')
    .style('pointer-events','none');
  axisSvg.append('g').attr('class','axis')
    .attr('transform', `translate(0,${margin.top + innerH})`)
    .call(d3.axisBottom(x).ticks(5));
  axisSvg.append('g').attr('class','axis')
    .attr('transform', `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(5));

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  for (const d of state.filtered) {
    const px = x(d.longitude);
    const py = y(d.latitude);
    if (px < margin.left || px > margin.left + innerW || py < margin.top || py > margin.top + innerH) continue;
    ctx.beginPath();
    ctx.arc(px, py, 1, 0, Math.PI * 2);
    ctx.fill();
  }

  if (!canvas._brushHandlers) {
    const brushState = { brushing: false, start: null, rect: null };
    const onMouseDown = (e) => {
      const r = canvas.getBoundingClientRect();
      brushState.start = { x: e.clientX - r.left, y: e.clientY - r.top };
      brushState.brushing = true;
    };
    const onMouseMove = (e) => {
      if (!brushState.brushing) return;
      const r = canvas.getBoundingClientRect();
      const curr = { x: e.clientX - r.left, y: e.clientY - r.top };
      brushState.rect = { 
        x: Math.min(brushState.start.x, curr.x), 
        y: Math.min(brushState.start.y, curr.y), 
        w: Math.abs(curr.x - brushState.start.x), 
        h: Math.abs(curr.y - brushState.start.y) 
      };
      renderScatter();
    };
    const onMouseUp = () => {
      if (brushState.rect && brushState.rect.w > 2 && brushState.rect.h > 2) {
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const m = { top: 20, right: 20, bottom: 40, left: 50 };
        const innerW = width - m.left - m.right;
        const innerH = height - m.top - m.bottom;
        const xScale = d3.scaleLinear().domain(d3.extent(state.raw, d => d.longitude)).nice().range([m.left, m.left + innerW]);
        const yScale = d3.scaleLinear().domain(d3.extent(state.raw, d => d.latitude)).nice().range([m.top + innerH, m.top]);
        
        const x0 = brushState.rect.x, x1 = brushState.rect.x + brushState.rect.w;
        const y0 = brushState.rect.y, y1 = brushState.rect.y + brushState.rect.h;
        const minLng = xScale.invert(Math.min(x0, x1));
        const maxLng = xScale.invert(Math.max(x0, x1));
        const maxLat = yScale.invert(Math.min(y0, y1));
        const minLat = yScale.invert(Math.max(y0, y1));
        state.latLngBounds = [[minLng, minLat], [maxLng, maxLat]];
      } else {
        state.latLngBounds = null;
      }
      brushState.brushing = false; 
      brushState.start = null; 
      brushState.rect = null;
      applyFilters();
      renderAll();
    };
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove, { passive: true });
    canvas.addEventListener('mouseup', onMouseUp);
    canvas._brushHandlers = { onMouseDown, onMouseMove, onMouseUp };
    canvas._brushState = brushState;
  }
  
  const brushState = canvas._brushState;
  if (brushState && brushState.rect) {
    ctx.strokeStyle = '#4a9eff';
    ctx.fillStyle = 'rgba(74, 158, 255, 0.2)';
    ctx.fillRect(brushState.rect.x, brushState.rect.y, brushState.rect.w, brushState.rect.h);
    ctx.strokeRect(brushState.rect.x, brushState.rect.y, brushState.rect.w, brushState.rect.h);
  }
}

function renderTable() {
  const container = el.dataTable;
  if (!container) return;
  
  container.innerHTML = '';
  
  if (state.filtered.length === 0) {
    container.innerHTML = '<p style="color: #999; padding: 20px; text-align: center;">No data to display</p>';
    return;
  }
  
  const previewData = state.filtered.slice(0, 10);
  const table = document.createElement('table');
  table.className = 'preview-table';
  
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th class="col-date">Date</th>
      <th class="col-type">Type</th>
      <th class="col-coords">Latitude Longitude</th>
    </tr>
  `;
  table.appendChild(thead);
  
  const tbody = document.createElement('tbody');
  previewData.forEach((d) => {
    const row = document.createElement('tr');
    let dateStr = 'N/A';
    if (d.date) {
      const year = d.date.getFullYear();
      const month = String(d.date.getMonth() + 1).padStart(2, '0');
      const day = String(d.date.getDate()).padStart(2, '0');
      dateStr = `${year}-${month}-${day}`;
    }
    const lat = d.latitude != null ? d.latitude.toFixed(4) : 'N/A';
    const lng = d.longitude != null ? d.longitude.toFixed(4) : 'N/A';
    const coords = lat !== 'N/A' && lng !== 'N/A' ? `${lat} ${lng}` : 'N/A';
    row.innerHTML = `
      <td class="col-date">${dateStr}</td>
      <td class="col-type">${d.primaryType || 'N/A'}</td>
      <td class="col-coords">${coords}</td>
    `;
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  
  container.appendChild(table);
}

function renderAll() {
  renderTimeHistogram();
  renderTypeBar();
  renderScatter();
  renderTable();
}

el.reloadBtn.addEventListener('click', async () => {
  el.stats.textContent = 'Loading...';
  try {
    state.raw = await loadData();
    state.timeRange = null;
    state.selectedTypes.clear();
    state.latLngBounds = null;
    applyFilters();
    renderAll();
  } catch (e) {
    el.stats.textContent = 'Load failed: ' + String(e);
  }
});

el.resetBtn.addEventListener('click', () => {
  state.timeRange = null;
  state.selectedTypes.clear();
  state.latLngBounds = null;
  applyFilters();
  renderAll();
});

if (el.topNSelect) {
  state.topN = parseInt(el.topNSelect.value, 10);
  
  el.topNSelect.addEventListener('change', (e) => {
    state.topN = parseInt(e.target.value, 10);
    renderTypeBar();
  });
}

if (el.timeGranularitySelect) {
  state.timeGranularity = el.timeGranularitySelect.value;
  
  el.timeGranularitySelect.addEventListener('change', (e) => {
    state.timeGranularity = e.target.value;
    renderTimeHistogram();
  });
}

if (el.dataLimitSlider && el.dataLimitValue) {
  const updateSliderValue = (value) => {
    state.dataLimit = parseInt(value, 10);
    el.dataLimitValue.textContent = state.dataLimit.toLocaleString();
  };
  
  el.dataLimitSlider.addEventListener('input', (e) => {
    updateSliderValue(e.target.value);
  });
  
  el.dataLimitSlider.addEventListener('change', (e) => {
    updateSliderValue(e.target.value);
    el.reloadBtn.click();
  });
  
  updateSliderValue(el.dataLimitSlider.value);
}

el.reloadBtn.click();
