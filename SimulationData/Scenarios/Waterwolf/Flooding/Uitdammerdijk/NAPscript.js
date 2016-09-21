var fs = require('fs');
var path = require('path');

var baseGrid = [];
var header = '';
var scenarioFolder = '.';

function run() {
	var files = fs.readdirSync(scenarioFolder);
	files.forEach(function(f){
		var ext = path.extname(f);
		var file = path.join(scenarioFolder, f);
		if (ext !== '.asc') return;
		if (path.basename(f, ext) === '-1') {
			createBaseHeightMap(file);
			return;
		} else {
			normalizeData(file);
		}
	});
}

function createBaseHeightMap(file) {
	fs.readFile(file, 'utf8', function (err, data) {
		if (err) {
		   console.log('Error reading file');
			return;
		}
		var lines = data.split('\n');
		var splitCellsRegex = new RegExp("[^\ ]+", "g");
		lines.forEach(function(l) {
			if (l.length > 4 && l.length < 100) {
				header += l + '\n';
				return;
			}
			var cells = l.match(splitCellsRegex);
			if (!cells) return;
			var numbers = cells.map(function(val, ind) { return +val; });
			baseGrid.push(numbers);
		})
	});
	var result = [];
	baseGrid.forEach((line) => {
		result.push(line.join(' '));
	});
	fs.writeFileSync('debug.log', header + result.join('\n'));
}

function normalizeData(file) {
	var grid = [];
	fs.readFile(file, 'utf8', function (err, data) {
		if (err) {
		   console.log('Error reading file');
			return;
		}
		var lines = data.split('\n');
		var splitCellsRegex = new RegExp("[^\ ]+", "g");
		var c = 0;
		lines.forEach((l) => {
			if (l.length > 4 && l.length < 100) {
				return;
			}
			var cells = l.match(splitCellsRegex);
			if (!cells) return;
			console.log(cells);
			var numbers = cells.map(function(val, ind) { return ((baseGrid[c][ind] !== -9999) ? +val - baseGrid[c][ind] : -9999); });
			numbers = numbers.map(function(val, ind) { return (Math.abs(val) < 2000 ? val : -9999); });
			grid.push(numbers);
			c += 1;
		});
		var result = [];
		grid.forEach((line) => {
			result.push(line.join(' '));
		});
		fs.writeFileSync(file, header + result.join('\n'));
	});
}

run();

	