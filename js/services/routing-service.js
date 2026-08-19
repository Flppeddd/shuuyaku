// 地理位置辅助函数，以及带节流控制的高德驾车距离服务。
function toRad(d) { return d * Math.PI / 180; }

function distCacheKey(a, b) {
  var aId = a._aid, bId = b._aid;
  if (aId == null || bId == null) return null;
  // 数字编号按数值排序；终点编号始终放在字符串一侧。
  var aNum = typeof aId === 'number', bNum = typeof bId === 'number';
  if (aNum && bNum) return (aId < bId ? aId + '-' + bId : bId + '-' + aId);
  if (aNum && !bNum) return aId + '-' + bId;
  if (!aNum && bNum) return bId + '-' + aId;
  return String(aId) < String(bId) ? aId + '-' + bId : bId + '-' + aId;
}

function geoDistance(a, b) {
  var dLat = toRad(b.lat - a.lat);
  var dLng = toRad(b.lng - a.lng);
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function nearestBoardingStopCandidate(candidates, point) {
  var best = null;
  var bestDistance = Infinity;
  (candidates || []).forEach(function (candidate) {
    var candidateDistance = geoDistance(point, candidate);
    if (candidateDistance < bestDistance) {
      best = candidate;
      bestDistance = candidateDistance;
    }
  });
  return best;
}

function localMetersFromAnchor(point, anchor) {
  var metersPerLng = 111320 * Math.cos(toRad(anchor.lat));
  return {
    x: (Number(point.lng) - anchor.lng) * metersPerLng,
    y: (Number(point.lat) - anchor.lat) * 111320
  };
}

function pointFromAnchorMeters(local, anchor) {
  var metersPerLng = 111320 * Math.cos(toRad(anchor.lat));
  return {
    lng: anchor.lng + local.x / metersPerLng,
    lat: anchor.lat + local.y / 111320
  };
}

// 数据库中的“对侧”坐标是批量推算值，部分点可能仍落在原站同侧。
// 道路匹配成功后，roadLng/roadLat 是原站附近的道路中心锚点；从锚点
// 指向原站的向量可视为道路横向法线。候选点只有投影到该法线的另一侧，
// 才能被认为真正跨过道路中心线。仍在同侧或贴近中心线时，只翻转它的
// 横向分量，保留沿道路方向的位移，避免把站点错误移动到道路远处。
function normalizeOtherSideBoardingStopCandidate(stop, candidate) {
  var normalized = {
    name: candidate.name,
    lng: Number(candidate.lng),
    lat: Number(candidate.lat),
    side: candidate.side,
    baseName: candidate.baseName
  };
  var original = {
    lng: Number(stop.stopLng != null ? stop.stopLng : stop.lng),
    lat: Number(stop.stopLat != null ? stop.stopLat : stop.lat)
  };
  var anchor = { lng: Number(stop.roadLng), lat: Number(stop.roadLat) };
  if (!isFinite(original.lng) || !isFinite(original.lat) ||
      !isFinite(anchor.lng) || !isFinite(anchor.lat) ||
      !isFinite(normalized.lng) || !isFinite(normalized.lat)) return normalized;

  var originalVector = localMetersFromAnchor(original, anchor);
  var originalOffset = Math.sqrt(originalVector.x * originalVector.x + originalVector.y * originalVector.y);
  // 原站几乎就在道路锚点上时无法可靠判断左右侧；不凭空修改数据库坐标。
  if (originalOffset < 2 || originalOffset > DIRECTION_AGNOSTIC_ROAD_PASS_RADIUS_M) return normalized;

  var nx = originalVector.x / originalOffset;
  var ny = originalVector.y / originalOffset;
  var candidateVector = localMetersFromAnchor(normalized, anchor);
  var signedAcross = candidateVector.x * nx + candidateVector.y * ny;
  normalized.roadLng = anchor.lng;
  normalized.roadLat = anchor.lat;
  normalized.roadSnapM = Math.sqrt(candidateVector.x * candidateVector.x + candidateVector.y * candidateVector.y);
  normalized.sideGeometryChecked = true;

  // 负投影表示候选已经越过道路中心线，保留数据库原坐标。
  if (signedAcross < -1.5) return normalized;

  var alongX = candidateVector.x - signedAcross * nx;
  var alongY = candidateVector.y - signedAcross * ny;
  var correctedAcross = -Math.max(Math.abs(signedAcross), originalOffset, 6);
  var corrected = pointFromAnchorMeters({
    x: alongX + correctedAcross * nx,
    y: alongY + correctedAcross * ny
  }, anchor);
  normalized.originalLng = normalized.lng;
  normalized.originalLat = normalized.lat;
  normalized.lng = corrected.lng;
  normalized.lat = corrected.lat;
  normalized.roadSnapM = Math.sqrt(alongX * alongX + alongY * alongY + correctedAcross * correctedAcross);
  normalized.sideGeometryCorrected = true;
  return normalized;
}

function findOtherSideBoardingStop(stop) {
  if (!stop || !boardingStopSideIndex) return null;
  var baseName = boardingStopBaseName(stop.name);
  var group = boardingStopSideIndex[baseName];
  if (!group) return null;
  var currentSide = boardingStopSide(stop.name);
  var wantedSide = currentSide === 'opposite' ? 'regular' : 'opposite';
  var point = {
    lng: stop.stopLng != null ? stop.stopLng : stop.lng,
    lat: stop.stopLat != null ? stop.stopLat : stop.lat
  };
  var candidate = nearestBoardingStopCandidate(group[wantedSide], point);
  if (!candidate) return null;
  return normalizeOtherSideBoardingStopCandidate(stop, {
    name: candidate.name,
    lng: Number(candidate.lng),
    lat: Number(candidate.lat),
    side: wantedSide,
    baseName: baseName
  });
}

function preferAlternativeDrivingResult(currentResult, alternativeResult) {
  if (!alternativeResult) return false;
  if (!currentResult) return true;
  var currentDistance = Number(currentResult.dist);
  var alternativeDistance = Number(alternativeResult.dist);
  var currentTime = Number(currentResult.time);
  var alternativeTime = Number(alternativeResult.time);

  // 按需求以实际驾车距离作为第一判断条件；距离相同（1米误差内）时，
  // 再使用驾车时间作为第二判断条件。距离和时间都会保存到比较结果中。
  if (isFinite(alternativeDistance) && isFinite(currentDistance)) {
    if (alternativeDistance + 1 < currentDistance) return true;
    if (currentDistance + 1 < alternativeDistance) return false;
  } else if (isFinite(alternativeDistance)) {
    return true;
  } else if (isFinite(currentDistance)) {
    return false;
  }
  return isFinite(alternativeTime) && (!isFinite(currentTime) || alternativeTime < currentTime);
}

function pointToSegmentDistanceM(point, a, b) {
  // 经纬度不能直接当作平面坐标计算距离：纬度方向每度约为111.32km，
  // 经度方向还要乘以当前位置纬度的 cos 值。这里先把线段两端换算成
  // 以 point 为原点的局部米制坐标，再求 point 到线段 a-b 的垂距。
  var metersLng = 111320 * Math.cos(toRad(point.lat));
  var ax = (a[0] - point.lng) * metersLng;
  var ay = (a[1] - point.lat) * 111320;
  var bx = (b[0] - point.lng) * metersLng;
  var by = (b[1] - point.lat) * 111320;
  var dx = bx - ax, dy = by - ay;
  var len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.sqrt(ax * ax + ay * ay);
  // t 是 point 在线段方向上的投影比例。限制在[0, 1]后，投影落在线段
  // 外部时会自动改用最近端点，避免把路线无限延长线误判为实际经过。
  var t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  var cx = ax + t * dx, cy = ay + t * dy;
  return Math.sqrt(cx * cx + cy * cy);
}

function minDistanceToPathM(point, path) {
  // 驾车路径由大量折线点组成。逐段计算 point 到每条短线段的距离，
  // 其中的最小值才是“站点到整条实际行驶路线”的最近距离。
  if (!path || path.length === 0) return Infinity;
  if (path.length === 1) return geoDistance(point, { lng: path[0][0], lat: path[0][1] });
  var best = Infinity;
  for (var i = 0; i < path.length - 1; i++) {
    var d = pointToSegmentDistanceM(point, path[i], path[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

function normalizedRoadName(name) {
  // 道路名称只用于确认“是否为同一条道路”，因此去掉东/西行、上下行、
  // 主辅路等方向或车道侧描述。例如“测试路（东行）”与“测试路（西行）”
  // 会归一化为同一个名称，但“无名道路”不会被当成可靠的道路匹配依据。
  return String(name || '').trim().replace(/\s+/g, '')
    .replace(/[（(](?:东|西|南|北|上|下|内|外)(?:行|向|侧)?[）)]/g, '')
    .replace(/(?:东向|西向|南向|北向|上行|下行)$/g, '')
    .replace(/(?:主路|辅路)$/g, '');
}

function sameRoadName(first, second) {
  var a = normalizedRoadName(first);
  var b = normalizedRoadName(second);
  return !!a && !!b && a === b && a !== '无名道路';
}

function corridorProjectionInfo(previous, current, next) {
  // 此函数服务于导航节点简化，而不是最终的经过判定：检查 current 是否
  // 位于 previous 到 next 形成的道路走廊中，并返回三个几何指标：
  // ratio：current 在前后点连线中的位置；0~1表示位于二者之间。
  // lateralM：current 偏离前后点连线的横向距离。
  // detourM：强制经过 current 相比直接连接前后点多出的几何距离。
  var metersLng = 111320 * Math.cos(toRad(current[1]));
  var ax = (previous[0] - current[0]) * metersLng;
  var ay = (previous[1] - current[1]) * 111320;
  var bx = (next[0] - current[0]) * metersLng;
  var by = (next[1] - current[1]) * 111320;
  var dx = bx - ax, dy = by - ay;
  var len2 = dx * dx + dy * dy;
  if (len2 < 1) return { ratio: -1, lateralM: Infinity, detourM: Infinity };
  var ratio = -(ax * dx + ay * dy) / len2;
  var cx = ax + ratio * dx, cy = ay + ratio * dy;
  var directM = Math.sqrt(len2);
  var previousM = Math.sqrt(ax * ax + ay * ay);
  var nextM = Math.sqrt(bx * bx + by * by);
  return {
    ratio: ratio,
    lateralM: Math.sqrt(cx * cx + cy * cy),
    detourM: Math.max(0, previousM + nextM - directM)
  };
}

// 同一道路走廊中的站点只是“路线需要覆盖的检查点”，不一定要作为高德
// 驾车请求的强制终点。这样可避免高德把坐标绑定到公交站所在一侧车道，
// 从而为了抵达该侧车道而生成无意义的掉头。
function isDirectionlessCorridorStop(previousStop, currentStop, nextStop, coordOf) {
  if (!previousStop || !currentStop || !nextStop) return false;
  var previous = coordOf(previousStop);
  var current = coordOf(currentStop);
  var next = coordOf(nextStop);
  if (!previous || !current || !next) return false;
  var projection = corridorProjectionInfo(previous, current, next);
  // current 必须确实处在前后点之间；若在连线之外，则它可能代表真实的
  // 折返点，不能仅为了减少导航节点而跳过。
  if (projection.ratio <= 0.01 || projection.ratio >= 0.99) return false;

  // 有可靠道路名称匹配时，允许在双向道路宽度范围内识别对向车道；
  // 没有道路名（例如旧版Excel）时采用更严格的12米共线条件，防止把
  // 相邻但不同的平行道路错误地视为同一路段。
  var namedRoadMatch = sameRoadName(currentStop.roadName, previousStop.roadName) ||
    sameRoadName(currentStop.roadName, nextStop.roadName);
  var maxLateralM = namedRoadMatch ? DIRECTION_AGNOSTIC_ROAD_PASS_RADIUS_M : 12;
  var maxDetourM = namedRoadMatch ? 80 : 24;
  return projection.lateralM <= maxLateralM && projection.detourM <= maxDetourM;
}

function buildDirectionlessRoutingAnchorIndexes(stops, destination, coordOf, isProtected) {
  // 第一站始终保留，因为它是真实的线路起点。后续顺路站点可以不作为
  // 导航端点，但仍完整保留在 rt.stops 中，后面还会逐站执行经过判定。
  // isProtected 用于保留手动调整过或曾经覆盖失败的站点。
  if (!stops || !stops.length) return [];
  var anchors = [0];
  for (var i = 1; i < stops.length; i++) {
    var previous = stops[anchors[anchors.length - 1]];
    var next = i < stops.length - 1 ? stops[i + 1] : destination;
    var protectedStop = isProtected && isProtected(i);
    if (protectedStop || !isDirectionlessCorridorStop(previous, stops[i], next, coordOf)) anchors.push(i);
  }
  return anchors;
}

function minDistanceToMatchingRoadM(point, roadName, steps) {
  // 高德的每个驾车 step 会携带道路名称和该道路上的实际路径。
  // 这里只检查名称归一化后与站点所在道路相同的 step，再计算站点道路
  // 锚点到这些路径的最近距离。因此，附近另一条道路不会仅因距离较近
  // 就被判定为已经经过本站。
  if (!roadName || !steps || !steps.length) return Infinity;
  var best = Infinity;
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    if (!sameRoadName(roadName, step.roadName || step.road)) continue;
    var d = minDistanceToPathM(point, step.path || []);
    if (d < best) best = d;
  }
  return best;
}

function evaluateRoutePasses(rt, path, steps) {
  // 经过站点判定按以下优先级执行：
  // 1. 优先检查路线是否行驶在同名道路上，且距道路锚点不超过45米。
  //    此规则忽略东西向、南北向、上下行以及道路左右侧，专门解决
  //    对向站点缺失和为进入站点所在侧车道而掉头的问题。
  // 2. 路线距原始公交站坐标不超过20米；
  // 3. 路线距站点吸附到道路后的锚点不超过20米；
  // 旧版Excel没有道路名称时，最后再使用已保存道路锚点的45米兼容规则。
  // 任意一种方式成立即视为经过；否则加入 rt.missedStops。
  rt.missedStops = [];
  rt.stops.forEach(function (s) {
    // original 是公交站/聚合上车点的原始坐标。线路规划过程中即使将
    // 站点吸附到了道路上，也不能覆盖或丢失这个真实位置。
    var original = {
      lng: s.stopLng != null ? s.stopLng : s.lng,
      lat: s.stopLat != null ? s.stopLat : s.lat
    };
    // roadAnchor 是道路吸附坐标，通常位于道路中心线或可通行路段上。
    // 未完成道路吸附时退回 original，确保所有数据版本都可正常判定。
    var roadAnchor = s.roadLng != null && s.roadLat != null ? { lng: s.roadLng, lat: s.roadLat } : original;

    // 分别计算原始站点、道路锚点、同名道路路径三种最近距离。
    // namedRoadDistance 只会从同名道路的高德步骤中取值，因此它能够
    // 放宽行驶方向，却不会无条件放宽到附近任意道路。
    var originalDistance = minDistanceToPathM(original, path);
    var roadAnchorDistance = minDistanceToPathM(roadAnchor, path);
    var namedRoadDistance = minDistanceToMatchingRoadM(roadAnchor, s.roadName, steps);
    // 旧版导出文件可能已经保存 roadLng/roadLat 或 roadSnapM，却没有
    // roadName。只在确实存在道路吸附痕迹时启用45米兼容判定，不能让
    // 所有缺少道路名的普通站点都获得宽松阈值。
    var anchorOffset = geoDistance(original, roadAnchor);
    var hasLegacyRoadAnchor = !s.roadName && (anchorOffset > 0.5 || Number(s.roadSnapM) > 0);
    // 同名道路判定必须优先于两个20米判定。即使路线同时贴近原始站点，
    // 只要同名道路规则成立，也应记录为“同一道路任意方向经过”。
    var sameRoadPass = namedRoadDistance <= DIRECTION_AGNOSTIC_ROAD_PASS_RADIUS_M;
    var exactPass = originalDistance <= STOP_PASS_RADIUS_M;
    var anchorPass = roadAnchorDistance <= STOP_PASS_RADIUS_M;
    var legacyRoadAnchorPass = hasLegacyRoadAnchor &&
      roadAnchorDistance <= DIRECTION_AGNOSTIC_ROAD_PASS_RADIUS_M;
    // 保存完整诊断信息，供界面、Excel导出及后续问题排查使用。
    // passMatchType 按判定优先级记录：
    // same-road-opposite-direction：优先命中同名道路45米任一方向规则；
    // stop-radius：未命中同名道路规则，但在原始站点20米内经过；
    // road-anchor：前两项未命中，但在道路锚点20米内经过；
    // missed：所有规则均未命中。旧版道路锚点45米兼容结果仍沿用
    // same-road-opposite-direction，便于旧文件与当前界面保持兼容。
    s.originalPassDistanceM = originalDistance;
    s.roadPassDistanceM = Math.min(roadAnchorDistance, namedRoadDistance);
    s.passDistanceM = Math.min(originalDistance, roadAnchorDistance, namedRoadDistance);
    s.passMatchType = sameRoadPass ? 'same-road-opposite-direction' :
      (exactPass ? 'stop-radius' :
        (anchorPass ? 'road-anchor' :
          (legacyRoadAnchorPass ? 'same-road-opposite-direction' : 'missed')));
    // 该字段表示最终结果是否依赖“不区分站点方向”的判定方式。
    // 同名道路优先命中时，即使同时也在20米内，仍应标记为 true。
    s.passedDirectionAgnostic = sameRoadPass || legacyRoadAnchorPass || (!exactPass && anchorPass);
    s.passedWithinRadius = sameRoadPass || exactPass || anchorPass || legacyRoadAnchorPass;
    if (!s.passedWithinRadius) rt.missedStops.push(s);
  });
  // 使用总上车点数减去漏站数，避免不同判定方式重复计数。
  rt.passedStopCount = rt.stops.length - rt.missedStops.length;
}

function pathDistanceM(path) {
  var total = 0;
  for (var i = 0; path && i < path.length - 1; i++) {
    total += geoDistance({ lng: path[i][0], lat: path[i][1] }, { lng: path[i + 1][0], lat: path[i + 1][1] });
  }
  return total;
}

function drivingSegmentCacheKey(start, end, waypoints) {
  return [start, end].concat(waypoints || []).map(function (p) {
    return Number(p[0]).toFixed(6) + ',' + Number(p[1]).toFixed(6);
  }).join('>');
}

function distance(a, b) {
  if (a._aid != null && b._aid != null) {
    var key = distCacheKey(a, b);
    var cached = key != null ? amapDistCache[key] : null;
    if (cached) return cached.dist;
  }
  return geoDistance(a, b);
}

function pumpAmapDrivingQueue() {
  if (amapDrivingPumpTimer || amapDrivingActive >= AMAP_CONCURRENCY || !amapDrivingQueue.length) return;
  var waitMs = Math.max(0, AMAP_REQUEST_INTERVAL_MS - (Date.now() - amapDrivingLastStart));
  if (waitMs > 0) {
    amapDrivingPumpTimer = setTimeout(function () {
      amapDrivingPumpTimer = null;
      pumpAmapDrivingQueue();
    }, waitMs);
    return;
  }
  var item = amapDrivingQueue.shift();
  amapDrivingActive++;
  amapDrivingLastStart = Date.now();
  var settled = false;
  var timeoutId = setTimeout(function () { finish('timeout', { info: '请求超时' }); }, 25000);

  function finish(status, result) {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    amapDrivingActive--;
    try { item.callback(status, result); } finally { pumpAmapDrivingQueue(); }
  }

  try {
    if (!drivingInst) finish('error', { info: '驾车规划服务尚未加载' });
    else if (item.options) drivingInst.search(item.origin, item.dest, item.options, finish);
    else drivingInst.search(item.origin, item.dest, finish);
  } catch (e) {
    finish('error', { info: e && e.message ? e.message : '驾车规划调用异常' });
  }
  pumpAmapDrivingQueue();
}

function queueAmapDriving(origin, dest, options, callback) {
  amapDrivingQueue.push({ origin: origin, dest: dest, options: options || null, callback: callback });
  pumpAmapDrivingQueue();
}

function amapDrivingPromise(origin, dest) {
  return new Promise(function (resolve, reject) {
    if (!drivingInst) { reject(new Error('Amap Driving not ready')); return; }
    queueAmapDriving(origin, dest, null, function (status, result) {
      if (status === 'complete' && result.routes && result.routes[0]) {
        resolve({ dist: result.routes[0].distance, time: result.routes[0].time });
      } else {
        reject(new Error((result && result.info) || 'Amap driving request failed'));
      }
    });
  });
}

function computeAmapDistMatrix(units, dest, onProgress, cache) {
  return new Promise(function (resolve) {
    cache = cache || amapDistCache;
    var n = units.length;
    var pairs = [];
    var already = 0;
    var totalPairs = 0;
    var completedPairs = 0;

    function reportProgress() {
      amapTotalPairs = totalPairs;
      amapCompletedPairs = completedPairs;
      if (onProgress) onProgress(completedPairs, totalPairs);
    }

    function pairKey(i, j) {
      return j < 0 ? (i + '-dest') : (Math.min(i, j) + '-' + Math.max(i, j));
    }

    for (var i = 0; i < n; i++) {
      var kDest = pairKey(i, -1);
      if (cache[kDest]) already++;
      else pairs.push({ i: i, j: -1, a: [units[i].lng, units[i].lat], b: [dest.lng, dest.lat] });
      for (var j = i + 1; j < n; j++) {
        var k = pairKey(i, j);
        if (cache[k]) already++;
        else pairs.push({ i: i, j: j, a: [units[i].lng, units[i].lat], b: [units[j].lng, units[j].lat] });
      }
    }
    totalPairs = pairs.length + already;
    completedPairs = already;
    amapDistReady = false;
    reportProgress();

    function cacheResult(i, j, result) {
      cache[pairKey(i, j)] = result;
    }

    function haversineFallback(a, b) {
      var dLat = toRad(b[1] - a[1]);
      var dLng = toRad(b[0] - a[0]);
      var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
      var dist = 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
      return { dist: dist * ROAD_FACTOR, time: (dist * ROAD_FACTOR) / 8 };
    }

    // 完整的 N×N 道路矩阵可能消耗数百甚至数千次驾车规划请求，
    // 从而没有足够配额绘制实际路线。这里只查询最有价值的点对
    // （先查询所有到终点的点对，再查询地理位置相近的点对），其余距离进行估算。
    // 最终展示的线路仍然使用真实道路路径。
    if (pairs.length > AMAP_MATRIX_REQUEST_LIMIT) {
      pairs.sort(function (p, q) {
        var pDest = p.j < 0, qDest = q.j < 0;
        if (pDest !== qDest) return pDest ? -1 : 1;
        return geoDistance({ lng: p.a[0], lat: p.a[1] }, { lng: p.b[0], lat: p.b[1] }) -
          geoDistance({ lng: q.a[0], lat: q.a[1] }, { lng: q.b[0], lat: q.b[1] });
      });
      var estimatedPairs = pairs.slice(AMAP_MATRIX_REQUEST_LIMIT);
      pairs = pairs.slice(0, AMAP_MATRIX_REQUEST_LIMIT);
      estimatedPairs.forEach(function (p) {
        cacheResult(p.i, p.j, haversineFallback(p.a, p.b));
        completedPairs++;
      });
      reportProgress();
    }

    var idx = 0;
    var active = 0;

    function next() {
      while (active < AMAP_CONCURRENCY && idx < pairs.length) {
        var pair = pairs[idx++];
        active++;
        (function (p) {
          amapDrivingPromise(p.a, p.b).then(function (result) {
            completedPairs++;
            cacheResult(p.i, p.j, result);
            reportProgress();
            active--;
            next();
          }).catch(function () {
            completedPairs++;
            cacheResult(p.i, p.j, haversineFallback(p.a, p.b));
            reportProgress();
            active--;
            next();
          });
        })(pair);
      }
      if (active === 0 && idx >= pairs.length) {
        amapDistReady = true;
        resolve();
      }
    }

    if (pairs.length === 0) { amapDistReady = true; resolve(); return; }
    next();
  });
}
