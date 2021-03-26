const Timeseries = ((d3) => {
    const BUILD_CHART_WIDTH = 800;
    const BUILD_CHART_HEIGHT = 800;

    const margin = {top: 20, right: 20, bottom: 50, left: 70},
        width = BUILD_CHART_WIDTH - margin.left - margin.right,
        height = BUILD_CHART_HEIGHT - margin.top - margin.bottom;

    const ONE_HOUR = 600000;

    const svg = d3.select('#viewDiv svg')
        .attr('width', width + margin.left + margin.right)
        .attr('height', height + margin.top + margin.bottom)
        .append('g')
        .attr('transform', `translate(${margin.left}, ${margin.top})`);

    const xScale = d3.scaleTime().domain([Date.now() - ONE_HOUR, Date.now()]).range([0, width]).nice()
    const xAxis = d3.axisBottom(xScale);

    const yScale = d3.scaleLinear().domain([0, 1]).range([height, 0]);
    const yAxis = d3.axisLeft(yScale);

    const xAxisContainer = svg.append("g").attr('transform', `translate(0, ${height})`);
    xAxisContainer.call(xAxis);

    const timeDiffInSeconds = (d) => (d.endTime - d.startTime) / 1000.0;
    const yAxisContainer = svg.append("g");
    yAxisContainer.call(yAxis);

    let data = [];

    const reRender = () => {
        const join = svg.selectAll('.circle')
            .data(data, d => d.id);

        join.attr('cx', d => xScale(d.endTime))
            .attr('cy', d => yScale(timeDiffInSeconds(d)));

        const entered = join.enter()
            .append('circle')
            .classed('circle', true)
            .classed('success', d => d.success)
            .attr('r', 200)
            .style('fill-opacity', 0.0)
            .attr('cx', d => xScale(d.endTime))
            .attr('cy', d => yScale(timeDiffInSeconds(d)))
        entered.append('title')
            .text(d => `${d.link} took ${Math.floor((d.endTime - d.startTime)/100)/10}s`);
        entered.on('click', function() { window.open(d3.select(this).datum().link, '_blank') })
            .transition().duration(1000)
            .style('fill-opacity', 1.0)
            .attr('r', 5)

        join.exit().remove();
    };

    return {
        insert: (build) => {
            data = data.filter(e => e.endTime >= Date.now() - ONE_HOUR).concat([build]);
            yScale.domain([0, d3.max(data, timeDiffInSeconds)]);
            yAxisContainer.call(yAxis);
        },
        heartbeat: () => {
            xScale.domain([Date.now() - ONE_HOUR, Date.now()]);
            xAxisContainer.call(xAxis);
            reRender()
        },
        reRender: reRender
    };
})(d3);

const Percentage = (() => {
    let successes = 0;
    let failures = 0;

    const data = () => successes / (successes + failures);
    const format = d3.format('.1%');
    const display = d3.select('#bigtext').property("_current", 0);
    const clamper = d3.scaleLinear().range([0,1]).clamp(true);

    return {
        heartbeat: () => {
            const d = display
                .datum(data())
                .transition()
                .duration(1000)
                .textTween(function (d) {
                    const i = d3.interpolate(this._current, d);
                    return function (t) {
                        const i1 = clamper(i(t));
                        if (isNaN(i1)) {
                            return '--'
                        }
                        this._current = i1
                        return format(i1);
                    };
                });
        },
        insert: (success) => {
            if (success) {
                successes++;
            } else {
                failures++;
            }
        }
    }
})();

setInterval(() => {
    Timeseries.heartbeat();
    Percentage.heartbeat();
}, 1000);

const evtSource = new EventSource("/builds");
evtSource.addEventListener("build", function (event) {
    const parsed = JSON.parse(event.data);
    Percentage.insert(parsed.success);
    Timeseries.insert(parsed);
});
