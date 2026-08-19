// 上车点聚合领域逻辑。本文件不直接更新页面。
// ---- 最小覆盖圆 ----
function circleFrom2(a, b) {
  var cx = (a.lng + b.lng) / 2, cy = (a.lat + b.lat) / 2;
  return { lng: cx, lat: cy, r: distance({ lng: cx, lat: cy }, a) };
}

function circleFrom3(a, b, c) {
  var d = 2 * (a.lng * (b.lat - c.lat) + b.lng * (c.lat - a.lat) + c.lng * (a.lat - b.lat));
  if (Math.abs(d) < 1e-12) return circleFrom2(a, b);
  var ux = ((a.lng * a.lng + a.lat * a.lat) * (b.lat - c.lat) +
    (b.lng * b.lng + b.lat * b.lat) * (c.lat - a.lat) +
    (c.lng * c.lng + c.lat * c.lat) * (a.lat - b.lat)) / d;
  var uy = ((a.lng * a.lng + a.lat * a.lat) * (c.lng - b.lng) +
    (b.lng * b.lng + b.lat * b.lat) * (a.lng - c.lng) +
    (c.lng * c.lng + c.lat * c.lat) * (b.lng - a.lng)) / d;
  return { lng: ux, lat: uy, r: distance({ lng: ux, lat: uy }, a) };
}

function trivialCircle(pts) {
  if (pts.length === 0) return { lng: 0, lat: 0, r: 0 };
  if (pts.length === 1) return { lng: pts[0].lng, lat: pts[0].lat, r: 0 };
  if (pts.length === 2) return circleFrom2(pts[0], pts[1]);
  if (pts.length === 3) return circleFrom3(pts[0], pts[1], pts[2]);
  var best = null;
  for (var i = 0; i < pts.length; i++) {
    for (var j = i + 1; j < pts.length; j++) {
      var c2 = circleFrom2(pts[i], pts[j]);
      if (pts.every(function (p) { return distance(c2, p) <= c2.r + 1e-6; }) && (!best || c2.r < best.r)) best = c2;
      for (var k = j + 1; k < pts.length; k++) {
        var c3 = circleFrom3(pts[i], pts[j], pts[k]);
        if (pts.every(function (p) { return distance(c3, p) <= c3.r + 1e-6; }) && (!best || c3.r < best.r)) best = c3;
      }
    }
  }
  return best || circleFrom2(pts[0], pts[1]);
}

function welzl(pts, R, n) {
  if (n === undefined) n = pts.length;
  if (R === undefined) R = [];
  if (n === 0 || R.length === 3) return trivialCircle(R);
  var p = pts[n - 1];
  var c = welzl(pts, R.slice(), n - 1);
  if (distance(c, p) <= c.r + 1e-6) return c;
  var r2 = R.slice();
  r2.push(p);
  return welzl(pts, r2, n - 1);
}

function maxDistTo(center, indices, stops) {
  var maxR = 0;
  for (var i = 0; i < indices.length; i++) {
    var d = distance(center, stops[indices[i]]);
    if (d > maxR) maxR = d;
  }
  return maxR;
}

function mec(indices, stops) {
  var pts = indices.map(function (i) { return stops[i]; });
  if (pts.length === 0) return { lng: 0, lat: 0, r: 0 };
  if (pts.length === 1) return { lng: pts[0].lng, lat: pts[0].lat, r: 0 };
  var shuffled = pts.slice();
  for (var i = shuffled.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t;
  }
  var c = welzl(shuffled);
  c.r = maxDistTo(c, indices, stops);
  return c;
}

function weightedCenter(indices, stops) {
  var tw = 0, lng = 0, lat = 0;
  indices.forEach(function (i) {
    var w = Math.max(1, stops[i].count);
    tw += w;
    lng += stops[i].lng * w;
    lat += stops[i].lat * w;
  });
  if (tw === 0) return mec(indices, stops);
  var c = { lng: lng / tw, lat: lat / tw, r: 0 };
  c.r = maxDistTo(c, indices, stops);
  return c;
}

function clusterCount(indices, stops) {
  return indices.reduce(function (s, i) { return s + stops[i].count; }, 0);
}

function canFit(indices, stops, maxDist) {
  if (indices.length <= 1) return true;
  return mec(indices, stops).r <= maxDist + 1;
}

function bestCenter(indices, stops, maxDist) {
  var w = weightedCenter(indices, stops);
  if (w.r <= maxDist + 1) return w;
  return mec(indices, stops);
}

