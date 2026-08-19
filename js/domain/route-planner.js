// 线路分配、排序、均衡、约束修复与指标计算。
function expandCapacityUnits(points) {
  var units = [];
  var aid = 0;
  points.forEach(function (p) {
    if (p.people <= ROUTE_MAX_PEOPLE) {
      units.push({
        _aid: aid++, name: p.name,
        lng: p.roadLng != null ? p.roadLng : p.lng,
        lat: p.roadLat != null ? p.roadLat : p.lat,
        stopLng: p.lng, stopLat: p.lat,
        roadLng: p.roadLng, roadLat: p.roadLat, roadSnapM: p.roadSnapM || 0, roadName: p.roadName || '',
        people: p.people, stopCount: p.stopCount,
        stopNames: p.stopNames.slice(), regionIdx: p.regionIdx, part: 0,
        _manualStartIndex: p._manualStartIndex != null ? p._manualStartIndex : null
      });
      return;
    }
    var parts = Math.ceil(p.people / ROUTE_MAX_PEOPLE);
    var basePeople = Math.floor(p.people / parts);
    var extraPeople = p.people % parts;
    var baseStops = Math.floor(p.stopCount / parts);
    var extraStops = p.stopCount % parts;
    for (var part = 0; part < parts; part++) {
      var take = basePeople + (part < extraPeople ? 1 : 0);
      var sc = baseStops + (part < extraStops ? 1 : 0);
      units.push({
        _aid: aid++, name: p.name + (parts > 1 ? '(班' + (part + 1) + ')' : ''),
        lng: p.roadLng != null ? p.roadLng : p.lng,
        lat: p.roadLat != null ? p.roadLat : p.lat,
        stopLng: p.lng, stopLat: p.lat,
        roadLng: p.roadLng, roadLat: p.roadLat, roadSnapM: p.roadSnapM || 0, roadName: p.roadName || '',
        people: take,
        stopCount: sc,
        stopNames: p.stopNames.slice(),
        regionIdx: p.regionIdx,
        part: part,
        _manualStartIndex: part === 0 && p._manualStartIndex != null ? p._manualStartIndex : null
      });
    }
  });
  return units;
}

// 当请求的车辆数无法承载全部人员时，保持原有处理方式：
// 从距离工厂最近的上车点中删除人数最少的容量单元。
function trimExcessUnits(units, numRoutes, dest) {
  var totalPeople = units.reduce(function (s, u) { return s + u.people; }, 0);
  var maxCapacity = numRoutes * ROUTE_MAX_PEOPLE;
  if (totalPeople <= maxCapacity) return { units: units, removed: [] };

  var remaining = units.slice();
  remaining.forEach(function (u) { u._trimDist = geoDistance(u, dest); });
  var removed = [];
  var ADJACENT_M = 500;

  while (remaining.length && totalPeople > maxCapacity) {

    var removable = remaining.filter(function (u) { return u._manualStartIndex == null; });
    if (!removable.length) break;
    removable.sort(function (a, b) { return a._trimDist - b._trimDist; });
    var first = removable[0];
    var adjacent = removable.filter(function (u) { return u._trimDist - first._trimDist <= ADJACENT_M; });
    var toRemove = adjacent.reduce(function (best, u) { return u.people < best.people ? u : best; }, adjacent[0]);
    remaining.splice(remaining.indexOf(toRemove), 1);
    removed.push(toRemove);
    totalPeople -= toRemove.people;
  }

  remaining.concat(removed).forEach(function (u) { delete u._trimDist; });
  return { units: remaining, removed: removed };
}

function pathLen(ordered, dest) {
  if (!ordered.length) return 0;
  var len = 0;
  for (var i = 0; i < ordered.length - 1; i++) len += distance(ordered[i], ordered[i + 1]);
  len += distance(ordered[ordered.length - 1], dest);
  return len;
}

function ensureFarthestFirst(arr, dest) {
  if (arr.length > 1) {
    var farthestIndex = 0, farthestDistance = distance(arr[0], dest);
    for (var i = 1; i < arr.length; i++) {
      var d = distance(arr[i], dest);
      if (d > farthestDistance) { farthestDistance = d; farthestIndex = i; }
    }
    if (farthestIndex > 0) arr.unshift(arr.splice(farthestIndex, 1)[0]);
  }
  return arr;
}

// 点 p 相对于“终点→轴线点”线路轴线的带符号横向距离（米）。
// 正负值分别表示起点—终点连线的两侧。
function signedLateralOffsetM(p, dest, axisPt) {
  var dx = (p.lng - dest.lng) * 111320 * Math.cos(toRad(dest.lat));
  var dy = (p.lat - dest.lat) * 111320;
  var ax = (axisPt.lng - dest.lng) * 111320 * Math.cos(toRad(dest.lat));
  var ay = (axisPt.lat - dest.lat) * 111320;
  var alen = Math.sqrt(ax * ax + ay * ay);
  if (alen < 1) return Math.sqrt(dx * dx + dy * dy);
  return (ax * dy - ay * dx) / alen;
}

function lateralOffsetM(p, dest, axisPt) {
  return Math.abs(signedLateralOffsetM(p, dest, axisPt));
}

function routeAxisFrame(axisStart, dest) {
  var cos = Math.cos(toRad(dest.lat));
  var ax = (axisStart.lng - dest.lng) * 111320 * cos;
  var ay = (axisStart.lat - dest.lat) * 111320;
  var len = Math.sqrt(ax * ax + ay * ay);
  if (len < 1) return { ux: 0, uy: 1, px: -1, py: 0, cos: cos };
  var ux = ax / len, uy = ay / len;
  return { ux: ux, uy: uy, px: -uy, py: ux, cos: cos };
}

function routeAxisCoordinate(point, dest, frame) {
  var dx = (point.lng - dest.lng) * 111320 * frame.cos;
  var dy = (point.lat - dest.lat) * 111320;
  return { along: dx * frame.ux + dy * frame.uy, lateral: dx * frame.px + dy * frame.py };
}

// 衡量线路各段沿起点→终点方向行驶的程度。
function routeDirectionProfile(ordered, dest) {
  if (!ordered.length) {
    return { lateralMaxM: 0, lateralAvgM: 0, lateralSpanM: 0, lateralTravelM: 0, sideSwitchM: 0, directionDeviationM: 0, axisBacktrackM: 0 };
  }
  var frame = routeAxisFrame(ordered[0], dest);
  var coords = ordered.map(function (stop) { return routeAxisCoordinate(stop, dest, frame); });
  coords.push({ along: 0, lateral: 0 });
  var lateralMax = 0, lateralSum = 0, lateralMin = Infinity, lateralMaxSigned = -Infinity;
  for (var i = 0; i < ordered.length; i++) {
    var absLat = Math.abs(coords[i].lateral);
    lateralSum += absLat;
    if (absLat > lateralMax) lateralMax = absLat;
    if (coords[i].lateral < lateralMin) lateralMin = coords[i].lateral;
    if (coords[i].lateral > lateralMaxSigned) lateralMaxSigned = coords[i].lateral;
  }
  var lateralTravel = 0, sideSwitch = 0, directionDeviation = 0, axisBacktrack = 0;
  var SIDE_DEADBAND_M = 80;
  var ALIGNED_CROSS_RATIO = 0.65; // 约对应主方向两侧各 33 度的容差。
  for (var j = 0; j < coords.length - 1; j++) {
    var from = coords[j], to = coords[j + 1];
    var forward = from.along - to.along;
    var cross = Math.abs(to.lateral - from.lateral);
    lateralTravel += cross;
    if (from.lateral * to.lateral < 0 && Math.abs(from.lateral) > SIDE_DEADBAND_M && Math.abs(to.lateral) > SIDE_DEADBAND_M) {
      sideSwitch += Math.abs(from.lateral) + Math.abs(to.lateral);
    }
    if (forward >= 0) {
      directionDeviation += Math.max(0, cross - forward * ALIGNED_CROSS_RATIO);
    } else {
      axisBacktrack += -forward;
      directionDeviation += cross + (-forward) * 0.8;
    }
  }
  return {
    lateralMaxM: lateralMax,
    lateralAvgM: lateralSum / ordered.length,
    lateralSpanM: lateralMaxSigned - lateralMin,
    lateralTravelM: lateralTravel,
    sideSwitchM: sideSwitch,
    directionDeviationM: directionDeviation,
    axisBacktrackM: axisBacktrack
  };
}

