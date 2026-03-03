/**
 * Lehigh Transit Enhancer - Backend Server
 * 
 * Engineering features:
 * - Sliding-window rate limiter (per-client IP)
 * - Bounded in-memory message queue with back-pressure
 * - Statistical Z-score anomlay detection (beyond naive speed cap)
 * - Exponential-backoff WebSocket reconnection
 * - Per-bus GPS trail (circular buffer, last 20 positions)
 * - Prometheus-style /metrics endpoint(throughput, latency, accuracy)
 * - Server-Sent Events /stream for push updates(eliminates polling)
 */

const WebSocket = require("ws")
const express = require("express")
const cors = require("cors")

const app = express()
app.use(cors())
app.use(express.static(__dirname));
app.use(express.json())
const PORT = process.env.PORT || 3000

//--------- CONSTANTS ------------------------------------------------
const MAX_SPEED_MS = 35             //hard cap ~78mph
const MAX_QUEUE_SIZE = 500          //back-pressure limit
const TRAIL_LENGTH = 20             //GPS breadcrumb history per bus
const RATE_LIMIT_WINDOW = 60_000    //1-minute sliding window (ms)
const RATE_LIMIT_MAX = 120          //max requests per window per IP
const STALE_BUS_TTL = 5 * 60_000
const Z_SCORE_WINDOW = 10           //samples for z-score baseline
const Z_SCORE_THRESHOLD = 3.0

//--------- In-Memory Store ------------------------------------------
const buses = {}
const busTrails = {}
const speedHistory = {}

//--------- Metrics --------------------------------------------------
const metrics = {
    messagesReceived:   0,
    messagesProcessed:  0,
    messagesRejected:   0,
    gpsJumpsFiltered:   0,
    zScoreFiltered:     0,
    queueDropped:       0,
    apiRequests:        0,
    sseClients:         0,
    processingLatencies:[],
    startTime:          Date.now(),
    reconnects:         0,
}

/**
 * Records message processing latency
 * Maintains rolling buffer of last 1000 samples
 * 
 * @param {number} ms - Processing time in milliseconds
 * @return {void}
 */
function recordLatency(ms) {
    metrics.processingLatencies.push(ms)
    if(metrics.processingLatencies.length > 1000) metrics.processingLatencies.shift()
}

/**
 * Computes percentile value from sorted numeric array
 * 
 * @param {number[]} sorted - Sorted numeric array
 * @param {number} p - Percentile (0-100)
 * @returns {number} Percentile valur or 0 if empty
 */
function percentile(sorted, p) {
    if(!sorted.length) return 0
    return sorted[Math.max(0, Math.ceil((p/100) * sorted.length) - 1)]
} 

//--------- Message Queue (back-pressure) -----------------------------
const messageQueue = []
let queueProcessing = false

/**
 * Adds a raw WebSocket message to processing queue
 * Applies back-pressure if queue exceeds limit
 * 
 * @param {Buffer|string} raw - Raw WebSocket payload
 * @returns {void}
 */
function enqueue(raw) {
    if (messageQueue.length >= MAX_QUEUE_SIZE) {
        metrics.queueDropped++
        return
    }
    messageQueue.push({raw, receivedAt: Date.now()})
    if(!queueProcessing) 
        drainQueue()
}

/**
 * Drains message queue sequentially
 * Ensures ordered, single-threaded processing
 */
async function drainQueue() {
    queueProcessing = true
    while (messageQueue.length > 0) {
        await processMessage(messageQueue.shift())
    }
    queueProcessing = false
}

//--------- Haversine -----------------------------------------------------
/**
 * Compute geodesic distance between two coordinates
 * 
 * @param {number} lat1 - Latitude of first point
 * @param {number} lon1 - Longitude of first point
 * @param {number} lat2 - Latitude of second point
 * @param {number} lon2 - Longitude of second point
 * @returns {number} Distance in meters
 */
function haversine(lat1, lon1, lat2, lon2) {
    const R = 6_371_000, toRad = d => d * Math.PI/180
    const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1)
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2
    return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

//--------- Z-score Anomaly Detection -------------------------------------
/**
 * Determines whether a speed reading is statiscally anomalous
 * 
 * Uses rolling mean + standard deviation
 * 
 * @param {string} busId - Unique bus identifier
 * @param {number} speed - Current speed in m/s
 * @returns {boolean} True if anomalous
 */
function isSpeedAnomalous(busId, speed) {
    const hist = speedHistory[busId] || []
    if (hist.length < Z_SCORE_WINDOW) return false
    const mean = hist.reduce((a, b) => a+b, 0) / hist.length
    const std = Math.sqrt(hist.reduce((s,v) => s+(v-mean)**2, 0) / hist.length)
    if(std < 0.1) return false
    return Math.abs((speed - mean) / std) > Z_SCORE_THRESHOLD 
}

