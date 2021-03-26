const EventSourcePolyfill = require('eventsource');

// Code below is a generic utility for interacting with the Export API.
class BuildProcessor {
    constructor(gradleEnterpriseServerUrl, token, maxConcurrentBuildsToProcess, eventHandlerClasses) {
        this.gradleEnterpriseServerUrl = gradleEnterpriseServerUrl;
        this.eventHandlerClasses = eventHandlerClasses;
        this.allHandledEventTypes = this.getAllHandledEventTypes();
        this.token = token;
        this.pendingBuilds = [];
        this.buildsInProcessCount = 0;
        this.maxConcurrentBuildsToProcess = maxConcurrentBuildsToProcess;
        this.baseUrl = `${this.gradleEnterpriseServerUrl}/build-export/v1`
    }

    start(startTime) {
        const buildStreamUrl = this.createBuildStreamUrl(startTime);

        createServerSideEventStream(buildStreamUrl, this.token, {
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

        createServerSideEventStream(buildEventStreamUrl, this.token, {
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
function createServerSideEventStream(url, token, configuration) {
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
        stream = new EventSourcePolyfill(url, { headers: {'Authorization': `Bearer ${token}`}});

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

exports.start = (url, accessToken, concurrentBuilds, from, handlers) => {
    new BuildProcessor(
        url,
        accessToken,
        concurrentBuilds,
        handlers
    ).start(from);
}