// 跳转代价：距离加上偏离线路起点—终点方向的惩罚。
function hopCost(from, to, dest, axisStart) {
  var d = distance(from, to);
  var frame = routeAxisFrame(axisStart || from, dest);
  var fromCoord = routeAxisCoordinate(from, dest, frame);
  var toCoord = routeAxisCoordinate(to, dest, frame);
  var forward = fromCoord.along - toCoord.along;
  var cross = Math.abs(toCoord.lateral - fromCoord.lateral);
  var back = Math.max(0, -forward);
  var excessiveCross = Math.max(0, cross - Math.max(80, Math.max(0, forward) * 0.65));
  return d + cross * 0.75 + excessiveCross * 1.65 + back * 3.2;
}

function orderStopsFromFixedStart(stops, fixedStart, dest) {
  var remaining = stops.filter(function (s) { return s !== fixedStart; });
  var ordered = [fixedStart];
  while (remaining.length) {
    var last = ordered[ordered.length - 1];
    var bestIdx = 0, bestCost = Infinity;
    for (var i = 0; i < remaining.length; i++) {
      var cost = hopCost(last, remaining[i], dest, fixedStart);
      if (cost < bestCost) { bestCost = cost; bestIdx = i; }
    }
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }

  // 只优化后续站点；索引 0 是用户选择且不可移动的起点。
  var bestScore = routeOrderScore(ordered, dest);
  var improved = true, guard = 0;
  while (improved && guard++ < 80) {
    improved = false;
    for (var from = 1; from < ordered.length - 1; from++) {
      for (var to = from + 1; to < ordered.length; to++) {
        var candidate = ordered.slice(0, from).concat(ordered.slice(from, to + 1).reverse(), ordered.slice(to + 1));
        var score = routeOrderScore(candidate, dest);
        if (score + 1 < bestScore) {
          ordered = candidate;
          bestScore = score;
          improved = true;
        }
      }
    }
  }
  return ordered;
}

// 将线路中的一个非起点站提升为新起点。
// 除被提升的站点外，其余站点保持原有相对顺序，便于手动调整后只重算这一条线路。
function promoteRouteStopToStart(stops, stopIndex, options) {
  var ordered = (stops || []).slice();
  if (!Number.isInteger(stopIndex) || stopIndex <= 0 || stopIndex >= ordered.length) return ordered;

  var newStart = ordered.splice(stopIndex, 1)[0];
  ordered.unshift(newStart);

  // 手动起点模式下，固定起点标记必须跟随新起点，否则后续全局重规划会恢复旧起点。
  options = options || {};
  if (options.manualStartMode) {
    var manualStartIndex = null;
    (stops || []).forEach(function (stop) {
      if (manualStartIndex == null && stop._manualStartIndex != null) manualStartIndex = stop._manualStartIndex;
      stop._manualStartIndex = null;
    });
    newStart._manualStartIndex = manualStartIndex != null ? manualStartIndex : options.routeIndex;
  }
  return ordered;
}

function orderStopsNN(stops, dest) {
  if (stops.length === 0) return [];
  if (stops.length === 1) return stops.slice();
  var fixedStart = null;
  for (var fi = 0; fi < stops.length; fi++) {
    if (stops[fi]._manualStartIndex != null) { fixedStart = stops[fi]; break; }
  }
  if (fixedStart) return orderStopsFromFixedStart(stops, fixedStart, dest);

  // 种子方案 A：以最远点优先的最近邻，并考虑线路轴线跳转代价。
  var nn = (function () {
    var remaining = stops.slice();
    var ordered = [];
    var startIdx = 0, maxD = -1;
    for (var i = 0; i < remaining.length; i++) {
      var d = distance(remaining[i], dest);
      if (d > maxD) { maxD = d; startIdx = i; }
    }
    ordered.push(remaining.splice(startIdx, 1)[0]);
    while (remaining.length) {
      var last = ordered[ordered.length - 1];
      var best = 0, bestC = Infinity;
      for (var j = 0; j < remaining.length; j++) {
        var c = hopCost(last, remaining[j], dest, ordered[0]);
        if (c < bestC) { bestC = c; best = j; }
      }
      ordered.push(remaining.splice(best, 1)[0]);
    }
    return ordered;
  })();

  // 种子方案 B：纯径向排序（远→近），相同距离时按角度连续性处理。
  var radial = (function () {
    var arr = stops.slice();
    arr.sort(function (a, b) {
      var da = distance(a, dest), db = distance(b, dest);
      if (Math.abs(da - db) > 80) return db - da;
      var aa = Math.atan2(a.lat - dest.lat, a.lng - dest.lng);
      var ba = Math.atan2(b.lat - dest.lat, b.lng - dest.lng);
      return aa - ba;
    });
    return arr;
  })();

  // 种子方案 C：最小代价插入，同时保持最远站点作为线路起点。
  var ci = (function () {
    var remaining = stops.slice();
    var startIdx = 0, maxD = -1;
    for (var i = 0; i < remaining.length; i++) {
      var d = distance(remaining[i], dest);
      if (d > maxD) { maxD = d; startIdx = i; }
    }
    var ordered = [remaining.splice(startIdx, 1)[0]];
    while (remaining.length) {
      var bestGain = Infinity, bestRi = 0, bestPos = 0;
      for (var ri = 0; ri < remaining.length; ri++) {
        var node = remaining[ri];
        for (var pos = 1; pos <= ordered.length; pos++) {
          var prev = ordered[pos - 1];
          var next = pos === ordered.length ? dest : ordered[pos];
          var add = hopCost(prev, node, dest, ordered[0]) + hopCost(node, next, dest, ordered[0]);
          var rem = hopCost(prev, next, dest, ordered[0]);
          var gain = add - rem;
          if (gain < bestGain) { bestGain = gain; bestRi = ri; bestPos = pos; }
        }
      }
      ordered.splice(bestPos, 0, remaining.splice(bestRi, 1)[0]);
    }
    return ordered;
  })();

  var cands = [nn, radial, ci].map(function (c) { return improveRouteOrder(c, dest); });
  var best = cands[0], bestScore = routeOrderScore(best, dest);
  for (var i = 1; i < cands.length; i++) {
    var sc = routeOrderScore(cands[i], dest);
    if (sc < bestScore) { bestScore = sc; best = cands[i]; }
  }
  return best;
}

function routeOrderScore(ordered, dest) {
  if (!ordered.length) return 1e12;
  var len = pathLen(ordered, dest);
  var direction = routeDirectionProfile(ordered, dest);
  return routeOrderScoreFromParts(len, direction);
}

function routeOrderScoreFromParts(lengthM, direction) {
  return lengthM + direction.lateralTravelM * 0.9 + direction.directionDeviationM * 1.9 +
    direction.sideSwitchM * 1.6 + direction.axisBacktrackM * 3.0;
}

function routeOrderScoreFromMetrics(metrics) {
  return routeOrderScoreFromParts(metrics.straightM, metrics);
}

function improveRouteOrder(ordered, dest) {
  var arr = ensureFarthestFirst(ordered.slice(), dest);
  arr = twoOpt(arr, dest);
  arr = orOpt(arr, dest);
  // 再次执行 2-opt，并根据起点—终点方向判断是否接受调整。
  arr = twoOptEwAware(arr, dest);
  return ensureFarthestFirst(arr, dest);
}

function twoOptEwAware(ordered, dest) {
  var arr = ordered.slice();
  if (arr.length < 3) return arr;
  var bestSc = routeOrderScore(arr, dest);
  var improved = true, guard = 0;
  while (improved && guard++ < 80) {
    improved = false;
    // 保留索引 0，确保线路轴线以及自动/手动起点保持稳定。
    for (var i = 1; i < arr.length - 1; i++) {
      for (var k = i + 1; k < arr.length; k++) {
        var next = arr.slice(0, i).concat(arr.slice(i, k + 1).reverse(), arr.slice(k + 1));
        var sc = routeOrderScore(next, dest);
        if (sc + 1 < bestSc) {
          arr = next;
          bestSc = sc;
          improved = true;
        }
      }
    }
  }
  return arr;
}

