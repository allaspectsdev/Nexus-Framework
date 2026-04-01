// Nexus Dashboard — Vanilla JS, SSE-powered, no build step

const $ = (sel) => document.querySelector(sel)
const tokenHistory = { claude: [], local: [], cached: [] }
const MAX_HISTORY = 60
let canvas, ctx

// Agent timeline state
const agentStates = new Map()

// Query state
let currentMode = 'single'
let isQuerying = false
let currentResponseEl = null
let currentResponseText = ''
let currentThinkingText = ''
let currentAbortController = null
let messageCounter = 0

// --- Formatters ---

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

// --- Metrics Updates ---

function updateMetrics(data) {
  const { metrics: m, savings: s } = data

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

// --- Token Chart ---

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

  ctx.fillStyle = '#6b6b80'
  ctx.font = '10px monospace'
  ctx.fillText(formatTokens(maxVal), 4, 14)
}

// --- Event Log ---

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

// --- Dashboard SSE Connection (metrics) ---

let reconnectDelay = 1000

function connectMetrics() {
  const evtSource = new EventSource('/events')

  evtSource.onopen = () => {
    $('#status').classList.remove('disconnected')
    reconnectDelay = 1000
  }

  evtSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)

      if (data.type === 'snapshot') {
        updateMetrics(data)
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
    setTimeout(connectMetrics, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 1.5, 10000)
  }
}

// --- Query Submission & Streaming ---

function appendUserMessage(text) {
  const welcome = document.querySelector('.welcome-message')
  if (welcome) welcome.remove()

  const msg = document.createElement('div')
  msg.className = 'message user'
  const content = document.createElement('div')
  content.className = 'message-content'
  content.textContent = text
  msg.appendChild(content)
  $('#chat-messages').appendChild(msg)
  scrollToBottom()
}

function createAssistantMessage() {
  const msg = document.createElement('div')
  msg.className = 'message assistant'
  msg.id = `msg-${++messageCounter}`

  const responseDiv = document.createElement('div')
  responseDiv.className = 'response-content'
  responseDiv.id = `response-${messageCounter}`
  msg.appendChild(responseDiv)

  $('#chat-messages').appendChild(msg)
  currentResponseEl = responseDiv
  currentResponseText = ''
  currentThinkingText = ''
  return msg
}

function scrollToBottom() {
  const el = $('#chat-messages')
  const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  if (isNearBottom) {
    el.scrollTop = el.scrollHeight
  }
}

function setQueryingState(querying) {
  isQuerying = querying
  const btn = $('#submit-btn')
  const input = $('#query-input')
  if (querying) {
    btn.textContent = 'Cancel'
    btn.classList.add('cancel')
    input.disabled = true
  } else {
    btn.textContent = 'Send'
    btn.classList.remove('cancel')
    input.disabled = false
    input.focus()
  }
}

async function submitQuery() {
  const input = $('#query-input')
  const query = input.value.trim()
  if (!query || isQuerying) return

  input.value = ''
  appendUserMessage(query)
  const assistantMsg = createAssistantMessage()
  setQueryingState(true)

  currentAbortController = new AbortController()

  try {
    const response = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, mode: currentMode }),
      signal: currentAbortController.signal,
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Request failed' }))
      showError(assistantMsg, err.error || `HTTP ${response.status}`)
      setQueryingState(false)
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() || ''

      for (const part of parts) {
        const line = part.trim()
        if (!line.startsWith('data: ')) continue
        try {
          const event = JSON.parse(line.slice(6))
          handleStreamEvent(event, assistantMsg)
        } catch {}
      }
    }

    // Process any remaining buffer
    if (buffer.trim().startsWith('data: ')) {
      try {
        const event = JSON.parse(buffer.trim().slice(6))
        handleStreamEvent(event, assistantMsg)
      } catch {}
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      showError(assistantMsg, err.message)
    }
  } finally {
    // Remove streaming cursor
    const cursor = assistantMsg.querySelector('.streaming-cursor')
    if (cursor) cursor.remove()
    setQueryingState(false)
    currentAbortController = null
  }
}

