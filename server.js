const WebSocket = require("ws")
const express = require("express")

const app = express()
const PORT = 3000

//in-memory store
let buses = {}

//connect to Passio WebSocket
const ws = new WebSocket("wss://passio3.com/")

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000 //meters
    const toRad = (deg) => deg * Math.PI / 180

    const dLat = toRad(lat2 - lat1)
    const dLon = toRad(lon2 - lon1)

    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2)
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))

    return R * c
}

ws.on("open", () => {
    console.log("Connected to Passio WebSocket")

    //subscribe to Lehigh system (1090)
    const subscription = {
        subscribe: "location",
        userId: [1090],
        filter: {
            outOfService: 0
        },
        field: [
            "busId",
            "latitude",
            "longitude",
            "course",
            "paxLoad"
        ]
    }
    ws.send(JSON.stringify(subscription))
})

ws.on("message", (data) => {
    try {
        const parsed = JSON.parse(data.toString())

        if(parsed.busId && parsed.latitude && parsed.longitude) {
            const existing = buses[parsed.busId]
            let speed = 0
            let reliability = "HIGH"

            if(existing) {
                const timeDiff = (Date.now() - existing.timestamp) / 1000 //seconds

                if(timeDiff < 1) {
                    return
                }

                const distance = haversine(
                    existing.latitude,
                    existing.longitude,
                    parsed.latitude,
                    parsed.longitude
                )

                speed = distance/timeDiff //meters per second

                //if unrealistic jump (>35 m/s)
                if(speed > 35) {
                    console.log("GPS jump detected for bus", parsed.busId)
                    return //ignore bad data
                }
                if(timeDiff > 30) {
                    reliability = "LOW"
                }
            }
            buses[parsed.busId] = {
                latitude: parsed.latitude,
                longitude: parsed.longitude,
                course: parsed.course,
                paxLoad: parsed.paxLoad,
                speed: speed,
                reliability: reliability,
                timestamp: Date.now()
            }
            console.log(
                `Bus ${parsed.busId} | Speed: ${speed.toFixed(2)} m/s | ${reliability}`
            )
        }
        
    } catch (err) {
        //some messages may not be JSON
    }
})

//simple API endpoint
app.get("/buses", (req, res) => {
    res.json(buses)
})

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
})