function twoOpt(ordered, dest) {
  var arr = ordered.slice();
  if (arr.length < 3) return arr;
  var improved = true, guard = 0;
  while (improved && guard++ < 100) {
    improved = false;
    for (var i = 1; i < arr.length - 1; i++) {
      for (var k = i + 1; k < arr.length; k++) {
        // 计算以终点结束的开放路径增量。
        var a = i > 0 ? arr[i - 1] : null;
        var b = arr[i];
        var c = arr[k];
        var d = k + 1 < arr.length ? arr[k + 1] : dest;
        var before = (a ? distance(a, b) : 0) + distance(c, d);
        var after = (a ? distance(a, c) : 0) + distance(b, d);
        if (after + 1 < before) {
          var mid = arr.slice(i, k + 1).reverse();
          for (var t = 0; t < mid.length; t++) arr[i + t] = mid[t];
          improved = true;
        }
      }
    }
  }
  return arr;
}

function orOpt(ordered, dest) {
  var arr = ordered.slice();
  if (arr.length < 3) return arr;
  var bestLen = pathLen(arr, dest);
  var improved = true, guard = 0;
  while (improved && guard++ < 60) {
    improved = false;
    for (var segLen = 1; segLen <= 3; segLen++) {
      for (var i = 1; i <= arr.length - segLen; i++) {
        var seg = arr.slice(i, i + segLen);
        var rest = arr.slice(0, i).concat(arr.slice(i + segLen));
        for (var j = 1; j <= rest.length; j++) {
          if (j === i) continue;
          var cand = rest.slice(0, j).concat(seg, rest.slice(j));
          var d = pathLen(cand, dest);
          if (d + 1 < bestLen) {
            arr = cand;
            bestLen = d;
            improved = true;
            break;
          }
        }
        if (improved) break;
      }
      if (improved) break;
    }
  }
  return arr;
}

function routeMetrics(stops, dest) {
  var people = 0, stopCount = 0;
  var names = [];
  var allHaveAid = amapDistReady;
  stops.forEach(function (s) {
    people += s.people;
    stopCount += s.stopCount;
    names.push(s.name);
    if (s._aid == null) allHaveAid = false;
  });
  if (dest._aid == null) allHaveAid = false;
  var straight = pathLen(stops, dest);
  var estRoad = allHaveAid ? straight : straight * ROAD_FACTOR;
  var disp = 0;
  var centroid = dest;
  if (stops.length > 0) {
    var cx = 0, cy = 0;
    stops.forEach(function (s) { cx += s.lng; cy += s.lat; });
    cx /= stops.length; cy /= stops.length;
    centroid = { lng: cx, lat: cy };
    if (stops.length > 1) {
      stops.forEach(function (s) { disp += distance(centroid, s); });
      disp /= stops.length;
    }
  }
  var angularSpread = 0;
  if (stops.length > 1) {
    var angles = stops.map(function (s) { return Math.atan2(s.lat - dest.lat, s.lng - dest.lng); });
    angles.sort(function (a, b) { return a - b; });
    var maxGap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
    for (var i = 0; i < angles.length - 1; i++) {
      maxGap = Math.max(maxGap, angles[i + 1] - angles[i]);
    }
    angularSpread = 2 * Math.PI - maxGap;
  }
  var direction = routeDirectionProfile(stops, dest);
  return {
    people: people,
    stopCount: stopCount,
    boardingCount: stops.length,
    names: names,
    straightM: straight,
    estRoadM: estRoad,
    estRoadKm: estRoad / 1000,
    dispersionM: disp,
    angularSpread: angularSpread,
    lateralMaxM: direction.lateralMaxM,
    lateralAvgM: direction.lateralAvgM,
    lateralSpanM: direction.lateralSpanM,
    lateralTravelM: direction.lateralTravelM,
    sideSwitchM: direction.sideSwitchM,
    directionDeviationM: direction.directionDeviationM,
    axisBacktrackM: direction.axisBacktrackM,
    // 保留旧别名以兼容现有调用方；现在的值相对于线路轴线计算，
    ewSpanM: direction.lateralSpanM,
    ewZigzagM: direction.lateralTravelM,
    backtrackM: direction.axisBacktrackM
  };
}

function checkRoute(m, actualRoadKm) {
  var issues = [];
  if (m.stopCount < ROUTE_MIN_STOPS) issues.push('站点数' + m.stopCount + '<' + ROUTE_MIN_STOPS);
  if (m.people < ROUTE_MIN_PEOPLE) issues.push('人数' + m.people + '<' + ROUTE_MIN_PEOPLE);
  if (m.people > ROUTE_MAX_PEOPLE) issues.push('人数' + m.people + '>' + ROUTE_MAX_PEOPLE);
  var hasActual = actualRoadKm != null && isFinite(actualRoadKm);
  var routeKm = hasActual ? Number(actualRoadKm) : m.estRoadKm;
  if (routeKm > ROUTE_MAX_KM) issues.push((hasActual ? '实走里程' : '预估里程') + routeKm.toFixed(1) + 'km>' + ROUTE_MAX_KM);
  return issues;
}

function routeConstraintOptimizationScore(routes) {
  var violations = 0;
  var severity = 0;
  var totalRoadKm = 0;
  (routes || []).forEach(function (route) {
    var metrics = route.metrics || routeMetrics(route.stops || [], { lng: 0, lat: 0 });
    var roadKm = route.roadKm != null && isFinite(route.roadKm) ? Number(route.roadKm) : Number(metrics.estRoadKm) || 0;
    totalRoadKm += roadKm;

    if (metrics.stopCount < ROUTE_MIN_STOPS) {
      violations++;
      severity += (ROUTE_MIN_STOPS - metrics.stopCount) * 40;
    }
    if (metrics.people < ROUTE_MIN_PEOPLE) {
      violations++;
      severity += (ROUTE_MIN_PEOPLE - metrics.people) * 55;
    }
    if (metrics.people > ROUTE_MAX_PEOPLE) {
      violations++;
      severity += (metrics.people - ROUTE_MAX_PEOPLE) * 500;
    }
    if (roadKm > ROUTE_MAX_KM) {
      violations++;
      severity += (roadKm - ROUTE_MAX_KM) * 220;
    }
    var missedCount = route.missedStops ? route.missedStops.length : 0;
    if (missedCount) {
      violations += missedCount;
      severity += missedCount * 800;
    }
  });
  return { violations: violations, severity: severity, totalRoadKm: totalRoadKm };
}

function isBetterRouteConstraintScore(candidate, current) {
  if (candidate.violations !== current.violations) return candidate.violations < current.violations;
  if (candidate.severity < current.severity - 0.01) return true;
  if (candidate.severity > current.severity + 0.01) return false;
  // 约束完全相同时，只接受至少缩短20米的方案，防止高德结果的微小波动
  // 被误认为持续改善而造成无意义的重复规划。
  return candidate.totalRoadKm < current.totalRoadKm - 0.02;
}

function shouldStopConstraintReplanning(consecutiveFailures, maxFailures) {
  var limit = Math.max(1, Number(maxFailures) || 1);
  return Math.max(0, Number(consecutiveFailures) || 0) >= limit;
}

function routeAssignmentSignature(routes) {
  return (routes || []).map(function (route) {
    return (route.stops || []).map(function (stop) {
      if (stop._aid != null) return String(stop._aid);
      return Number(stop.lng).toFixed(6) + ',' + Number(stop.lat).toFixed(6) + ':' + (stop.name || '');
    }).join('>');
  }).join('||');
}

function cloneRoutesForOptimization(routes) {
  return (routes || []).map(function (route) {
    var copy = {};
    Object.keys(route).forEach(function (key) {
      if (key !== 'stops' && key !== 'metrics' && key !== 'missedStops') copy[key] = route[key];
    });
    copy.stops = (route.stops || []).slice();
    copy.metrics = Object.assign({}, route.metrics || {});
    copy.missedStops = (route.missedStops || []).slice();
    return copy;
  });
}

