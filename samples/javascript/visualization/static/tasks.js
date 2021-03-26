
const processTasks = (tasks) => {
    const rows = d3.select('#tasks')
        .selectAll('.task')
        .data(tasks, function(d) { return d.name; });

    const topFn = (d, i) => 17 * i + 'px';
    const nameFn = (d) => Math.floor(d.avg / 1000) + 's : ' + d.name;

    rows
        .enter()
        .append('div')
        .attr('class', 'task')
        .style('left', () => '-1000px')
        .style('top', topFn)
        .on('click', function() { window.open(d3.select(this).datum().link, '_blank') })
        .text(nameFn)
        .transition()
        .style('left', '0px');

    rows
        .exit()
        .remove();

    rows
        .text(nameFn)
        .transition()
        .style('left', '0px')
        .style('top', topFn)
};

const fetchAndProcessTasks = () => {
    d3.json("/tasks").then(processTasks);
    setTimeout(fetchAndProcessTasks, 2000);
};

fetchAndProcessTasks();
d3.json("/name").then(n => d3.select('.ge-main-menu__title .name').text(n[0]));