// ---- 阶段一：贪心聚类并迭代剔除 ----
function greedyCluster(stops, maxDist) {
  var n = stops.length;
  var maxPair = maxDist * 2;
  var adj = [];
  for (var i = 0; i < n; i++) {
    adj[i] = [];
    for (var j = 0; j < n; j++) {
      if (i !== j && distance(stops[i], stops[j]) <= maxPair) adj[i].push(j);
    }
  }

  var covered = new Array(n).fill(false);
  var clusters = [];

  while (true) {
    var bestIdx = -1, bestDeg = -1;
    for (var i = 0; i < n; i++) {
      if (covered[i]) continue;
      var deg = 0;
      adj[i].forEach(function (j) { if (!covered[j]) deg++; });
      if (deg > bestDeg || (deg === bestDeg && bestIdx >= 0 && stops[i].count > stops[bestIdx].count)) {
        bestDeg = deg;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;

    var candidates = [bestIdx];
    adj[bestIdx].forEach(function (j) {
      if (!covered[j]) candidates.push(j);
    });

    // 反复剔除最远点，直到最小覆盖圆满足限制。
    while (candidates.length > 1) {
      var circle = mec(candidates, stops);
      if (circle.r <= maxDist + 1) break;
      var farIdx = 0, farDist = -1;
      for (var ci = 0; ci < candidates.length; ci++) {
        if (candidates[ci] === bestIdx) continue;
        var d = distance(circle, stops[candidates[ci]]);
        if (d > farDist) { farDist = d; farIdx = ci; }
      }
      if (candidates[farIdx] === bestIdx) {
        // 理论上不应发生；兜底删除最后一个非种子点。
        for (var ci = candidates.length - 1; ci >= 0; ci--) {
          if (candidates[ci] !== bestIdx) { candidates.splice(ci, 1); break; }
        }
      } else {
        candidates.splice(farIdx, 1);
      }
    }

    candidates.forEach(function (i) { covered[i] = true; });
    clusters.push({ indices: candidates.slice() });
  }
  return clusters;
}

var BOARDING_MERGE_DIST = 150;

// ---- 阶段二：合并相邻聚类（属于同一覆盖区域） ----
function mergeNearby(clusters, stops, maxDist) {
  var list = clusters.map(function (c) {
    return { indices: c.indices.slice() };
  });

  var merged = true;
  while (merged) {
    merged = false;
    list.forEach(function (c) {
      c.center = bestCenter(c.indices, stops, maxDist);
      c.count = clusterCount(c.indices, stops);
    });

    var bestPair = null, bestDist = Infinity;
    for (var i = 0; i < list.length; i++) {
      for (var j = i + 1; j < list.length; j++) {
        var d = distance(list[i].center, list[j].center);
        if (d > maxDist * 2) continue;
        var combined = list[i].indices.concat(list[j].indices);
        if (!canFit(combined, stops, maxDist)) continue;
        if (d < bestDist) {
          bestDist = d;
          bestPair = [i, j];
        }
      }
    }

    if (bestPair) {
      var a = bestPair[0], b = bestPair[1];
      list[a].indices = list[a].indices.concat(list[b].indices);
      list.splice(b, 1);
      merged = true;
    }
  }
  return list;
}

// ---- 阶段三：将小聚类吸收到最近邻（不丢失人员） ----
function absorbSmall(clusters, stops, maxDist, minP) {
  if (!minP || minP <= 0) return { clusters: clusters, unabsorbed: 0 };

  var list = clusters.map(function (c) {
    return { indices: c.indices.slice(), stuck: false };
  });

  var guard = 0;
  while (guard++ < 1000) {
    list.forEach(function (c) {
      c.center = bestCenter(c.indices, stops, maxDist);
      c.count = clusterCount(c.indices, stops);
    });

    var smallIdx = -1, smallCount = Infinity;
    for (var i = 0; i < list.length; i++) {
      if (list[i].stuck) continue;
      if (list[i].count < minP && list[i].count < smallCount) {
        smallCount = list[i].count;
        smallIdx = i;
      }
    }
    if (smallIdx < 0) break;

    var small = list[smallIdx];
    var bestJ = -1, bestD = Infinity;
    for (var j = 0; j < list.length; j++) {
      if (j === smallIdx) continue;
      var combined = small.indices.concat(list[j].indices);
      if (!canFit(combined, stops, maxDist)) continue;
      var d = distance(small.center, list[j].center);
      if (d < bestD) { bestD = d; bestJ = j; }
    }

    if (bestJ >= 0) {
      list[bestJ].indices = list[bestJ].indices.concat(small.indices);
      list[bestJ].stuck = false;
      list.splice(smallIdx, 1);
    } else {
      list[smallIdx].stuck = true;
    }
  }

  var unabsorbed = 0;
  list.forEach(function (c) {
    c.count = clusterCount(c.indices, stops);
    if (c.count < minP) unabsorbed++;
  });
  return { clusters: list, unabsorbed: unabsorbed };
}

function pickBoardingStop(indices, stops, allStops, center, maxDist) {
  var best = null, bestScore = Infinity, bestDist = Infinity;
  allStops.forEach(function (s) {
    var maxWalk = 0, totalWalk = 0;
    for (var i = 0; i < indices.length; i++) {
      var d = distance(s, stops[indices[i]]);
      if (d > maxWalk) maxWalk = d;
      totalWalk += d * stops[indices[i]].count;
    }
    var dCenter = distance(s, center);
    var score = (maxWalk <= maxDist + 1 ? 0 : 1e12 + maxWalk) + totalWalk + dCenter * 0.01;
    if (score < bestScore) {
      bestScore = score;
      best = s;
      bestDist = dCenter;
    }
  });
  return { stop: best, dist: bestDist };
}

function enrichCluster(c, stops, allStops, maxDist, minP) {
  var center = bestCenter(c.indices, stops, maxDist);
  var tc = clusterCount(c.indices, stops);
  var board = pickBoardingStop(c.indices, stops, allStops, center, maxDist);
  return {
    center: center,
    boardingStop: board.stop,
    distToStop: Math.round(board.dist),
    totalCount: tc,
    stopNames: c.indices.map(function (i) { return stops[i].name; }),
    stopCount: c.indices.length,
    indices: c.indices.slice(),
    belowMin: minP > 0 && tc < minP
  };
}

// ---- 阶段四：合并 150 米范围内的上车点 ----
function mergeCloseBoarding(results, stops, allStops, maxDist, minP, mergeDist) {
  var list = results.map(function (r) {
    return {
      indices: r.indices.slice(),
      boardingStop: r.boardingStop,
      center: r.center
    };
  });

  var guard = 0;
  while (guard++ < 1000) {
    var bestPair = null, bestD = Infinity;
    for (var i = 0; i < list.length; i++) {
      var bi = list[i].boardingStop || list[i].center;
      if (!bi) continue;
      for (var j = i + 1; j < list.length; j++) {
        var bj = list[j].boardingStop || list[j].center;
        if (!bj) continue;
        var d = distance(bi, bj);
        if (d < mergeDist && d < bestD) {
          bestD = d;
          bestPair = [i, j];
        }
      }
    }
    if (!bestPair) break;

    var a = bestPair[0], b = bestPair[1];
    var combined = { indices: list[a].indices.concat(list[b].indices) };
    var enriched = enrichCluster(combined, stops, allStops, maxDist, minP);
    list[a] = {
      indices: enriched.indices,
      boardingStop: enriched.boardingStop,
      center: enriched.center,
      _enriched: enriched
    };
    list.splice(b, 1);
  }

  return list.map(function (c) {
    if (c._enriched) return c._enriched;
    return enrichCluster(c, stops, allStops, maxDist, minP);
  });
}

// ---- 聚类主流程 ----
function cluster(stops, allStops, maxDist, minP) {
  minP = minP || 0;

  var clusters = greedyCluster(stops, maxDist);
  clusters = mergeNearby(clusters, stops, maxDist);
  var absorbed = absorbSmall(clusters, stops, maxDist, minP);
  clusters = mergeNearby(absorbed.clusters, stops, maxDist);

  var covered = {};
  var results = clusters.map(function (c) {
    c.indices.forEach(function (i) { covered[i] = true; });
    return enrichCluster(c, stops, allStops, maxDist, minP);
  });

  for (var i = 0; i < stops.length; i++) {
    if (!covered[i]) {
      results.push(enrichCluster({ indices: [i] }, stops, allStops, maxDist, minP));
    }
  }

  // 强制合并距离小于 150 米的上车点。
  results = mergeCloseBoarding(results, stops, allStops, maxDist, minP, BOARDING_MERGE_DIST);

  // 合并上车点后重新统计未吸收人数。
  var unabsorbed = 0;
  if (minP > 0) {
    results.forEach(function (r) {
      r.belowMin = r.totalCount < minP;
      if (r.belowMin) unabsorbed++;
    });
  }

  results.sort(function (a, b) { return b.totalCount - a.totalCount; });
  return { results: results, unabsorbed: unabsorbed };
}