function worstDetourIndex(stops, dest, candidateRank) {
  if (stops.length <= 2) return -1;
  var axisStart = stops[0];
  var frame = routeAxisFrame(axisStart, dest);

  var candidates = [];
  for (var i = 0; i < stops.length; i++) {
    if (stops[i]._manualStartIndex != null) continue;
    var prev = i > 0 ? stops[i - 1] : null;
    var next = i < stops.length - 1 ? stops[i + 1] : dest;
    var detour = 0;
    if (!prev) {
      if (stops.length < 2) continue;
      next = stops[1];
      var dAlone = distance(stops[i], dest);
      var dNext = distance(next, dest) + distance(stops[i], next);
      detour = dNext - dAlone;
    } else {
      var direct = distance(prev, next);
      var via = distance(prev, stops[i]) + distance(stops[i], next);
      detour = via - direct;
    }
    // 对离开起点—终点通道的站点及相邻跳转增加额外惩罚。
    var lat = lateralOffsetM(stops[i], dest, axisStart);
    var currentCoord = routeAxisCoordinate(stops[i], dest, frame);
    var crossHop = 0;
    if (prev) crossHop += Math.abs(currentCoord.lateral - routeAxisCoordinate(prev, dest, frame).lateral);
    crossHop += Math.abs(routeAxisCoordinate(next, dest, frame).lateral - currentCoord.lateral);

    var score = detour + lat * 1.55 + crossHop * 1.05 - stops[i].people * 40;
    if (detour > 80 || lat > 1000 || crossHop > 800) candidates.push({ index: i, score: score });
  }
  candidates.sort(function (a, b) { return b.score - a.score; });
  candidateRank = Math.max(0, Number(candidateRank) || 0);
  return candidates[candidateRank] ? candidates[candidateRank].index : -1;
}

function reassignStop(unit, fromIdx, routes, dest, candidateRank) {
  var candidates = [];
  var uAng = Math.atan2(unit.lat - dest.lat, unit.lng - dest.lng);
  for (var j = 0; j < routes.length; j++) {
    if (j === fromIdx) continue;
    var trialStops = routes[j].stops.concat([unit]);
    var ordered = orderStopsNN(trialStops, dest);
    var m = routeMetrics(ordered, dest);
    if (m.people > ROUTE_MAX_PEOPLE) continue;
    if (m.estRoadKm > ROUTE_MAX_KM) continue;
    // 优先选择平均角度与容量单元方向一致的线路。
    var meanAng = 0;
    routes[j].stops.forEach(function (s) {
      meanAng += Math.atan2(s.lat - dest.lat, s.lng - dest.lng);
    });
    meanAng = routes[j].stops.length ? meanAng / routes[j].stops.length : uAng;
    var ad = Math.abs(uAng - meanAng);
    if (ad > Math.PI) ad = 2 * Math.PI - ad;
    var pen = routePenalty(m) + m.estRoadKm * 10 + ad * 2000 +
      (m.lateralSpanM || 0) * 0.18 + (m.directionDeviationM || 0) * 0.55;
    candidates.push({ routeIndex: j, penalty: pen, ordered: ordered, metrics: m });
  }
  candidates.sort(function (a, b) { return a.penalty - b.penalty; });
  candidateRank = Math.max(0, Number(candidateRank) || 0);
  var selected = candidates[candidateRank];
  if (!selected) return false;
  routes[selected.routeIndex].stops = selected.ordered;
  routes[selected.routeIndex].metrics = selected.metrics;
  delete routes[selected.routeIndex].roadKm;
  delete routes[selected.routeIndex].roadM;
  delete routes[selected.routeIndex].durationMin;
  return true;
}

// 将明显偏离线路起点—终点通道的站点移动到更合适的线路。
function fixLateralOutliers(routes, dest) {
  var list = routes.map(function (r) {
    return { stops: r.stops.slice(), metrics: r.metrics };
  });
  var changed = false;
  var guard = 0;
  while (guard++ < 40) {
    var moved = false;
    for (var ri = 0; ri < list.length; ri++) {
      var stops = list[ri].stops;
      if (stops.length <= 2) continue;
      var worstI = -1, worstLat = 0;
      for (var si = 0; si < stops.length; si++) {
        if (si === 0 || stops[si]._manualStartIndex != null) continue;
        var lat = lateralOffsetM(stops[si], dest, stops[0]);
        if (lat > worstLat) { worstLat = lat; worstI = si; }
      }
      // 只移动明确的离群点。
      if (worstI < 0 || worstLat < 1400) continue;
      if (list[ri].metrics.people - stops[worstI].people < ROUTE_MIN_PEOPLE && stops.length > 3) {
        // 如果角度分散较大，仍尝试进行调整。
        if ((list[ri].metrics.angularSpread || 0) < Math.PI / 3) continue;
      }
      var unit = stops[worstI];
      var fromStops = stops.slice(0, worstI).concat(stops.slice(worstI + 1));
      var oldPen = routePenalty(list[ri].metrics);
      var bestJ = -1, bestGain = 0, bestTo = null, bestToM = null, bestFrom = null, bestFromM = null;
      for (var j = 0; j < list.length; j++) {
        if (j === ri) continue;
        if (list[j].metrics.people + unit.people > ROUTE_MAX_PEOPLE) continue;
        var toStops = list[j].stops.concat([unit]);
        var ordTo = orderStopsNN(toStops, dest);
        var mTo = routeMetrics(ordTo, dest);
        if (mTo.estRoadKm > ROUTE_MAX_KM) continue;
        if ((mTo.lateralMaxM || 0) > worstLat + 200) continue;
        var ordFrom = orderStopsNN(fromStops, dest);
        var mFrom = routeMetrics(ordFrom, dest);
        var gain = oldPen + routePenalty(list[j].metrics) - routePenalty(mFrom) - routePenalty(mTo);
        if (gain > bestGain + 1) {
          bestGain = gain;
          bestJ = j;
          bestTo = ordTo; bestToM = mTo;
          bestFrom = ordFrom; bestFromM = mFrom;
        }
      }
      if (bestJ >= 0) {
        list[ri] = { stops: bestFrom, metrics: bestFromM };
        list[bestJ] = { stops: bestTo, metrics: bestToM };
        moved = true;
        changed = true;
        break;
      }
    }
    if (!moved) break;
  }
  return changed ? list : routes;
}

function trimDetourStops(rt, dest, allRoutes, rtIdx, alternativeIndex) {
  var stops = rt.stops;
  if (stops.length <= 2) return false;
  alternativeIndex = Math.max(0, Number(alternativeIndex) || 0);
  // 三次连续尝试依次采用：首选绕行点/首选目标线路、首选绕行点/次选目标线路、
  // 次选绕行点/首选目标线路，避免反复生成完全相同的候选方案。
  var detourRank = Math.floor(alternativeIndex / 2);
  var destinationRank = alternativeIndex % 2;
  var worstIdx = worstDetourIndex(stops, dest, detourRank);
  if (worstIdx < 0) return false;

  var unit = stops[worstIdx];
  var nextStops = stops.slice(0, worstIdx).concat(stops.slice(worstIdx + 1));
  var ordered = orderStopsNN(nextStops, dest);
  var nextMetrics = routeMetrics(ordered, dest);

  // 修复超长线路时，不能让原线路变成低于最低容量的线路。
  if (nextMetrics.people < ROUTE_MIN_PEOPLE || nextMetrics.stopCount < ROUTE_MIN_STOPS) return false;

  // 将绕行站点移动到其他线路；每个容量单元都必须保持分配。
  if (allRoutes && rtIdx != null) {
    var moved = reassignStop(unit, rtIdx, allRoutes, dest, destinationRank);
    if (moved) {
      rt.stops = ordered;
      rt.metrics = nextMetrics;
      delete rt.roadKm;
      delete rt.roadM;
      delete rt.durationMin;
      return true;
    }
  }
  return false;
}

function partitionByCut(sorted, numRoutes, totalPeople) {
  var routes = [];
  for (var r = 0; r < numRoutes; r++) routes.push([]);
  var ri = 0, load = 0;
  var remainPeople = totalPeople;
  var target = totalPeople / numRoutes;
  for (var i = 0; i < sorted.length; i++) {
    if (ri < numRoutes - 1 && load >= target && routes[ri].length > 0) {
      // 如果下一个容量单元很小且会导致末端线路接近空载，则避免在此处切分。
      remainPeople -= load;
      ri++;
      load = 0;
      target = remainPeople / (numRoutes - ri);
    }
    routes[ri].push(sorted[i]);
    load += sorted[i].people;
  }
  return routes;
}

function partitionByCapacity(sorted, numRoutes, maxPeople) {
  var routes = [];
  for (var r = 0; r < numRoutes; r++) routes.push([]);
  var loads = new Array(numRoutes).fill(0);
  sorted.forEach(function (u) {
    var best = -1, bestLoad = Infinity;
    for (var r = 0; r < numRoutes; r++) {
      if (loads[r] + u.people > maxPeople && loads[r] > 0) continue;
      // 优先选择角度上最近邻所在的线路。
      var score = loads[r];
      if (routes[r].length) {
        var last = routes[r][routes[r].length - 1];
        score += distance(last, u) * 0.001;
      }
      if (score < bestLoad) { bestLoad = score; best = r; }
    }
    if (best < 0) {
      best = 0;
      for (var r2 = 1; r2 < numRoutes; r2++) {
        if (loads[r2] < loads[best]) best = r2;
      }
    }
    routes[best].push(u);
    loads[best] += u.people;
  });
  return routes;
}

