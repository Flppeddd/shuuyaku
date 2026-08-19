const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
global.window = global;
global.ALL_STOPS = [];
global.document = { getElementById: function () { return null; } };
global.XLSX = { utils: { sheet_to_json: function (sheet) { return sheet; } } };

function load(relativePath) {
  const file = path.join(root, relativePath);
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}

load('js/app-state.js');
load('js/services/routing-service.js');
load('js/domain/route-planner.js');
load('js/io/route-excel.js');

const workbook = {
  SheetNames: ['线路1'],
  Sheets: {
    '线路1': [
      ['线路编号', '线路1'],
      ['终点', '银湖工厂'],
      [],
      ['顺序', '上车点', '上车点经度', '上车点纬度', '道路途经经度', '道路途经纬度', '站点所在道路', '道路偏移(m)', '道路双向经过', '本点人数', '覆盖站点数'],
      [1, '测试站', 118.31, 31.31, 118.3101, 31.3101, '测试路', 12, '是', 10, 2],
      [2, '银湖工厂(终点)', 118.373875, 31.417475, 118.373875, 31.417475, '', 0, '是', 0, 0]
    ]
  }
};

const plan = parseRouteWorkbook(workbook);
assert.strictEqual(plan.routes.length, 1);
assert.strictEqual(plan.routes[0].stops[0].roadName, '测试路');
assert.strictEqual(plan.routes[0].stops[0].roadSnapM, 12);
console.log(JSON.stringify({ routes: plan.routes.length, roadName: plan.routes[0].stops[0].roadName }));