/**
 * Updates rolling speed history for a buse
 * 
 * @param {string} busId
 * @param {number} speedHistory
 * @returns {void}
 */
function updateSpeedHistory(busId, speed){
    if(!speedHistory[busId]) speedHistory[busId] = []
    speedHistory[busId].push(speed)
    if(speedHistory[busId].length > Z_SCORE_WINDOW * 3) speedHistory[busId].shift
}

//--------- GPS Trail (circular buffer) -----------------------------------
/**
 * Appends GPS coordinate to circular trail buffer
 * 
 * @param {string} busId
 * @param {number} lat
 * @param {number} lon
 * @param {number} ts - Timestamp (ms)
 */
function appendTrail(busId, lat, lon, ts){
    if (!busTrails[busId]) busTrails[busId] = []
    busTrails[busId].push({lat, lon, ts})
    if (busTrails[busId].length > TRAIL_LENGTH) busTrails[busId].shift()
}

//--------- Core Processor -----------------------------------------------
/**
 * Core message processor
 * 
 * Pipeline: 
 * 1. Parse JSON
 * 2. Validate payload
 * 3. Compute speed (Haversine)
 * 4. Apply hard speed cap
 * 5. Apply Z-score anomaly detection
 * 6. Update in-memory store
 * 7. Broadcast via SSE
 * 
 * @param {{ raw: Buffer|string, receivedAt: number }} param0
 * @returns {Promise<void>}
 */
async function processMessage({raw, receivedAt}) {
    metrics.messagesReceived++
    const start = Date.now()

    let parsed
    try { 
        parsed = JSON.parse(raw.toString())
    } catch {
        metrics.messagesRejected++
        return
    }

    if(!parsed.busId || parsed.latitude == null || parsed.longitude == null) {
        metrics.messagesRejected++
        return
    }

    const existing = buses[parsed.busId]
    let speed = 0, reliability = "HIGH"

    if(existing) {
        const timeDiff = (Date.now() - existing.timestamp) / 1000
        if (timeDiff < 1) return

        const dist = haversine(existing.latitude, existing.longitude, parsed.latitude, parsed.longitude)
        speed = dist/timeDiff

        if (speed > MAX_SPEED_MS) {
            metrics.gpsJumpsFiltered++
            metrics.messagesRejected++
            return
        }
        if (isSpeedAnomalous(parsed.busId, speed)) {
            metrics.zScoreFiltered++
            metrics.messagesRejected++
            return
        }
        if (timeDiff > 60)
            reliability = "STALE"
        else if (timeDiff > 30) 
            reliability = "LOW"
    }

    updateSpeedHistory(parsed.busId, speed)
    appendTrail(parsed.busId, parsed.latitude, parsed.longitude, Date.now())

    buses[parsed.busId] = {
        latitude:   parsed.latitude,
        longitude:  parsed.longitude,
        course:     parsed.course ?? 0,
        paxLoad:    parsed.paxLoad ?? null,
        speed:      parseFloat(speed.toFixed(3)),
        speedKmh:   parseFloat((speed*3.6).toFixed(2)),
        reliability,
        timestamp:  Date.now(),
        trail:      busTrails[parsed.busId],
    }

    metrics.messagesProcessed++
    recordLatency(Date.now() - start)
    broadcastSSE({busId: parsed.busId, ...buses[parsed.busId]})
}

//--------- Stale cleanup -------------------------------------------------
setInterval(() => {
    const cutoff = Date.now() - STALE_BUS_TTL
    for (const id of Object.keys(buses)) {
        if(buses[id].timestamp < cutoff) {
            delete buses[id]
            delete busTrails[id]
            delete speedHistory[id]
        }
    }
}, 30_000)

//--------- WebSocket with exponential backoff ----------------------------
let ws, reconnectDelay = 1000
const MAX_RECONNECT_DELAY = 30_000
const SUBSCRIPTION = JSON.stringify({
    subscribe: "location", userId: [1090],
    filter: {outOfService: 0},
    field: ["busId", "latitude", "longitude", "course", "paxLoad"],
})

/**
 * Establishes upstream WebSocket connection with exponential backoff
 * reconnect strategy
 * 
 * Backoff doubles each failure up to MAX_RECONNECT_DELAY
 * 
 * @returns {void}
 */
function connectWebSocket() {
    console.log(`[WS] Conneting (backoff: ${reconnectDelay}ms)...`)
    ws = new WebSocket("wss://passio3.com/")
    ws.on("open", () => {
        console.log("[WS] Connected")
        reconnectDelay = 1000
        ws.send(SUBSCRIPTION)
    })
    ws.on("message", (data) => enqueue(data))
    ws.on("close", (code) => {
        console.warn(`[WS] Closed (${code}). Reconnecting in ${reconnectDelay}ms...`)
        metrics.reconnects++
        setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
            connectWebSocket()
        }, reconnectDelay)
    })
    ws.on("error", (err) => {
        console.error("[WS]", err.message)
        ws.terminate()
    })
}