function seedScore(routes, dest, evaluator) {
  var s = 0, stopCounts = [], peopleCounts = [];
  var orderedList = [];
  var evaluate = evaluator || createRouteEvaluator(dest);
  routes.forEach(function (stops) {
    if (!stops.length) { s += 1e6; orderedList.push([]); return; }
    var evaluated = evaluate(stops);
    var ordered = evaluated.stops;
    orderedList.push(ordered);
    var m = evaluated.metrics;
    s += routePenalty(m);
    stopCounts.push(m.stopCount);
    peopleCounts.push(m.people);
  });
  if (stopCounts.length) {
    s += (Math.max.apply(null, stopCounts) - Math.min.apply(null, stopCounts)) * 30;
    s += (Math.max.apply(null, peopleCounts) - Math.min.apply(null, peopleCounts)) * 15;
  }
  s += overlapPenalty(orderedList);
  return s;
}

function seedPartition(units, numRoutes, dest) {
  var n = units.length;
  if (n === 0) return [];
  numRoutes = Math.max(1, Math.min(numRoutes, n));

  units.forEach(function (u) {
    u.angle = Math.atan2(u.lat - dest.lat, u.lng - dest.lng);
    u.dist = distance(u, dest);
  });

  var totalPeople = units.reduce(function (s, u) { return s + u.people; }, 0);
  var best = null, bestSc = Infinity;
  var seedEvaluator = createRouteEvaluator(dest);

  function consider(routes) {
    // 删除空线路。
    var cleaned = routes.filter(function (r) { return r && r.length; });
    if (cleaned.length === 0) return;
    // 如果线路数量不足，除非无法避免，否则跳过此方案。
    if (cleaned.length < numRoutes && n >= numRoutes) return;
    var sc = seedScore(cleaned, dest, seedEvaluator);
    if (sc < bestSc) { bestSc = sc; best = cleaned; }
  }

  // 1）合并执行角度分区与容量扫描，同时保留“最窄通道”和“最低综合代价”候选。
  var angularCandidates = angularSectorPartition(units, numRoutes, dest, seedEvaluator);
  if (angularCandidates.narrow) consider(angularCandidates.narrow);
  if (angularCandidates.base && angularCandidates.base !== angularCandidates.narrow) consider(angularCandidates.base);

  var base = units.slice().sort(function (a, b) { return a.angle - b.angle; });

  // 2）贪心扩展分区（种子角度尽量分离）。
  consider(greedySectorSeed(units, numRoutes, dest));

  // 3）仅在必要时使用距离环作为兜底（可能混合不同出行方向）。
  var byDist = units.slice().sort(function (a, b) { return b.dist - a.dist; });
  consider(partitionByCapacity(byDist, numRoutes, ROUTE_MAX_PEOPLE));

  return best || partitionByCut(base, numRoutes, totalPeople);
}

function manualSeedPartition(units, numRoutes, dest) {
  var routes = [];
  var loads = [];
  for (var r = 0; r < numRoutes; r++) { routes.push([]); loads.push(0); }
  var starts = new Array(numRoutes);
  units.forEach(function (u) {
    if (u._manualStartIndex != null && u._manualStartIndex >= 0 && u._manualStartIndex < numRoutes) starts[u._manualStartIndex] = u;
  });
  for (var si = 0; si < numRoutes; si++) {
    if (!starts[si]) throw new Error('线路' + (si + 1) + '的手动起点未包含在可规划站点中');
    routes[si].push(starts[si]);
    loads[si] = starts[si].people;
  }

  var remaining = units.filter(function (u) { return u._manualStartIndex == null; });
  remaining.sort(function (a, b) {
    if (b.people !== a.people) return b.people - a.people;
    return distance(b, dest) - distance(a, dest);
  });
  remaining.forEach(function (u) {
    var bestRoute = -1, bestScore = Infinity;
    for (var ri = 0; ri < routes.length; ri++) {
      if (loads[ri] + u.people > ROUTE_MAX_PEOPLE) continue;
      var start = starts[ri];
      var uAng = Math.atan2(u.lat - dest.lat, u.lng - dest.lng);
      var sAng = Math.atan2(start.lat - dest.lat, start.lng - dest.lng);
      var angleDiff = Math.abs(uAng - sAng);
      if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
      var minD = Infinity;
      routes[ri].forEach(function (x) { minD = Math.min(minD, distance(x, u)); });
      var currentOrder = orderStopsNN(routes[ri], dest);
      var trialOrder = orderStopsNN(routes[ri].concat([u]), dest);
      var insertionCost = routeOrderScore(trialOrder, dest) - routeOrderScore(currentOrder, dest);
      var score = insertionCost * 2.6 + angleDiff * 1800 + minD * 0.15 + loads[ri] * 22;
      if (score < bestScore) { bestScore = score; bestRoute = ri; }
    }
    if (bestRoute < 0) {
      bestRoute = 0;
      for (var li = 1; li < loads.length; li++) if (loads[li] < loads[bestRoute]) bestRoute = li;
    }
    routes[bestRoute].push(u);
    loads[bestRoute] += u.people;
  });
  return routes;
}

function routeEvaluationKey(stops) {
  return stops.map(function (stop) {
    if (stop._aid != null) return typeof stop._aid + ':' + stop._aid;
    return Number(stop.lng).toFixed(6) + ',' + Number(stop.lat).toFixed(6) + ':' + (stop.name || '');
  }).sort().join('|');
}

function createRouteEvaluator(dest) {
  var cache = Object.create(null);
  var cacheSize = 0;
  var MAX_CACHE_ENTRIES = 4000;
  return function (stops) {
    var clean = stops.filter(Boolean);
    var key = routeEvaluationKey(clean);
    var cached = cache[key];
    if (cached) return cached;
    var ordered = orderStopsNN(clean, dest);
    var evaluated = { stops: ordered, metrics: routeMetrics(ordered, dest) };
    if (cacheSize >= MAX_CACHE_ENTRIES) {
      cache = Object.create(null);
      cacheSize = 0;
    }
    cache[key] = evaluated;
    cacheSize++;
    return evaluated;
  };
}

function manualAssignmentRouteEval(stops, dest, evaluator) {
  var evaluated = (evaluator || createRouteEvaluator(dest))(stops);
  var ordered = evaluated.stops;
  var metrics = evaluated.metrics;
  var score = constraintViolation(metrics) + routeOrderScoreFromMetrics(metrics) +
    (metrics.lateralMaxM || 0) * 0.65 + (metrics.lateralSpanM || 0) * 0.28 +
    (metrics.directionDeviationM || 0) * 0.85 + (metrics.sideSwitchM || 0) * 0.65 +
    (metrics.angularSpread || 0) * 900;
  return { stops: ordered, metrics: metrics, score: score };
}

function manualAssignmentTotalScore(routeEvals) {
  var score = 0, people = [], stopCounts = [];
  routeEvals.forEach(function (r) {
    score += r.score;
    people.push(r.metrics.people);
    stopCounts.push(r.metrics.stopCount);
  });
  if (people.length) {
    score += (Math.max.apply(null, people) - Math.min.apply(null, people)) * 80;
    score += (Math.max.apply(null, stopCounts) - Math.min.apply(null, stopCounts)) * 55;
  }
  return score;
}

