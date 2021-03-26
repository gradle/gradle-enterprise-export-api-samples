const EventSourcePolyfill = require('eventsource');

// The address of your Gradle Enterprise server
const GRADLE_ENTERPRISE_SERVER_URL = process.argv.slice(2);

// Authorization credentials
const EXPORT_API_USER = process.env.EXPORT_API_USER;
const EXPORT_API_PASSWORD = process.env.EXPORT_API_PASSWORD;
const BASIC_AUTH_TOKEN = Buffer.from(`${EXPORT_API_USER}:${EXPORT_API_PASSWORD}`).toString('base64')

// The point in time from which builds should be processed.
// Values can be 'now', or a number of milliseconds since the UNIX epoch.
// The time is the point in time when the build was published to the server.
const PROCESS_FROM = 'now';

// How many builds to process at one time.
// If running with very fast network connection to the server,
// this number can be increased for better throughput.
const MAX_CONCURRENT_BUILDS_TO_PROCESS = 6;

// A build event handler that calculates and logs the build duration.
//
// Each "on" method is an event handler that receives each instance of that type of event.
// Please see https://docs.gradle.com/enterprise/export-api for more information about the event types.
//
// After all events have been received, the "complete()" method will be called if it exists.
class BuildDurationEventHandler {
    constructor(build) {
        this.buildId = build.buildId;
    }

    onBuildStarted(eventPayload) {
        this.startTime = eventPayload.timestamp;
    }

    onBuildFinished(eventPayload) {
        const endTime = eventPayload.timestamp;
        console.log(`Build ${GRADLE_ENTERPRISE_SERVER_URL}/s/${this.buildId} completed in ${endTime - this.startTime}ms`);
    }
}

// A build event handler that counts how many tasks of the build were cacheable.
class CacheableTaskCountHandler {
    constructor(build) {
        this.buildId = build.buildId;
        this.cacheableTaskCount = 0;
    }

    onTaskFinished(eventPayload) {
        if (eventPayload.data.cacheable) {
            this.cacheableTaskCount++;
        }
    }

    complete() {
        console.log(`Build ${GRADLE_ENTERPRISE_SERVER_URL}/s/${this.buildId} had ${this.cacheableTaskCount} cacheable tasks`)
    }
}

// The event handlers to use to process builds.
const BUILD_EVENT_HANDLERS = [BuildDurationEventHandler, CacheableTaskCountHandler];

// Code below is a generic utility for interacting with the Export API.
class BuildProcessor {
    constructor(gradleEnterpriseServerUrl, maxConcurrentBuildsToProcess, eventHandlerClasses) {
        this.gradleEnterpriseServerUrl = gradleEnterpriseServerUrl;
        this.eventHandlerClasses = eventHandlerClasses;
        this.allHandledEventTypes = this.getAllHandledEventTypes();

        this.pendingBuilds = [];
        this.buildsInProcessCount = 0;
        this.maxConcurrentBuildsToProcess = maxConcurrentBuildsToProcess;
        this.baseUrl = `${this.gradleEnterpriseServerUrl}/build-export/v1`
    }

    start(startTime) {
        const buildStreamUrl = this.createBuildStreamUrl(startTime);

        createServerSideEventStream(buildStreamUrl, {
            onopen: () => console.log(`Build stream '${buildStreamUrl}' open`),
            onerror: event => console.error('Build stream error', event),
            eventListeners: [
                {
                    eventName: 'Build',
                    eventHandler:event => { this.enqueue(JSON.parse(event.data)); }
                }
            ],
            retry: {
                interval: 6000,
                maxRetries: 30
            }
        });
    }

    enqueue(build) {
        this.pendingBuilds.push(build);
        this.processPendingBuilds();
    }

    processPendingBuilds() {
        if (this.pendingBuilds.length > 0 && this.buildsInProcessCount < this.maxConcurrentBuildsToProcess) {
            this.processBuild(this.pendingBuilds.shift());
        }
    }

    createBuildStreamUrl(startTime) {
        return `${this.baseUrl}/builds/since/${startTime}?stream`;
    }

    // Inspect the methods on the handler class to find any event handlers that start with 'on' followed by the event type like 'onBuildStarted'.
    // Then take the part of the method name after the 'on' to get the event type.
    getHandledEventTypesForHandlerClass(eventHandlerClass) {
        return Object.getOwnPropertyNames(eventHandlerClass.prototype)
            .filter(methodName => methodName.startsWith('on'))
            .map(methodName => methodName.substring(2));
    }

    getAllHandledEventTypes() {
        return new Set(this.eventHandlerClasses.reduce((eventTypes, eventHandlerClass) => eventTypes.concat(this.getHandledEventTypesForHandlerClass(eventHandlerClass
        )), []));
    }

