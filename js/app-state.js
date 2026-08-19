// 共享配置与可变的应用状态。
// 本文件最先加载，确保其余传统脚本仍可通过 file:// 方式运行。
var allStopsData = (typeof ALL_STOPS !== 'undefined' ? ALL_STOPS : []).map(function (s) {
  return { name: s.n, lng: s.l, lat: s.a };
});
var boardingStopSideIndex = buildBoardingStopSideIndex(allStopsData);

function boardingStopBaseName(name) {
  return String(name || '').trim().replace(/[（(](?:公交站|对侧)[）)]$/g, '').trim();
}

function boardingStopSide(name) {
  var value = String(name || '').trim();
  if (/[（(]对侧[）)]$/.test(value)) return 'opposite';
  if (/[（(]公交站[）)]$/.test(value)) return 'regular';
  return 'unknown';
}

function buildBoardingStopSideIndex(stops) {
  var index = Object.create(null);
  (stops || []).forEach(function (stop) {
    var baseName = boardingStopBaseName(stop.name);
    var side = boardingStopSide(stop.name);
    if (!baseName || side === 'unknown') return;
    if (!index[baseName]) index[baseName] = { regular: [], opposite: [] };
    index[baseName][side].push(stop);
  });
  return index;
}
var summaryData = null;
var results = null;
var routePlans = null;
var lastMaxDist = 500;
var map = null;
var mapMarkers = [];
var routeOverlays = [];
var routePathData = [];
var mainRouteLines = [];
var drivingInst = null;
var geocoderInst = null;
var placeSearchInst = null;
var roadSnapCache = {};
var $ = function (id) { return document.getElementById(id); };

var FACTORIES = {
  yinhu: { name: '银湖工厂', lng: 118.373875, lat: 31.417475 },
  huashan: { name: '华山工厂', lng: 118.377275, lat: 31.474675 }
};
var ROUTE_MIN_STOPS = 10;
var ROUTE_MIN_PEOPLE = 20;
var ROUTE_MAX_PEOPLE = 45;
var ROUTE_MAX_KM = 30;
// 超限重规划只有在连续三次候选都没有改善后才停止；任一次改善都会重新计数。
var MAX_CONSECUTIVE_REPLAN_FAILURES = 3;
var ROAD_FACTOR = 1.35;
var STOP_PASS_RADIUS_M = 20;
// 站点通过判定优先使用此阈值：路线位于同名道路且距道路锚点不超过45米，
// 即视为经过，不区分东/西行、南/北行、上/下行及道路左右侧。
// 只有同名道路优先规则不成立时，才退回上面的20米站点/道路锚点判定。
var DIRECTION_AGNOSTIC_ROAD_PASS_RADIUS_M = 45;
var NEARBY_BUS_SEARCH_RADIUS_M = 300;
var AMAP_CONCURRENCY = 2;
var AMAP_REQUEST_INTERVAL_MS = 180;
var AMAP_MATRIX_REQUEST_LIMIT = 120;
var amapDistCache = {};
var amapDistReady = false;
var amapTotalPairs = 0;
var amapCompletedPairs = 0;
var routeSegmentCache = {};
var manualRouteVias = {};
var manualStartSelections = [];
var manualStartActiveRoute = 0;
var manualStartSelectionOverlays = [];
var selectedAggregationRegion = -1;
var aggregationSelectionOverlays = [];
var aggregationDeletedCount = 0;
var aggregationDeletedPeople = 0;
var amapDrivingQueue = [];
var amapDrivingActive = 0;
var amapDrivingLastStart = 0;
var amapDrivingPumpTimer = null;
var manualCandidateOverlays = [];
var manualTempOverlays = [];
var selectedRouteIndex = -1;
var selectedStopIndex = -1;
var selectedNearbyIndex = -1;
var selectedSubsequentStopAid = null;
var selectedSwapStopAid = null;
var nearbyStopCandidates = [];
var nearbySearchToken = 0;
var manualViaMode = false;
var manualViaPoints = [];
var manualAddStopMode = false;
var manualAddStopPoint = null;
var manualAddStopOverlays = [];
var manualAddStopLookupToken = 0;
var nextManualAid = 100000;
var routePlanRunId = 0;
var RCOLORS = [
  // 前10种采用色相差异明显的分类色，避免相邻线路出现近似红色或蓝色。
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f',
  '#bcbd22', '#17becf', '#eab308', '#22c55e', '#06b6d4', '#0ea5e9', '#8b5cf6', '#ec4899',
  '#b91c1c', '#6366f1', '#a16207', '#15803d', '#0e7490', '#0284c7', '#6d28d9', '#be185d'
];

function beginRoutePlanRun() {
  routePlanRunId++;
  return routePlanRunId;
}

function cancelRoutePlanRun() {
  routePlanRunId++;
}

function isRoutePlanRunActive(runId) {
  return runId === routePlanRunId;
}