// 手动起点只定义第一个站点，不代表周边所有站点的归属。
// 根据实际边际线路代价重新分配或交换非固定站点，避免位于其他线路通道上的站点
function optimizeManualStartAssignments(routes, dest) {
  var evaluate = createRouteEvaluator(dest);
  var evals = routes.map(function (r) { return manualAssignmentRouteEval(r.stops, dest, evaluate); });
  var totalScore = manualAssignmentTotalScore(evals);
  var guard = 0;
  while (guard++ < 35) {
    var best = null, bestScore = totalScore;

    // 移动一个非起点站点。
    for (var i = 0; i < evals.length; i++) {
      for (var si = 0; si < evals[i].stops.length; si++) {
        var unit = evals[i].stops[si];
        if (unit._manualStartIndex != null) continue;
        for (var j = 0; j < evals.length; j++) {
          if (i === j || evals[j].metrics.people + unit.people > ROUTE_MAX_PEOPLE) continue;
          var fromStops = evals[i].stops.slice();
          fromStops.splice(si, 1);
          var fromEval = manualAssignmentRouteEval(fromStops, dest, evaluate);
          var toEval = manualAssignmentRouteEval(evals[j].stops.concat([unit]), dest, evaluate);
          var trial = evals.slice();
          trial[i] = fromEval; trial[j] = toEval;
          var score = manualAssignmentTotalScore(trial);
          if (score + 40 < bestScore) {
            bestScore = score;
            best = { i: i, j: j, from: fromEval, to: toEval };
          }
        }
      }
    }

    // 容量不允许直接移动时，交换两个非起点站点。
    for (var a = 0; a < evals.length; a++) {
      for (var b = a + 1; b < evals.length; b++) {
        for (var ai = 0; ai < evals[a].stops.length; ai++) {
          var ua = evals[a].stops[ai];
          if (ua._manualStartIndex != null) continue;
          for (var bi = 0; bi < evals[b].stops.length; bi++) {
            var ub = evals[b].stops[bi];
            if (ub._manualStartIndex != null) continue;
            var loadA = evals[a].metrics.people - ua.people + ub.people;
            var loadB = evals[b].metrics.people - ub.people + ua.people;
            if (loadA > ROUTE_MAX_PEOPLE || loadB > ROUTE_MAX_PEOPLE) continue;
            var stopsA = evals[a].stops.slice(); stopsA[ai] = ub;
            var stopsB = evals[b].stops.slice(); stopsB[bi] = ua;
            var evalA = manualAssignmentRouteEval(stopsA, dest, evaluate);
            var evalB = manualAssignmentRouteEval(stopsB, dest, evaluate);
            var swapTrial = evals.slice();
            swapTrial[a] = evalA; swapTrial[b] = evalB;
            var swapScore = manualAssignmentTotalScore(swapTrial);
            if (swapScore + 40 < bestScore) {
              bestScore = swapScore;
              best = { i: a, j: b, from: evalA, to: evalB };
            }
          }
        }
      }
    }

    if (!best) break;
    evals[best.i] = best.from;
    evals[best.j] = best.to;
    totalScore = bestScore;
  }
  return evals.map(function (r) { return { stops: r.stops, metrics: r.metrics }; });
}

function greedySectorSeed(units, numRoutes, dest) {
  var remaining = units.slice();
  remaining.sort(function (a, b) { return b.dist - a.dist; });
  var routes = [];
  for (var r = 0; r < numRoutes; r++) routes.push([]);
  // 选择距离较远且角度分布充分分离的种子点。
  var seeds = [];
  if (remaining.length) {
    seeds.push(remaining.shift());
    routes[0].push(seeds[0]);
  }
  while (seeds.length < numRoutes && remaining.length) {
    var bestIdx = 0, bestMinAng = -1;
    for (var i = 0; i < remaining.length; i++) {
      var minAng = Infinity;
      for (var s = 0; s < seeds.length; s++) {
        var ad = Math.abs(remaining[i].angle - seeds[s].angle);
        if (ad > Math.PI) ad = 2 * Math.PI - ad;
        if (ad < minAng) minAng = ad;
      }
      // 优先角度间隔较大者，其次选择距离更远者。
      var score = minAng * 1e6 + remaining[i].dist;
      if (score > bestMinAng) { bestMinAng = score; bestIdx = i; }
    }
    seeds.push(remaining.splice(bestIdx, 1)[0]);
    routes[seeds.length - 1].push(seeds[seeds.length - 1]);
  }
  remaining.forEach(function (u) {
    var bestR = 0, bestScore = Infinity;
    for (var r = 0; r < routes.length; r++) {
      if (!routes[r].length) continue;
      var load = routes[r].reduce(function (s, x) { return s + x.people; }, 0);
      if (load + u.people > ROUTE_MAX_PEOPLE) load += 2000;

      // 当前线路的平均角度。
      var meanAng = 0;
      routes[r].forEach(function (s) { meanAng += s.angle; });
      meanAng /= routes[r].length;
      var angDiff = Math.abs(u.angle - meanAng);
      if (angDiff > Math.PI) angDiff = 2 * Math.PI - angDiff;

      var minD = Infinity;
      routes[r].forEach(function (s) {
        var d = distance(s, u);
        if (d < minD) minD = d;
      });
      // 相对于线路种子轴线的横向偏移。
      var lat = lateralOffsetM(u, dest, seeds[Math.min(r, seeds.length - 1)]);
      // 角度因素优先，以保持通道较窄。
      var score = angDiff * 4500 + lat * 1.2 + minD * 0.25 + load * 25;
      if (score < bestScore) { bestScore = score; bestR = r; }
    }
    routes[bestR].push(u);
  });
  return routes;
}

// 纯角度均衡分区，使每条线路保持在较窄的径向通道内。
function angularSectorPartition(units, numRoutes, dest, evaluator) {
  if (!units.length) return { narrow: null, base: null };
  var sorted = units.slice().sort(function (a, b) { return a.angle - b.angle; });
  var totalPeople = sorted.reduce(function (s, u) { return s + u.people; }, 0);
  var bestNarrow = null, bestNarrowScore = Infinity;
  var bestBase = null, bestBaseScore = Infinity;
  var n = sorted.length;
  var narrowSteps = Math.min(n, Math.max(numRoutes * 6, 24));
  var baseSteps = Math.min(n, Math.max(numRoutes * 5, 20));
  var offsets = {};
  for (var nr = 0; nr < narrowSteps; nr++) offsets[Math.floor(nr * n / narrowSteps)] = true;
  for (var br = 0; br < baseSteps; br++) offsets[Math.floor(br * n / baseSteps)] = true;
  Object.keys(offsets).forEach(function (offsetKey) {
    var offset = Number(offsetKey);
    var rotArr = sorted.slice(offset).concat(sorted.slice(0, offset));
    // 在保持角度连续的同时按人数切分。
    var routes = partitionByCut(rotArr, numRoutes, totalPeople);
    // 在角度顺序内进一步尝试考虑容量的方案。
    var routes2 = partitionByCapacity(rotArr, numRoutes, ROUTE_MAX_PEOPLE);
    [routes, routes2].forEach(function (rs) {
      var cleaned = rs.filter(function (r) { return r && r.length; });
      if (!cleaned.length) return;
      if (cleaned.length < numRoutes && n >= numRoutes) return;
      var sc = seedScore(cleaned, dest, evaluator);
      if (sc < bestBaseScore) { bestBaseScore = sc; bestBase = cleaned; }
      // 平均角度分散越小，给予的奖励越高。
      cleaned.forEach(function (stops) {
        if (stops.length < 2) return;
        var angs = stops.map(function (s) { return s.angle; });
        angs.sort(function (a, b) { return a - b; });
        var span = angs[angs.length - 1] - angs[0];
        sc += span * 800;
      });
      if (sc < bestNarrowScore) { bestNarrowScore = sc; bestNarrow = cleaned; }
    });
  });
  return { narrow: bestNarrow, base: bestBase };
}

function refreshRouteMeta(list, dest, evaluator) {
  var evaluate = evaluator || createRouteEvaluator(dest);
  for (var i = 0; i < list.length; i++) {
    var evaluated = evaluate(list[i]);
    list[i] = evaluated.stops;
    list[i]._m = evaluated.metrics;
  }
}

