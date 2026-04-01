// Nexus Dashboard — Vanilla JS, SSE-powered, no build step

const $ = (sel) => document.querySelector(sel)
const tokenHistory = { claude: [], local: [], cached: [] }
const MAX_HISTORY = 60
let canvas, ctx

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

function updateMetrics(data) {
  const { metrics: m, savings: s } = data

  // Savings panel
  $('#savings-pct').textContent = s.percentSaved.toFixed(0) + '%'
  $('#savings-cost').textContent = formatCost(s.costSaved) + ' saved'
  $('#savings-tokens').textContent = formatTokens(s.tokensSaved) + ' tokens recovered'

  // Agents
  $('#agents-active').textContent = m.agents.spawned - m.agents.completed - m.agents.failed
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

  el.innerHTML = `<span class="time">${time}</span><span class="type">${event.type}</span><span class="detail">${detail}</span>`
  log.insertBefore(el, log.firstChild)

  // Keep log manageable
  while (log.children.length > 100) log.removeChild(log.lastChild)
}

// --- SSE Connection ---

function connect() {
  const evtSource = new EventSource('/events')

  evtSource.onopen = () => {
    $('#status').classList.remove('disconnected')
  }

  evtSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)

      if (data.type === 'snapshot') {
        updateMetrics(data)
        // Load recent events
        for (const evt of data.recentEvents || []) {
          addEventLog(evt, evt.timestamp)
        }
      } else if (data.type === 'event') {
        updateMetrics(data)
        addEventLog(data.event, data.timestamp)
      }
    } catch {}
  }

  evtSource.onerror = () => {
    $('#status').classList.add('disconnected')
    evtSource.close()
    // Reconnect after 3s
    setTimeout(connect, 3000)
  }
}

// --- Init ---

window.addEventListener('DOMContentLoaded', () => {
  canvas = $('#token-chart')
  // Set canvas resolution for retina
  const dpr = window.devicePixelRatio || 1
  canvas.width = canvas.offsetWidth * dpr
  canvas.height = canvas.offsetHeight * dpr
  ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)

  connect()

  // Update uptime
  setInterval(() => {
    // uptime is handled server-side via metrics
  }, 1000)
})
