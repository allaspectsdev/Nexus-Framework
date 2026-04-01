// Nexus Dashboard — Vanilla JS, SSE-powered, no build step

const $ = (sel) => document.querySelector(sel)
const tokenHistory = { claude: [], local: [], cached: [] }
const MAX_HISTORY = 60
let canvas, ctx

// Agent timeline state
const agentStates = new Map() // agentId -> { name, status, startedAt, durationMs }

function formatTokens(n) {
  if (n < 1000) return String(n)
  if (n < 100000) return (n / 1000).toFixed(1) + 'K'
  return Math.round(n / 1000) + 'K'
}

function formatCost(n) {
  if (n < 0.01) return '$' + n.toFixed(4)
  if (n < 1) return '$' + n.toFixed(3)
  return '$' + n.toFixed(2)
}

function formatDuration(ms) {
  if (ms < 1000) return Math.round(ms) + 'ms'
  return (ms / 1000).toFixed(1) + 's'
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000) % 60
  const m = Math.floor(ms / 60000) % 60
  const h = Math.floor(ms / 3600000)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function updateMetrics(data) {
  const { metrics: m, savings: s } = data

  // Update uptime display
  if (data.uptime) {
    $('#uptime').textContent = formatUptime(data.uptime)
  }

  // Savings panel
  $('#savings-pct').textContent = s.percentSaved.toFixed(0) + '%'
  $('#savings-cost').textContent = formatCost(s.costSaved) + ' saved'
  $('#savings-tokens').textContent = formatTokens(s.tokensSaved) + ' tokens recovered'

  // Agents
  $('#agents-active').textContent = Math.max(0, m.agents.spawned - m.agents.completed - m.agents.failed)
  $('#agents-completed').textContent = m.agents.completed
  $('#agents-failed').textContent = m.agents.failed

  // Tools
  $('#tools-total').textContent = m.tools.executions
  $('#tools-parallel').textContent = m.tools.concurrent
  $('#tools-errors').textContent = m.tools.errors

  // Context decay
  $('#decay-actions').textContent = m.context.decayActions
  $('#decay-tokens').textContent = formatTokens(m.context.tokensSaved)
  $('#decay-compactions').textContent = m.context.compactions

  // Routing bar
  const routeTotal = m.routing.localDecisions + m.routing.claudeDecisions
  if (routeTotal > 0) {
    const localPct = (m.routing.localDecisions / routeTotal) * 100
    $('#routing-local').style.width = localPct + '%'
    $('#routing-claude').style.width = (100 - localPct) + '%'
    $('#routing-local-pct').textContent = localPct.toFixed(0) + '% local'
    $('#routing-claude-pct').textContent = (100 - localPct).toFixed(0) + '% claude'
  }

  // Token chart data point
  tokenHistory.claude.push(m.claude.inputTokens + m.claude.outputTokens)
  tokenHistory.local.push(m.local.inputTokens + m.local.outputTokens)
  tokenHistory.cached.push(m.claude.cachedTokens)
  if (tokenHistory.claude.length > MAX_HISTORY) {
    tokenHistory.claude.shift()
    tokenHistory.local.shift()
    tokenHistory.cached.shift()
  }

  drawChart()
}