function balanceRoutes(routes, dest) {
  var list = routes.map(function (stops) { return stops.slice(); });
  var evaluate = createRouteEvaluator(dest);
  refreshRouteMeta(list, dest, evaluate);

  var guard = 0;
  while (guard++ < 600) {
    var bestMove = null, bestGain = 0;
    var oldBalance = balancePenalty(list);
    var oldOverlap = overlapPenalty(list);
    var oldP = oldBalance + oldOverlap;
    list.forEach(function (route) { oldP += routePenalty(route._m); });

    function changedPenalty(i, stopsI, metricsI, j, stopsJ, metricsJ) {
      var penalty = oldP - routePenalty(list[i]._m) - routePenalty(list[j]._m) +
        routePenalty(metricsI) + routePenalty(metricsJ);
      penalty += balancePenaltyWithChanges(list, i, metricsI, j, metricsJ) - oldBalance;
      penalty += overlapPenaltyWithChanges(list, i, stopsI, j, stopsJ, oldOverlap) - oldOverlap;
      return penalty;
    }

    // 移动：将一个容量单元从 i 移到 j。
    for (var i = 0; i < list.length; i++) {
      if (list[i].length <= 1) continue;
      for (var si = 0; si < list[i].length; si++) {
        var unit = list[i][si];
        if (unit._manualStartIndex != null) continue;
        for (var j = 0; j < list.length; j++) {
          if (i === j) continue;
          if (list[j]._m.people + unit.people > ROUTE_MAX_PEOPLE) continue;
          var from = list[i].slice();
          from.splice(si, 1);
          var to = list[j].concat([unit]);
          var fromEval = evaluate(from);
          var toEval = evaluate(to);
          var mFrom = fromEval.metrics;
          var mTo = toEval.metrics;
          var gain = oldP - changedPenalty(i, fromEval.stops, mFrom, j, toEval.stops, mTo);
          if (gain > bestGain + 1e-6) {
            bestGain = gain;
            bestMove = { type: 'relocate', i: i, j: j, from: fromEval.stops, to: toEval.stops, mFrom: mFrom, mTo: mTo };
          }
        }
      }
    }

    // 交换：互换 i 与 j 之间的一个容量单元。
    for (var i = 0; i < list.length; i++) {
      for (var j = i + 1; j < list.length; j++) {
        for (var si = 0; si < list[i].length; si++) {
          for (var sj = 0; sj < list[j].length; sj++) {
            var ui = list[i][si];
            var uj = list[j][sj];
            if (ui._manualStartIndex != null || uj._manualStartIndex != null) continue;
            var loadI = list[i]._m.people - ui.people + uj.people;
            var loadJ = list[j]._m.people - uj.people + ui.people;
            if (loadI > ROUTE_MAX_PEOPLE || loadJ > ROUTE_MAX_PEOPLE) continue;
            var fromI = list[i].slice();
            fromI.splice(si, 1);
            fromI.push(uj);
            var fromJ = list[j].slice();
            fromJ.splice(sj, 1);
            fromJ.push(ui);
            var evalI = evaluate(fromI);
            var evalJ = evaluate(fromJ);
            var mI = evalI.metrics;
            var mJ = evalJ.metrics;
            var gain = oldP - changedPenalty(i, evalI.stops, mI, j, evalJ.stops, mJ);
            if (gain > bestGain + 1e-6) {
              bestGain = gain;
              bestMove = { type: 'swap', i: i, j: j, from: evalI.stops, to: evalJ.stops, mFrom: mI, mTo: mJ };
            }
          }
        }
      }
    }

    if (!bestMove) break;
    list[bestMove.i] = bestMove.from;
    list[bestMove.i]._m = bestMove.mFrom;
    list[bestMove.j] = bestMove.to;
    list[bestMove.j]._m = bestMove.mTo;
  }

  return list.map(function (stops) {
    var evaluated = evaluate(stops);
    return { stops: evaluated.stops, metrics: evaluated.metrics };
  }).filter(function (r) { return r.stops.length > 0; });
}

function constraintViolation(m) {
  var p = 0;
  if (m.people > ROUTE_MAX_PEOPLE) p += (m.people - ROUTE_MAX_PEOPLE) * 10000000;
  if (m.people < ROUTE_MIN_PEOPLE) p += (ROUTE_MIN_PEOPLE - m.people) * 300000;
  if (m.stopCount < ROUTE_MIN_STOPS) p += (ROUTE_MIN_STOPS - m.stopCount) * 120000;
  if (m.estRoadKm > ROUTE_MAX_KM) p += (m.estRoadKm - ROUTE_MAX_KM) * 500000;
  return p;
}

function makeRoute(stops, dest, evaluator) {
  var evaluated = (evaluator || createRouteEvaluator(dest))(stops);
  return { stops: evaluated.stops, metrics: evaluated.metrics };
}

// 在不丢失任何上车点的前提下修复硬约束。当两条低载线路可以合并为合规线路时，
// 线路数量可以减少。
function repairHardConstraints(routes, dest) {
  var evaluate = createRouteEvaluator(dest);
  var list = routes.map(function (r) { return makeRoute(r.stops, dest, evaluate); })
    .filter(function (r) { return r.stops.length > 0; });
  var guard = 0;

  while (guard++ < 120) {
    var best = null;
    var bestGain = 0;
    var bestSoftPenalty = Infinity;

    // 在线路之间移动一个完整的容量单元。
    for (var i = 0; i < list.length; i++) {
      if (list[i].stops.length <= 1) continue;
      for (var si = 0; si < list[i].stops.length; si++) {
        var unit = list[i].stops[si];
        if (unit._manualStartIndex != null) continue;
        for (var j = 0; j < list.length; j++) {
          if (i === j || list[j].metrics.people + unit.people > ROUTE_MAX_PEOPLE) continue;
          var fromStops = list[i].stops.slice();
          fromStops.splice(si, 1);
          var from = makeRoute(fromStops, dest, evaluate);
          var to = makeRoute(list[j].stops.concat([unit]), dest, evaluate);
          if (to.metrics.estRoadKm > ROUTE_MAX_KM + 0.01) continue;

           var before = constraintViolation(list[i].metrics) + constraintViolation(list[j].metrics);
           var after = constraintViolation(from.metrics) + constraintViolation(to.metrics);
           var gain = before - after;
           var softPenalty = routePenalty(from.metrics) + routePenalty(to.metrics);
           if (gain > bestGain + 1 || (gain > 1 && Math.abs(gain - bestGain) <= 1 && softPenalty < bestSoftPenalty)) {
             bestGain = gain;
             bestSoftPenalty = softPenalty;
             best = { type: 'move', i: i, j: j, from: from, to: to };
          }
        }
      }
    }

    // 当合并可以消除最低人数或最低站点数违规时执行合并。
    for (var a = 0; a < list.length; a++) {
      for (var b = a + 1; b < list.length; b++) {
        var aFixed = list[a].stops.some(function (s) { return s._manualStartIndex != null; });
        var bFixed = list[b].stops.some(function (s) { return s._manualStartIndex != null; });
        if (aFixed && bFixed) continue;
        if (list[a].metrics.people + list[b].metrics.people > ROUTE_MAX_PEOPLE) continue;
        var merged = makeRoute(list[a].stops.concat(list[b].stops), dest, evaluate);
        if (merged.metrics.estRoadKm > ROUTE_MAX_KM + 0.01) continue;
        var mergeBefore = constraintViolation(list[a].metrics) + constraintViolation(list[b].metrics);
        var mergeAfter = constraintViolation(merged.metrics);
        var mergeGain = mergeBefore - mergeAfter;
        var mergeSoftPenalty = routePenalty(merged.metrics);
        if (mergeGain > bestGain + 1 || (mergeGain > 1 && Math.abs(mergeGain - bestGain) <= 1 && mergeSoftPenalty < bestSoftPenalty)) {
          bestGain = mergeGain;
          bestSoftPenalty = mergeSoftPenalty;
          best = { type: 'merge', i: a, j: b, merged: merged };
        }
      }
    }

    if (!best) break;
    if (best.type === 'move') {
      list[best.i] = best.from;
      list[best.j] = best.to;
    } else {
      list[best.i] = best.merged;
      list.splice(best.j, 1);
    }
  }
  return list;
}

function routePenalty(m) {
  var p = 0;
  if (m.people < ROUTE_MIN_PEOPLE) p += (ROUTE_MIN_PEOPLE - m.people) * 1200;
  if (m.people > ROUTE_MAX_PEOPLE) p += (m.people - ROUTE_MAX_PEOPLE) * 20000;
  if (m.stopCount < ROUTE_MIN_STOPS) p += (ROUTE_MIN_STOPS - m.stopCount) * 600;
  if (m.estRoadKm > ROUTE_MAX_KM) p += (m.estRoadKm - ROUTE_MAX_KM) * 5000;
  p += Math.abs(m.people - (ROUTE_MIN_PEOPLE + ROUTE_MAX_PEOPLE) / 2) * 4;
  if (m.dispersionM > 2000) p += (m.dispersionM - 2000) * 0.15;
  // 窄角度分区：25 度起进行软惩罚，超过 45 度视为严重偏离。
  var angDeg = (m.angularSpread || 0) * 180 / Math.PI;
  if (angDeg > 25) p += (angDeg - 25) * 40;
  if (angDeg > 45) p += (angDeg - 45) * 120;
  if (angDeg > 70) p += (angDeg - 70) * 250;
  // 围绕实际起点—终点轴线的宽度（适用于任意地理方向）。
  var lateralSpan = m.lateralSpanM || m.ewSpanM || 0;
  if (lateralSpan > 1200) p += (lateralSpan - 1200) * 0.35;
  if (lateralSpan > 2600) p += (lateralSpan - 2600) * 0.8;
  var latMax = m.lateralMaxM || 0;
  if (latMax > 900) p += (latMax - 900) * 0.45;
  if (latMax > 2200) p += (latMax - 2200) * 0.95;
  // 强烈抑制反复左右穿越、横向行驶，以及沿线路主轴远离终点的路段。
  p += (m.lateralTravelM || m.ewZigzagM || 0) * 0.24;
  p += (m.directionDeviationM || 0) * 0.8;
  p += (m.sideSwitchM || 0) * 0.7;
  p += (m.axisBacktrackM || m.backtrackM || 0) * 0.75;
  // 优先选择紧凑的径向线路。
  p += m.estRoadKm * 10;
  return p;
}