    createBuildEventStreamUrl(buildId) {
        const types = [...this.allHandledEventTypes].join(',');
        return `${this.baseUrl}/build/${buildId}/events?eventTypes=${types}`;
    }

    // Creates a map of event type -> handler instance for each event type supported by one or more handlers.
    createBuildEventHandlers(build) {
        return this.eventHandlerClasses.reduce((eventHandlers, eventHandlerClass) => {
            const addHandler = (eventType, eventHandler) => eventHandlers[eventType] ? eventHandlers[eventType].push(eventHandler) : eventHandlers[eventType] = [eventHandler];

            const eventHandler = new eventHandlerClass.prototype.constructor(build);

            this.getHandledEventTypesForHandlerClass(eventHandlerClass).forEach(eventType => addHandler(eventType, eventHandler));

            if (Object.getOwnPropertyNames(eventHandlerClass.prototype).includes('complete')) {
                addHandler('complete', eventHandler);
            }

            return eventHandlers;
        }, {});
    }

    processBuild(build) {
        this.buildsInProcessCount++;
        const buildEventHandlers = this.createBuildEventHandlers(build);
        const buildEventStreamUrl = this.createBuildEventStreamUrl(build.buildId);

        createServerSideEventStream(buildEventStreamUrl, {
            oncomplete:  () => {
                this.finishProcessingBuild();

                // Call the 'complete()' method on any handler that has it.
                if (buildEventHandlers.complete) {
                    buildEventHandlers.complete.forEach(handler => handler.complete());
                }
            },
            eventListeners: [
                {
                    eventName: 'BuildEvent',
                    eventHandler:event => {
                        const buildEventPayload = JSON.parse(event.data);
                        const { eventType } = buildEventPayload.type;

                        if (this.allHandledEventTypes.has(eventType)) {
                            buildEventHandlers[eventType].forEach(handler => handler[`on${eventType}`](buildEventPayload));
                        }
                    }
                }
            ],
            retry: {
                interval: 2000,
                maxRetries: 100
            }
        });
    }

    finishProcessingBuild() {
        this.buildsInProcessCount--;
        setTimeout(() => this.processPendingBuilds(), 0); // process the next set of pending builds, if any
    }
}

// Code below is a wrapper of EventSourcePolyfill to provide an oncomplete callback, retry interval and max retries configuration.
function createServerSideEventStream(url, configuration) {
    const STATUS_COMPLETE = 204;

    let stream;
    let retries;

    const noop = () => {}
    const _onopen = configuration.onopen || noop;
    const _onerror = configuration.onerror || noop;
    const _oncomplete = configuration.oncomplete || noop;
    const _configurationRetry = configuration.retry || { }
    const _maxRetries = _configurationRetry.maxRetries || 3;
    const _reconnectInterval = _configurationRetry.interval || 1000;

    stream = createStream()

    function createStream() {
        stream = new EventSourcePolyfill(url, { headers: {'Authorization': `Basic ${BASIC_AUTH_TOKEN}`}});

        stream.reconnectInterval = _reconnectInterval;

        stream.onopen = (event) => {
            retries = 0;
            _onopen(event)
        }

        stream.onerror = (event) => {
            // The server will send a 204 status code when the stream has finished sending events.
            // The browser default EventSource implementation handles this use case as an error.
            // We therefore map this from the error to the oncomplete callback for improved usage.
            if(event.status === STATUS_COMPLETE) {
                _oncomplete()
                return
            }

            // On all other errors, except the above handled complete event, the EventSourcePolyfill tries to reconnect
            // to the server until it succeeds. To not do this indefinitely, we abort the reconnection loop if the specified _maxRetries limit is reached.
            if(stream.readyState === EventSourcePolyfill.CONNECTING) {
                if(_maxRetries > 0 && retries < _maxRetries) {
                    // on failed events we get two errors, one with a proper
                    // status and an undefined one, ignore the undefined to increase retry count correctly
                    if(event.status != null) retries++;
                } else {
                    stream.close()
                    console.log(`Connecting to ${url} ERROR: max retries reached ${_maxRetries}`);
                }
            }

            _onerror(event)
        }

        configuration.eventListeners.forEach(eventListener => {
            stream.addEventListener(eventListener.eventName, eventListener.eventHandler)
        })

        return stream
    }
}

new BuildProcessor(
    GRADLE_ENTERPRISE_SERVER_URL,
    MAX_CONCURRENT_BUILDS_TO_PROCESS,
    BUILD_EVENT_HANDLERS
).start(PROCESS_FROM);
