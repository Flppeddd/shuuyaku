const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');

const root = path.resolve(__dirname, '..');
global.ALL_STOPS = [];
global.document = { getElementById: function () { return null; } };

function load(relativePath) {
  const file = path.join(root, relativePath);
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}

load('js/app-state.js');
load('js/services/routing-service.js');
load('js/domain/route-planner.js');

boardingStopSideIndex = buildBoardingStopSideIndex([
  { name: '配对站(公交站)', lng: 118.300000, lat: 31.400000 },
  { name: '配对站(对侧)', lng: 118.300300, lat: 31.400000 },
  { name: '配对站(对侧)', lng: 118.310000, lat: 31.410000 }
]);
const pairedCandidate = findOtherSideBoardingStop({
  name: '配对站(公交站)', lng: 118.300000, lat: 31.400000,
  stopLng: 118.300000, stopLat: 31.400000
});
assert(pairedCandidate, '新版站点数据库中的对侧站点必须可被检索');
assert.strictEqual(pairedCandidate.name, '配对站(对侧)');
assert(Math.abs(pairedCandidate.lng - 118.300300) < 1e-9, '重名对侧站点应选择距离当前站点最近的一项');

const sideAnchor = { lng: 118.300000, lat: 31.400000 };
const originalNorth = {
  name: '几何站(公交站)',
  lng: sideAnchor.lng,
  lat: sideAnchor.lat,
  stopLng: sideAnchor.lng,
  stopLat: sideAnchor.lat + 12 / 111320,
  roadLng: sideAnchor.lng,
  roadLat: sideAnchor.lat,
  roadSnapM: 12
};
const sameSideCandidate = normalizeOtherSideBoardingStopCandidate(originalNorth, {
  name: '几何站(对侧)',
  lng: sideAnchor.lng + 4 / (111320 * Math.cos(toRad(sideAnchor.lat))),
  lat: sideAnchor.lat + 18 / 111320,
  side: 'opposite',
  baseName: '几何站'
});
assert.strictEqual(sameSideCandidate.sideGeometryChecked, true, '有可靠道路中心锚点时必须校验对侧几何位置');
assert.strictEqual(sameSideCandidate.sideGeometryCorrected, true, '仍在原站同侧的候选必须自动纠正');
assert(sameSideCandidate.lat < sideAnchor.lat, '纠正后的候选必须越过道路中心线到另一侧');
assert.strictEqual(sameSideCandidate.roadLng, sideAnchor.lng, '对侧候车点纠正后仍应保留道路中心经度');
assert.strictEqual(sameSideCandidate.roadLat, sideAnchor.lat, '对侧候车点纠正后仍应保留道路中心纬度');

const trueOppositeCandidate = normalizeOtherSideBoardingStopCandidate(originalNorth, {
  name: '几何站(对侧)',
  lng: sideAnchor.lng,
  lat: sideAnchor.lat - 14 / 111320,
  side: 'opposite',
  baseName: '几何站'
});
assert.strictEqual(trueOppositeCandidate.sideGeometryChecked, true);
assert.strictEqual(!!trueOppositeCandidate.sideGeometryCorrected, false, '已经跨过道路中心线的候选不得再次翻转');
assert(Math.abs(trueOppositeCandidate.lat - (sideAnchor.lat - 14 / 111320)) < 1e-12, '正确的对侧坐标必须保持不变');
assert.strictEqual(
  preferAlternativeDrivingResult({ dist: 1200, time: 180 }, { dist: 900, time: 130 }),
  true,
  '对侧站点距离更短时必须选择对侧'
);
assert.strictEqual(
  preferAlternativeDrivingResult({ dist: 1000, time: 100 }, { dist: 900, time: 180 }),
  true,
  '即使时间较长，只要对侧驾车距离更短，也应按需求选择对侧'
);
assert.strictEqual(
  preferAlternativeDrivingResult({ dist: 800, time: 100 }, { dist: 1200, time: 160 }),
  false,
  '原站点距离和时间综合更短时必须保留原站点'
);