function balancePenalty(list) {
  var stopCounts = list.map(function (r) { return (r._m ? r._m.stopCount : 0); });
  var peopleCounts = list.map(function (r) { return (r._m ? r._m.people : 0); });
  if (!stopCounts.length) return 0;
  var maxS = Math.max.apply(null, stopCounts);
  var minS = Math.min.apply(null, stopCounts);
  var maxP = Math.max.apply(null, peopleCounts);
  var minP = Math.min.apply(null, peopleCounts);
  return (maxS - minS) * 35 + (maxP - minP) * 25;
}

function balancePenaltyWithChanges(list, firstIndex, firstMetrics, secondIndex, secondMetrics) {
  var minStops = Infinity, maxStops = -Infinity, minPeople = Infinity, maxPeople = -Infinity;
  for (var i = 0; i < list.length; i++) {
    var metrics = i === firstIndex ? firstMetrics : (i === secondIndex ? secondMetrics : list[i]._m);
    if (!metrics) continue;
    if (metrics.stopCount < minStops) minStops = metrics.stopCount;
    if (metrics.stopCount > maxStops) maxStops = metrics.stopCount;
    if (metrics.people < minPeople) minPeople = metrics.people;
    if (metrics.people > maxPeople) maxPeople = metrics.people;
  }
  if (minStops === Infinity) return 0;
  return (maxStops - minStops) * 35 + (maxPeople - minPeople) * 25;
}

function routePairOverlapPenalty(stopsA, stopsB) {
  var penalty = 0;
  var PROXIMITY_M = 300;
  if (!stopsA || !stopsA.length || !stopsB || !stopsB.length) return 0;
  for (var ai = 0; ai < stopsA.length; ai++) {
    var sa = stopsA[ai];
    if (!sa || sa.lng == null) continue;
    for (var bj = 0; bj < stopsB.length; bj++) {
      var sb = stopsB[bj];
      if (!sb || sb.lng == null) continue;
      var d = distance(sa, sb);
      if (d < PROXIMITY_M) penalty += 100 * (1 - d / PROXIMITY_M);
    }
  }
  return penalty;
}

function overlapPenalty(list) {
  var penalty = 0;
  for (var i = 0; i < list.length; i++) {
    var stopsA = list[i];
    if (!stopsA || !stopsA.length) continue;
    for (var j = i + 1; j < list.length; j++) {
      var stopsB = list[j];
      penalty += routePairOverlapPenalty(stopsA, stopsB);
    }
  }
  return penalty;
}

function overlapPenaltyWithChanges(list, firstIndex, firstStops, secondIndex, secondStops, currentPenalty) {
  var penalty = currentPenalty;
  for (var i = 0; i < list.length; i++) {
    if (i === firstIndex || i === secondIndex) continue;
    penalty -= routePairOverlapPenalty(list[firstIndex], list[i]);
    penalty -= routePairOverlapPenalty(list[secondIndex], list[i]);
    penalty += routePairOverlapPenalty(firstStops, list[i]);
    penalty += routePairOverlapPenalty(secondStops, list[i]);
  }
  penalty -= routePairOverlapPenalty(list[firstIndex], list[secondIndex]);
  penalty += routePairOverlapPenalty(firstStops, secondStops);
  return penalty;
}

function planRoutes(numRoutes, dest, preparedUnits, trimInfo) {
  var units = preparedUnits ? preparedUnits.slice() : expandCapacityUnits(getPickupPoints());
  if (units.length === 0) throw new Error('无可用上车点');

  dest._aid = 'dest';

  var rawTotalPeople = trimInfo ? trimInfo.rawTotalPeople : units.reduce(function (s, u) { return s + u.people; }, 0);
  var removedUnits = trimInfo ? trimInfo.removed : [];
  var removedPeople = removedUnits.reduce(function (s, u) { return s + u.people; }, 0);
  var totalPeople = units.reduce(function (s, u) { return s + u.people; }, 0);
  var totalStops = units.reduce(function (s, u) { return s + u.stopCount; }, 0);
  var minByPeople = Math.ceil(totalPeople / ROUTE_MAX_PEOPLE);
  var maxByPeople = Math.floor(totalPeople / ROUTE_MIN_PEOPLE) || 1;
  var maxByStops = Math.floor(totalStops / ROUTE_MIN_STOPS) || 1;
  var manualStarts = units.filter(function (u) { return u._manualStartIndex != null; });
  var hasManualStarts = manualStarts.length > 0;

  // 容量不足已通过剔除处理；这里保持用户请求的车辆数。
  var feasibleMin = Math.max(1, minByPeople);
  var naturalMax = Math.min(units.length, maxByPeople, maxByStops);
  var constraintBandConflict = naturalMax < feasibleMin;
  var feasibleMax = constraintBandConflict ? feasibleMin : naturalMax;
  if (hasManualStarts) {
    numRoutes = manualStarts.length;
  } else {
    if (numRoutes < feasibleMin) numRoutes = feasibleMin;
    if (numRoutes > feasibleMax) numRoutes = feasibleMax;
  }
  numRoutes = Math.max(1, Math.min(numRoutes, units.length));

  var seeded = hasManualStarts ? manualSeedPartition(units.slice(), numRoutes, dest) : seedPartition(units.slice(), numRoutes, dest);
  var balanced = balanceRoutes(seeded, dest);

  // 将横向离群点拉回更合适的起点—终点通道。
  balanced = fixLateralOutliers(balanced, dest);
  // 横向修复后重新均衡线路。
  balanced = balanceRoutes(balanced.map(function (r) { return r.stops; }), dest);
  balanced = fixLateralOutliers(balanced, dest);

  // 若仍存在硬约束违规，则进行第二轮修复。
  var hasHard = balanced.some(function (r) {
    return r.metrics.people > ROUTE_MAX_PEOPLE || r.metrics.estRoadKm > ROUTE_MAX_KM ||
      (r.metrics.angularSpread || 0) > Math.PI * 0.6;
  });
  if (hasHard) {
    balanced = balanceRoutes(balanced.map(function (r) { return r.stops; }), dest);
    balanced = fixLateralOutliers(balanced, dest);
  }

  // 最终硬约束修复。可以合并低载线路，但绝不丢失容量单元。
  balanced = repairHardConstraints(balanced, dest);
  if (hasManualStarts) balanced = optimizeManualStartAssignments(balanced, dest);

  if (hasManualStarts) {
    balanced.sort(function (a, b) {
      var ai = a.stops.length && a.stops[0]._manualStartIndex != null ? a.stops[0]._manualStartIndex : 9999;
      var bi = b.stops.length && b.stops[0]._manualStartIndex != null ? b.stops[0]._manualStartIndex : 9999;
      return ai - bi;
    });
  } else {
    balanced.sort(function (a, b) { return b.metrics.people - a.metrics.people; });
  }
  totalPeople = balanced.reduce(function (s, r) { return s + r.metrics.people; }, 0);
  totalStops = balanced.reduce(function (s, r) { return s + r.metrics.stopCount; }, 0);

  return {
    routes: balanced,
    numRoutes: balanced.length,
    totalPeople: totalPeople,
    totalStops: totalStops,
    suggestedMin: minByPeople,
    suggestedMax: maxByPeople,
    dest: dest,
    rawTotalPeople: rawTotalPeople,
    removedCount: removedUnits.length,
    removedPeople: removedPeople,
    removedNames: removedUnits.map(function (u) { return u.name; }),
    coverageComplete: totalPeople === rawTotalPeople - removedPeople,
    constraintBandConflict: constraintBandConflict,
    manualStartMode: hasManualStarts
  };
}
