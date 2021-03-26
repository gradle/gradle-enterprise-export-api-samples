var path = require('path');
const express = require('express');

// The address of your Gradle Enterprise server
const GRADLE_ENTERPRISE_SERVER_URL = process.argv.slice(2);

// Authorization credentials
const AUTH_TOKEN = Buffer.from(process.env.ACCESS_TOKEN).toString('base64');

// Number of samples for Exponential moving average
const NUMBER_OF_SAMPLES = 10;

// The point in time from which builds should be processed.
// Values can be 'now', or a number of milliseconds since the UNIX epoch.
// The time is the point in time when the build was published to the server.
const PROCESS_FROM = 'now';

// How many builds to process at one time.
// If running with very fast network connection to the server,
// this number can be increased for better throughput.
const MAX_CONCURRENT_BUILDS_TO_PROCESS = 6;

const app = express();
const port = 3000;
const tasks = [];
let clients = [];

// Setup static folder
app.use(express.static(__dirname + "/static/"));

// rendering html file.
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname + '/index.html'));
})

// The server name
app.get('/name', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(GRADLE_ENTERPRISE_SERVER_URL);
});

// Tasks handler.
app.get('/tasks', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify([...tasks].sort((a, b) => b.avg - a.avg).slice(0, 50)));
})

// We'll send builds to the front end as sse
app.get('/builds', (req, res) => {
    const headers = {
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache'
    };
    res.writeHead(200, headers);
    res.write('retry: 5000\n\n');

    let interValID = setInterval(() => {
        res.write(':heartbeat\n\n');
    }, 10000);

    // Generate an id based on timestamp and save res
    // object of client connection on clients list
    // Later we'll iterate it and send updates to each client
    const clientId = Date.now();
    const newClient = {
        id: clientId,
        res
    };
    clients.push(newClient);
    // When client closes connection we update the clients list
    // avoiding the disconnected one
    req.on('close', () => {
        clients = clients.filter(c => c.id !== clientId);
    });
});

app.listen(port, () => console.log(`Example app listening on port ${port}!`))

const buildProcessor = require('./processor');
const handlers = require('./common-handlers');

const updateTasks = (data) => {
    if (!data.cachingDisabledReasonCategory) {
        return;
    }
    const item = tasks.find((s) => s.name === data.path);
    if (item) {
        let newAvg = item.avg - (item.avg / NUMBER_OF_SAMPLES);
        newAvg += data.duration / NUMBER_OF_SAMPLES;
        item.avg = newAvg;
        item.link = `${GRADLE_ENTERPRISE_SERVER_URL}/s/${data.buildId}/timeline?task-path=${data.path}`;
    } else {
        tasks.push({
            name: data.path,
            avg: data.duration,
            link: `${GRADLE_ENTERPRISE_SERVER_URL}/s/${data.buildId}/timeline?task-path=${data.path}`
        });
    }
}

const updateBuilds = (data) => {
    const now = new Date().getMilliseconds();
    const build = {
        id: data.buildId,
        link: `${GRADLE_ENTERPRISE_SERVER_URL}/s/${data.buildId}`,
        success: data.success,
        startTime: data.startTime,
        endTime: data.endTime,
    };

    clients.forEach(c => c.res.write(`event: build\ndata: ${JSON.stringify(build)}\n\n`));
}

const trigger = (data) => {
    if (data.type === 'task') {
        updateTasks(data);
    } else {
        updateBuilds(data);
    }
}

buildProcessor.start(
    GRADLE_ENTERPRISE_SERVER_URL,
    AUTH_TOKEN,
    MAX_CONCURRENT_BUILDS_TO_PROCESS,
    PROCESS_FROM,
    handlers.handlers(trigger)
);