const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const csvLines = fs.readFileSync(path.join(root, '全部站点.csv'), 'utf8').trim().split(/\r?\n/);
const context = { document: { getElementById: function () { return null; } } };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'stops_data.js'), 'utf8'), context);

assert(Array.isArray(context.ALL_STOPS), '浏览器站点数据库必须生成ALL_STOPS数组');
assert.strictEqual(context.ALL_STOPS.length, csvLines.length - 1, '内置数据库必须与新版全部站点.csv逐条一致');
assert(context.ALL_STOPS.some(function (stop) { return /\(公交站\)$/.test(stop.n); }), '数据库必须包含原侧公交站');
assert(context.ALL_STOPS.some(function (stop) { return /\(对侧\)$/.test(stop.n); }), '数据库必须包含对侧公交站');
vm.runInContext(fs.readFileSync(path.join(root, 'js/app-state.js'), 'utf8'), context);
assert.strictEqual(context.allStopsData.length, csvLines.length - 1, '应用运行时必须使用当前全部站点.csv中的全部站点数据');
assert(context.boardingStopSideIndex['安得物流'].regular.length > 0, '实际数据库必须建立原侧索引');
assert(context.boardingStopSideIndex['安得物流'].opposite.length > 0, '实际数据库必须建立对侧索引');

console.log(JSON.stringify({ stops: context.ALL_STOPS.length }));