const laneBaseLng = 118.3;
const laneBaseLat = 31.4;
const metersToLat = 1 / 111320;
const directionlessStop = {
  name: '测试站（东行）',
  lng: laneBaseLng,
  lat: laneBaseLat + 15 * metersToLat,
  stopLng: laneBaseLng,
  stopLat: laneBaseLat + 15 * metersToLat,
  roadLng: laneBaseLng,
  roadLat: laneBaseLat,
  roadName: '测试路（东行）'
};
const oppositeLanePath = [
  [laneBaseLng - 0.001, laneBaseLat - 30 * metersToLat],
  [laneBaseLng + 0.001, laneBaseLat - 30 * metersToLat]
];
const directionlessRoute = { stops: [directionlessStop] };
evaluateRoutePasses(directionlessRoute, oppositeLanePath, [{ roadName: '测试路', path: oppositeLanePath }]);
assert.strictEqual(directionlessStop.passedWithinRadius, true, '同一道路对向车道必须判定为经过');
assert.strictEqual(directionlessStop.passMatchType, 'same-road-opposite-direction');

const sameRoadPriorityStop = Object.assign({}, directionlessStop, {
  lat: laneBaseLat - 30 * metersToLat,
  stopLat: laneBaseLat - 30 * metersToLat,
  roadLat: laneBaseLat - 30 * metersToLat,
  passedWithinRadius: false,
  passMatchType: ''
});
evaluateRoutePasses({ stops: [sameRoadPriorityStop] }, oppositeLanePath, [{ roadName: '测试路', path: oppositeLanePath }]);
assert.strictEqual(sameRoadPriorityStop.passMatchType, 'same-road-opposite-direction', '同时满足近距离和同名道路时必须优先采用同名道路判定');
assert.strictEqual(sameRoadPriorityStop.passedDirectionAgnostic, true, '同名道路优先判定应标记为忽略方向通过');

const otherRoadStop = Object.assign({}, directionlessStop, { passedWithinRadius: false, passMatchType: '' });
evaluateRoutePasses({ stops: [otherRoadStop] }, oppositeLanePath, [{ roadName: '相邻路', path: oppositeLanePath }]);
assert.strictEqual(otherRoadStop.passedWithinRadius, false, '只有同一道路才能启用对向车道扩展判定');

const legacyExcelStop = Object.assign({}, directionlessStop, { roadName: '', roadSnapM: 15, passedWithinRadius: false, passMatchType: '' });
evaluateRoutePasses({ stops: [legacyExcelStop] }, oppositeLanePath, []);
assert.strictEqual(legacyExcelStop.passedWithinRadius, true, '旧版Excel中已保存的道路锚点也必须支持双向经过判定');

const corridorStops = [
  { _aid: 1, roadName: '测试大道（北向）', lng: laneBaseLng, lat: laneBaseLat },
  { _aid: 2, roadName: '测试大道（南向）', lng: laneBaseLng, lat: laneBaseLat + 100 * metersToLat },
  { _aid: 3, roadName: '测试大道', lng: laneBaseLng, lat: laneBaseLat + 200 * metersToLat }
];
const corridorDestination = { roadName: '', lng: laneBaseLng, lat: laneBaseLat + 300 * metersToLat };
const coordOf = function (stop) { return [stop.lng, stop.lat]; };
assert.deepStrictEqual(
  buildDirectionlessRoutingAnchorIndexes(corridorStops, corridorDestination, coordOf),
  [0],
  '同一道路上顺路经过的站点不应继续作为有方向的驾车终点'
);
assert.deepStrictEqual(
  buildDirectionlessRoutingAnchorIndexes(corridorStops, corridorDestination, coordOf, function (index) { return index === 1; }),
  [0, 1],
  '手动调整或覆盖失败的站点必须恢复为驾车节点'
);

const legacyCorridorStops = corridorStops.map(function (stop) {
  return Object.assign({}, stop, { roadName: '' });
});
assert.deepStrictEqual(
  buildDirectionlessRoutingAnchorIndexes(legacyCorridorStops, corridorDestination, coordOf),
  [0],
  '没有道路名称的旧数据也应通过严格的共线几何关系消除掉头'
);