function drawChart() {
  if (!canvas || !ctx) return
  const w = canvas.width
  const h = canvas.height

  ctx.clearRect(0, 0, w, h)

  const allValues = [...tokenHistory.claude, ...tokenHistory.local, ...tokenHistory.cached]
  const maxVal = Math.max(1, ...allValues)

  const drawLine = (data, color) => {
    if (data.length < 2) return
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.beginPath()
    data.forEach((val, i) => {
      const x = (i / (MAX_HISTORY - 1)) * w
      const y = h - (val / maxVal) * (h - 20)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }

  // Grid lines
  ctx.strokeStyle = '#1e1e2e'
  ctx.lineWidth = 1
  for (let i = 0; i < 5; i++) {
    const y = (i / 4) * (h - 20) + 10
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
  }

  drawLine(tokenHistory.claude, '#d97706')
  drawLine(tokenHistory.local, '#059669')
  drawLine(tokenHistory.cached, '#2563eb')

  // Y-axis label
  ctx.fillStyle = '#6b6b80'
  ctx.font = '10px monospace'
  ctx.fillText(formatTokens(maxVal), 4, 14)
}

function addEventLog(event, timestamp) {
  const log = $('#event-log')
  const el = document.createElement('div')
  el.className = 'event'

  const time = new Date(timestamp).toLocaleTimeString()
  let detail = ''

  switch (event.type) {
    case 'token_usage':
      detail = `${event.provider}: ${formatTokens(event.inputTokens)} in / ${formatTokens(event.outputTokens)} out`
      break
    case 'routing_decision':
      detail = `-> ${event.provider}: ${event.reason}`
      break
    case 'agent_lifecycle':
      detail = `${event.name}: ${event.status}${event.durationMs ? ' (' + formatDuration(event.durationMs) + ')' : ''}`
      break
    case 'tool_execution':
      detail = `${event.tool}: ${formatDuration(event.durationMs)}${event.concurrent ? ' [parallel]' : ''}${event.isError ? ' [ERROR]' : ''}`
      break
    case 'context_decay':
      detail = `${event.tier}: ${formatTokens(event.tokensSaved)} tokens saved`
      break
    default:
      detail = JSON.stringify(event).slice(0, 100)
  }

  const timeSpan = document.createElement('span')
  timeSpan.className = 'time'
  timeSpan.textContent = time
  const typeSpan = document.createElement('span')
  typeSpan.className = 'type'
  typeSpan.textContent = event.type
  const detailSpan = document.createElement('span')
  detailSpan.className = 'detail'
  detailSpan.textContent = detail
  el.appendChild(timeSpan)
  el.appendChild(typeSpan)
  el.appendChild(detailSpan)
  log.insertBefore(el, log.firstChild)

  // Keep log manageable
  while (log.children.length > 100) log.removeChild(log.lastChild)
}

// --- Agent Timeline ---

function updateAgentTimeline(event) {
  if (event.type !== 'agent_lifecycle') return

  const id = event.agentId
  let agent = agentStates.get(id)
  if (!agent) {
    agent = { name: event.name, status: event.status, startedAt: Date.now(), durationMs: 0 }
    agentStates.set(id, agent)
  }
  agent.status = event.status
  if (event.durationMs) agent.durationMs = event.durationMs

  renderTimeline()
}

function renderTimeline() {
  const timeline = $('#agent-timeline')
  timeline.innerHTML = ''

  for (const [, agent] of agentStates) {
    const entry = document.createElement('div')
    entry.className = 'agent-entry'

    const dot = document.createElement('span')
    dot.className = `agent-dot ${agent.status}`

    const nameEl = document.createElement('span')
    nameEl.className = 'agent-name'
    nameEl.textContent = agent.name

    const statusEl = document.createElement('span')
    statusEl.className = 'agent-status'
    const duration = agent.durationMs ? ` (${formatDuration(agent.durationMs)})` : agent.status === 'running' ? ` (${formatDuration(Date.now() - agent.startedAt)})` : ''
    statusEl.textContent = agent.status + duration

    entry.appendChild(dot)
    entry.appendChild(nameEl)
    entry.appendChild(statusEl)
    timeline.appendChild(entry)
  }
}

// --- SSE Connection ---

let reconnectDelay = 1000

function connect() {
  const evtSource = new EventSource('/events')

  evtSource.onopen = () => {
    $('#status').classList.remove('disconnected')
    reconnectDelay = 1000 // Reset backoff on successful connect
  }

  evtSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)

      if (data.type === 'snapshot') {
        updateMetrics(data)
        // Load recent events and rebuild agent timeline
        for (const evt of data.recentEvents || []) {
          addEventLog(evt, evt.timestamp)
          updateAgentTimeline(evt)
        }
      } else if (data.type === 'event') {
        updateMetrics(data)
        addEventLog(data.event, data.timestamp)
        updateAgentTimeline(data.event)
      }
    } catch {}
  }

  evtSource.onerror = () => {
    $('#status').classList.add('disconnected')
    evtSource.close()
    // Exponential backoff with cap at 10s
    setTimeout(connect, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 1.5, 10000)
  }
}

// --- Init ---

function initCanvas() {
  canvas = $('#token-chart')
  requestAnimationFrame(() => {
    const dpr = window.devicePixelRatio || 1
    const w = canvas.offsetWidth || 400
    const h = canvas.offsetHeight || 200
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    drawChart() // Draw immediately after init
  })
}

let resizeTimer
function debouncedInitCanvas() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(initCanvas, 150)
}

window.addEventListener('DOMContentLoaded', () => {
  initCanvas()
  connect()

  // Debounced resize handler prevents torn frames during drag
  window.addEventListener('resize', debouncedInitCanvas)

  // Update running agent durations every second
  setInterval(() => {
    let hasRunning = false
    for (const [, agent] of agentStates) {
      if (agent.status === 'running') { hasRunning = true; break }
    }
    if (hasRunning) renderTimeline()
  }, 1000)
})
