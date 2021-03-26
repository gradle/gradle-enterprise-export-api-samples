exports.handlers = (trigger) => [
    class BuildHandler {
        constructor(build) {
            this.buildId = build.buildId;
            this.cacheableTaskCount = 0;
            this.taskCount = 0;
        }

        onBuildStarted(eventPayload) {
            this.startTime = eventPayload.timestamp;
        }

        onTaskFinished(eventPayload) {
            if (eventPayload.data.cacheable) {
                this.cacheableTaskCount++;
            }
            this.taskCount++;
        }

        onBuildFinished(eventPayload) {
            const endTime = eventPayload.timestamp;
            trigger({
                buildId: this.buildId,
                type: 'build',
                success: eventPayload.data.failureId === null,
                startTime: this.startTime,
                endTime: endTime,
                tasks: this.taskCount,
                cacheableTasks: this.cacheableTaskCount
            });
        }
    },
    class TaskHandler {
        constructor(build) {
            this.buildId = build.buildId;
            this.rootProject = null;
        }

        onProjectStructure(eventPayload) {
            if (this.rootProject === null) {
                this.rootProject = eventPayload.data.rootProjectName;
            }
        }

        onTaskStarted(eventPayload) {
            this.startTime = eventPayload.timestamp;
        }

        onTaskFinished(eventPayload) {
            const endTime = eventPayload.timestamp;
            trigger({
                buildId: this.buildId,
                type: 'task',
                project: this.rootProject,
                path: eventPayload.data.path,
                duration: endTime - this.startTime,
                cachingDisabledReasonCategory: eventPayload.data.cachingDisabledReasonCategory,
                outcome: eventPayload.data.outcome
            });
        }
    }
]