connectWebSocket()

//--------- Sliding-window rate limiter -----------------------------------
const rateLimitMap = new Map()
/**
 * Express middleware implementing sliding-window rate limiting
 * 
 * Limits per-IP API requests within RATE_LIMIT_WINDOW
 * 
 * Adds headers: 
 *  - X-RateLimit-Limit
 *  - X-RateLimit-Remaining
 * 
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
function rateLimiter(req, res, next) {
    const ip = req.ip || "unknown"
    const now = Date.now()
    if(!rateLimitMap.has(ip)) rateLimitMap.set(ip, [])
    const hits = rateLimitMap.get(ip).filter(t => now - t < RATE_LIMIT_WINDOW)
    hits.push(now)
    rateLimitMap.set(ip, hits)
    res.setHeader("X-RateLimit-Limit",      RATE_LIMIT_MAX)
    res.setHeader("X-RateLimit-Remaining", Math.max(0, RATE_LIMIT_MAX - hits.length))
    if(hits.length > RATE_LIMIT_MAX) {
        return res.status(429).json({error: "Rate limit exceeded", retryAfter: 60})
    }
    metrics.apiRequests++
    next()
}

setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW
    for(const[ip, hits] of rateLimitMap.entries()) {
        const fresh = hits.filter(t => t > cutoff)
        fresh.length === 0 ? rateLimitMap.delete(ip) : rateLimitMap.set(ip, fresh)
    }
}, 5*60_000)

//--------- SSE ------------------------------------------------------------
const sseClients = new Set()
/**
 * Broadcasts data payload to all connected SSE cleints
 * 
 * @param {Object} data - Bus update payload
 * @returns {void}
 */
function broadcastSSE(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`
    for (const client of sseClients) {
        try {
            client.write(payload)
        } catch {
            sseClients.delete(client)
        }
    }
}

app.get("/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")
    res.flushHeaders()
    sseClients.add(res)
    metrics.sseClients = sseClients.size
    for (const [busId, bus] of Object.entries(buses)) {
        res.write(`data: ${JSON.stringify({busId, ...bus})}\n\n`)
    }
    req.on("close", () => {
        sseClients.delete(res)
        metrics.sseClients = sseClients.size
    })
})

//--------- REST API ------------------------------------------------------
app.use(rateLimiter)

app.get("/buses", (req, res) => res.json(buses))
app.get("/buses/:id", (req, res) => {
    const bus = buses[req.params.id]
    if(!bus) {
        return res.status(404).json({error: "Bus not found"})
    }
    res.json({busId: req.params.id, ...bus})
})
app.get("/buses/:id/trail", (req, res) => {
    const trail = busTrails[req.params.id]
    if (!trail) {
        return res.status(404).json({error: "No trail data"})
    }
    res.json({busId: req.params.id, trail})
})
app.get("/metrics", (req, res) => {
    const sorted = [...metrics.processingLatencies].sort((a,b) => a-b)
    const uptime = ((Date.now() - metrics.startTime)/1000).toFixed(0)
    res.json({
        uptime_seconds:         parseInt(uptime),
        messages_received:      metrics.messagesReceived,
        messages_processed:     metrics.messagesProcessed,
        messages_rejected:      metrics.messagesRejected,
        gps_jump_filtered:      metrics.gpsJumpsFiltered,
        zscore_filtered:        metrics.queueDropped,
        data_accuracy_pct:      metrics.messagesReceived > 0
                                ? parseFloat(((metrics.messagesProcessed / metrics.messagesReceived) * 100).toFixed(2)) : 100,
        active_buses:           Object.keys(buses).length,
        api_requests_total:     metrics.apiRequests,
        sse_clients_active:     metrics.sseClients,
        ws_reconnects:          metrics.reconnects,
        queue_depth:            messageQueue.length,
        latency_p50_ms:         percentile(sorted, 50),
        latency_p95_ms:         percentile(sorted, 95),
        latency_p99_ms:         percentile(sorted, 99),
        throughput_msg_per_sec: uptime > 0 ? parseFloat((metrics.messagesProcessed / uptime).toFixed(2)) : 0,
    })
})

app.get("/health", (req, res) => res.json({
    status: "ok",
    wsConnected: ws?.readyState === WebSocket.OPEN,
    activeBuses: Object.keys(buses).length,
    queueDepth: messageQueue.length,
}))

app.listen(PORT, () => {
    console.log(`\n🚍  Lehigh Transit Enahance -> http://localhost:${PORT}`)
    console.log(`   /buses      live bus data`)
    console.log(`   /metrics    system metrics(throughput, latency, accuracy)`)
    console.log(`   /stream     SSE push feed`)
    console.log(`   /health     health check\n`)
})