const cornerStops = [
  { lng: laneBaseLng, lat: laneBaseLat, roadName: '' },
  { lng: laneBaseLng + 0.001, lat: laneBaseLat, roadName: '' },
  { lng: laneBaseLng + 0.001, lat: laneBaseLat + 100 * metersToLat, roadName: '' }
];
assert.deepStrictEqual(
  buildDirectionlessRoutingAnchorIndexes(cornerStops, corridorDestination, coordOf),
  [0, 1, 2],
  '路口转弯站点不得被共线简化误删'
);

function buildUnits(count, dest) {
  const units = [];
  for (let i = 0; i < count; i++) {
    const sector = i % 5;
    const ring = Math.floor(i / 5) + 1;
    const angle = -2.5 + sector * 0.88 + (ring % 2 ? 0.06 : -0.04);
    const radius = 0.018 + ring * 0.006;
    units.push({
      _aid: i,
      name: '站点' + (i + 1),
      lng: dest.lng + Math.cos(angle) * radius,
      lat: dest.lat + Math.sin(angle) * radius,
      people: 6 + (i % 4),
      stopCount: 2 + (i % 3),
      stopNames: ['站点' + (i + 1)],
      regionIdx: i
    });
  }
  return units;
}

function assertCoverage(plan, source) {
  const ids = [];
  plan.routes.forEach(function (route) {
    assert(route.stops.length > 0, '不应产生空线路');
    route.stops.forEach(function (stop) { ids.push(stop._aid); });
  });
  assert.strictEqual(ids.length, source.length, '所有容量单元必须被分配');
  assert.strictEqual(new Set(ids).size, source.length, '容量单元不得重复分配');
  assert.strictEqual(plan.totalPeople, source.reduce(function (sum, unit) { return sum + unit.people; }, 0));
  plan.routes.forEach(function (route) {
    assert(route.metrics.people <= ROUTE_MAX_PEOPLE, '可行数据不应超出单车人数上限');
  });
}

const dest = { _aid: 'dest', name: '测试终点', lng: 118.373875, lat: 31.417475 };
const unitCount = Math.max(10, Number(process.env.ROUTE_TEST_UNITS) || 24);
const units = buildUnits(unitCount, dest);
const totalPeople = units.reduce(function (sum, unit) { return sum + unit.people; }, 0);
const requestedRoutes = Math.max(5, Math.ceil(totalPeople / ROUTE_MAX_PEOPLE));
const started = performance.now();
const plan = planRoutes(requestedRoutes, dest, units, { rawTotalPeople: totalPeople, removed: [] });
const elapsedMs = performance.now() - started;
assertCoverage(plan, units);

const splitPoint = { name: '大站', lng: 118.3, lat: 31.3, people: 91, stopCount: 9, stopNames: ['大站'], regionIdx: 100 };
const splitUnits = expandCapacityUnits([splitPoint]);
assert.strictEqual(splitUnits.length, 3, '单点人数超过容量时应拆分为多个班次');
assert(splitUnits.every(function (unit) { return unit.people <= ROUTE_MAX_PEOPLE; }), '拆分后的每个班次都必须符合载客上限');
assert.strictEqual(splitUnits.reduce(function (sum, unit) { return sum + unit.people; }, 0), 91, '拆分不得遗失人数');

const manualUnits = buildUnits(18, dest);
for (let i = 0; i < 4; i++) manualUnits[i]._manualStartIndex = i;
const manualPeople = manualUnits.reduce(function (sum, unit) { return sum + unit.people; }, 0);
const manualPlan = planRoutes(4, dest, manualUnits, { rawTotalPeople: manualPeople, removed: [] });
assertCoverage(manualPlan, manualUnits);
assert.strictEqual(manualPlan.routes.length, 4, '手动起点模式必须保留指定线路数');
manualPlan.routes.forEach(function (route, index) {
  assert.strictEqual(route.stops[0]._manualStartIndex, index, '手动选择的起点必须保持为该线路第一站');
});