function handleStreamEvent(event, assistantMsg) {
  switch (event.type) {
    case 'text_delta': {
      currentResponseText += event.text
      // Re-render markdown (marked escapes HTML by default — safe)
      if (currentResponseEl && typeof marked !== 'undefined') {
        currentResponseEl.innerHTML = marked.parse(currentResponseText)
        // Add streaming cursor
        let cursor = currentResponseEl.querySelector('.streaming-cursor')
        if (!cursor) {
          cursor = document.createElement('span')
          cursor.className = 'streaming-cursor'
        }
        currentResponseEl.appendChild(cursor)
      }
      scrollToBottom()
      break
    }

    case 'thinking_delta': {
      currentThinkingText += event.thinking
      let thinkingBlock = assistantMsg.querySelector('.thinking-block')
      if (!thinkingBlock) {
        thinkingBlock = document.createElement('details')
        thinkingBlock.className = 'thinking-block'
        const summary = document.createElement('summary')
        summary.textContent = 'Thinking...'
        thinkingBlock.appendChild(summary)
        const content = document.createElement('div')
        content.className = 'thinking-content'
        thinkingBlock.appendChild(content)
        // Insert before the response content
        assistantMsg.insertBefore(thinkingBlock, currentResponseEl)
      }
      thinkingBlock.querySelector('.thinking-content').textContent = currentThinkingText
      scrollToBottom()
      break
    }

    case 'tool_use_start': {
      const details = document.createElement('details')
      details.className = 'tool-call'
      details.id = `tool-${event.id}`
      const summary = document.createElement('summary')
      const nameSpan = document.createElement('span')
      nameSpan.className = 'tool-name'
      nameSpan.textContent = event.name
      const spinner = document.createElement('span')
      spinner.className = 'tool-spinner'
      spinner.textContent = ' running...'
      const preview = document.createElement('span')
      preview.className = 'tool-preview'
      summary.appendChild(nameSpan)
      summary.appendChild(spinner)
      summary.appendChild(preview)
      details.appendChild(summary)
      // Insert before the response div
      assistantMsg.insertBefore(details, currentResponseEl)
      scrollToBottom()
      break
    }

    case 'tool_use_input_delta': {
      const toolEl = assistantMsg.querySelector(`#tool-${event.id}`)
      if (toolEl) {
        const preview = toolEl.querySelector('.tool-preview')
        if (preview) preview.textContent = event.input
      }
      break
    }

    case 'tool_use_complete': {
      const toolEl = assistantMsg.querySelector(`#tool-${event.id}`)
      if (toolEl) {
        const spinner = toolEl.querySelector('.tool-spinner')
        if (spinner) spinner.remove()
        const preview = toolEl.querySelector('.tool-preview')
        if (preview) {
          preview.textContent = JSON.stringify(event.input).slice(0, 80)
        }
        // Add body with full input
        const body = document.createElement('div')
        body.className = 'tool-body'
        body.textContent = JSON.stringify(event.input, null, 2)
        toolEl.appendChild(body)
      }
      break
    }

    case 'agent_event': {
      const div = document.createElement('div')
      div.className = 'agent-event-inline'
      const nameSpan = document.createElement('span')
      nameSpan.className = 'agent-event-name'
      if (event.event === 'worker_spawned' && event.data) {
        nameSpan.textContent = event.data.name
        div.appendChild(nameSpan)
        div.appendChild(document.createTextNode(` spawned — ${event.data.purpose}`))
      } else if (event.event === 'worker_completed' && event.data) {
        nameSpan.textContent = event.data.name
        div.appendChild(nameSpan)
        div.appendChild(document.createTextNode(` completed`))
      } else if (event.event === 'coordinator_started') {
        div.textContent = 'Coordinator started — decomposing task...'
      } else if (event.event === 'coordinator_completed' && event.data) {
        div.textContent = `Coordinator synthesizing ${event.data.workerCount} worker results`
      } else {
        div.textContent = `${event.event}: ${JSON.stringify(event.data || '').slice(0, 60)}`
      }
      assistantMsg.insertBefore(div, currentResponseEl)
      scrollToBottom()
      break
    }

    case 'done': {
      // Final render — remove cursor
      if (currentResponseEl && typeof marked !== 'undefined' && currentResponseText) {
        currentResponseEl.innerHTML = marked.parse(currentResponseText)
      }
      const cursor = assistantMsg.querySelector('.streaming-cursor')
      if (cursor) cursor.remove()
      scrollToBottom()
      break
    }

    case 'error': {
      showError(assistantMsg, event.message)
      break
    }
  }
}

function showError(assistantMsg, message) {
  const errDiv = document.createElement('div')
  errDiv.style.cssText = 'color: var(--error); padding: 8px 0; font-size: 12px;'
  errDiv.textContent = 'Error: ' + message
  assistantMsg.appendChild(errDiv)
  scrollToBottom()
}

// --- Canvas ---

function initCanvas() {
  canvas = $('#token-chart')
  if (!canvas) return
  requestAnimationFrame(() => {
    const dpr = window.devicePixelRatio || 1
    const w = canvas.offsetWidth || 400
    const h = canvas.offsetHeight || 200
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    drawChart()
  })
}

let resizeTimer
function debouncedInitCanvas() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(initCanvas, 150)
}

// --- Init ---

window.addEventListener('DOMContentLoaded', () => {
  initCanvas()
  connectMetrics()

  window.addEventListener('resize', debouncedInitCanvas)

  // Update running agent durations
  setInterval(() => {
    let hasRunning = false
    for (const [, agent] of agentStates) {
      if (agent.status === 'running') { hasRunning = true; break }
    }
    if (hasRunning) renderTimeline()
  }, 1000)

  // Mode toggle
  $('#mode-single').addEventListener('click', () => {
    currentMode = 'single'
    $('#mode-single').classList.add('active')
    $('#mode-multi').classList.remove('active')
  })
  $('#mode-multi').addEventListener('click', () => {
    currentMode = 'multi'
    $('#mode-multi').classList.add('active')
    $('#mode-single').classList.remove('active')
  })

  // Query form
  $('#query-form').addEventListener('submit', (e) => {
    e.preventDefault()
    if (isQuerying) {
      // Cancel in-flight query
      currentAbortController?.abort()
      return
    }
    submitQuery()
  })

  // Ctrl/Cmd+Enter to submit
  $('#query-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if (isQuerying) {
        currentAbortController?.abort()
      } else {
        submitQuery()
      }
    }
  })
})