const reorderedStops = [
  { _aid: 'a', name: '原起点' },
  { _aid: 'b', name: '第二站' },
  { _aid: 'c', name: '新起点' },
  { _aid: 'd', name: '第四站' }
];
const promotedStops = promoteRouteStopToStart(reorderedStops, 2, { manualStartMode: false, routeIndex: 0 });
assert.deepStrictEqual(promotedStops.map(function (stop) { return stop._aid; }), ['c', 'a', 'b', 'd'],
  '非起点站设为新起点后，其他站点必须保持原有相对顺序');
assert.deepStrictEqual(reorderedStops.map(function (stop) { return stop._aid; }), ['a', 'b', 'c', 'd'],
  '调整函数不应直接改写原站点数组的顺序');

const fixedStartStops = [
  { _aid: 'start', _manualStartIndex: 2 },
  { _aid: 'middle' },
  { _aid: 'new-start' }
];
const promotedFixedStops = promoteRouteStopToStart(fixedStartStops, 2, { manualStartMode: true, routeIndex: 2 });
assert.strictEqual(promotedFixedStops[0]._aid, 'new-start', '选中站点必须成为线路第一站');
assert.strictEqual(promotedFixedStops[0]._manualStartIndex, 2, '手动起点标记必须转移到新起点');
assert.strictEqual(fixedStartStops[0]._manualStartIndex, null, '原起点必须降为普通上车点');

const actualDistanceMetrics = routeMetrics(plan.routes[0].stops, dest);
if (checkRoute.length >= 2) {
  assert(checkRoute(actualDistanceMetrics, ROUTE_MAX_KM - 1).every(function (issue) {
    return issue.indexOf('预估里程') < 0 && issue.indexOf('实走里程') < 0;
  }), '实际里程合规时不应继续报预估里程超限');
  assert(checkRoute(actualDistanceMetrics, ROUTE_MAX_KM + 1).some(function (issue) {
    return issue.indexOf('实走里程') >= 0;
  }), '实际里程超限必须报告');
}

const currentLimitScore = routeConstraintOptimizationScore([
  { stops: [], metrics: { people: 40, stopCount: 12, estRoadKm: 35 }, roadKm: 35, missedStops: [] }
]);
const improvedLimitScore = routeConstraintOptimizationScore([
  { stops: [], metrics: { people: 40, stopCount: 12, estRoadKm: 32 }, roadKm: 32, missedStops: [] }
]);
const compliantLimitScore = routeConstraintOptimizationScore([
  { stops: [], metrics: { people: 40, stopCount: 12, estRoadKm: 29 }, roadKm: 29, missedStops: [] }
]);
assert.strictEqual(isBetterRouteConstraintScore(improvedLimitScore, currentLimitScore), true, '超限程度降低时必须继续接受重规划');
assert.strictEqual(isBetterRouteConstraintScore(currentLimitScore, improvedLimitScore), false, '更差的候选方案不得覆盖当前最佳方案');
assert.strictEqual(isBetterRouteConstraintScore(compliantLimitScore, improvedLimitScore), true, '消除一个超限项应优先于其他评分');
assert.strictEqual(shouldStopConstraintReplanning(1, 3), false, '一次未改善后必须继续重规划');
assert.strictEqual(shouldStopConstraintReplanning(2, 3), false, '连续两次未改善后仍必须继续重规划');
assert.strictEqual(shouldStopConstraintReplanning(3, 3), true, '只有连续三次未改善后才能停止重规划');

const signatureRoute = [{ stops: [{ _aid: 1 }, { _aid: 2 }], metrics: { people: 30, stopCount: 10 } }];
const signatureCopy = cloneRoutesForOptimization(signatureRoute);
assert.strictEqual(routeAssignmentSignature(signatureRoute), routeAssignmentSignature(signatureCopy), '路线快照必须保留循环检测签名');
signatureCopy[0].stops.reverse();
assert.notStrictEqual(routeAssignmentSignature(signatureRoute), routeAssignmentSignature(signatureCopy), '站序或分配变化必须产生新的循环检测签名');

console.log(JSON.stringify({
  elapsedMs: Math.round(elapsedMs),
  routes: plan.routes.length,
  units: unitCount,
  people: plan.totalPeople,
  stops: plan.totalStops,
  loads: plan.routes.map(function (route) { return route.metrics.people; })
}));
