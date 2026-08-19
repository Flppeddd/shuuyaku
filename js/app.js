// 页面事件处理、地图渲染、手动编辑与导出流程编排。
var sidebarToggleButton = $('sidebarToggleBtn');

function setSidebarCollapsed(collapsed) {
  var rootLayout = document.querySelector('.layout');
  if (!rootLayout) return;
  rootLayout.classList.toggle('sidebar-collapsed', !!collapsed);
  if (sidebarToggleButton) {
    var toggleLabel = sidebarToggleButton.querySelector('.toggle-label');
    if (toggleLabel) toggleLabel.textContent = collapsed ? '展开面板' : '收起面板';
    sidebarToggleButton.setAttribute('aria-expanded', String(!collapsed));
    sidebarToggleButton.setAttribute('aria-label', collapsed ? '展开操作面板' : '收起操作面板');
  }
  // 高德地图容器尺寸变化后主动刷新，避免侧栏收起区域留下空白。
  setTimeout(function () {
    if (map && typeof map.resize === 'function') map.resize();
  }, 300);
}

if (sidebarToggleButton) {
  sidebarToggleButton.addEventListener('click', function () {
    setSidebarCollapsed(!document.querySelector('.layout').classList.contains('sidebar-collapsed'));
  });
}

var activeRouteWorkspaceView = 'setup';

function setRouteWorkspaceAvailability(hasPlan) {
  var manualTab = document.querySelector('[data-route-view="manual"]');
  if (manualTab) manualTab.disabled = !hasPlan;
  var emptyState = $('routeEmptyState');
  if (emptyState) emptyState.classList.toggle('hidden', !!hasPlan);
}

function switchRouteWorkspace(view, options) {
  options = options || {};
  if (view === 'manual' && !routePlans) view = 'setup';
  activeRouteWorkspaceView = view;
  document.querySelectorAll('[data-route-view]').forEach(function (tab) {
    var active = tab.getAttribute('data-route-view') === view;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-route-panel]').forEach(function (panel) {
    panel.classList.toggle('active', panel.getAttribute('data-route-panel') === view);
  });
  if (!options.keepScroll) {
    var sidebar = document.querySelector('.sidebar');
    var routeCard = $('routeCard');
    if (sidebar && routeCard) {
      if (window.innerWidth <= 700) routeCard.scrollIntoView({ block: 'start', behavior: options.instant ? 'auto' : 'smooth' });
      else sidebar.scrollTo({ top: Math.max(0, routeCard.offsetTop - 10), behavior: options.instant ? 'auto' : 'smooth' });
    }
  }
}

document.querySelectorAll('[data-route-view]').forEach(function (tab) {
  tab.addEventListener('click', function () {
    if (!tab.disabled) switchRouteWorkspace(tab.getAttribute('data-route-view'));
  });
});
document.querySelectorAll('[data-route-view-jump]').forEach(function (button) {
  button.addEventListener('click', function () { switchRouteWorkspace(button.getAttribute('data-route-view-jump')); });
});
setRouteWorkspaceAvailability(false);

// ---- 文件处理 ----
$('summaryInput').addEventListener('change', function (e) {
  var f = e.target.files[0];
  if (!f) return;
  invalidateRoutePlanAfterAggregationChange();
  var r = new FileReader();
  r.onload = function (ev) {
    var rows = parseCSV(ev.target.result);
    if (rows.length < 2) { setFileMsg('格式错误', 'error'); return; }
    summaryData = rows.slice(1).map(function (row) {
      return {
        name: row[0],
        lng: parseFloat(row[1]),
        lat: parseFloat(row[2]),
        count: parseInt(row[3]) || 0
      };
    }).filter(function (s) { return !isNaN(s.lng) && !isNaN(s.lat) && s.count > 0; });
    var total = summaryData.reduce(function (s, p) { return s + p.count; }, 0);
    setFileMsg('加载 ' + summaryData.length + ' 个站点，共 ' + total + ' 人', 'success');
    $('configCard').classList.remove('hidden');
  };
  r.readAsText(f, 'UTF-8');
});

function setFileMsg(t, ty) {
  var el = $('fileMsg');
  el.textContent = t;
  el.className = 'msg ' + (ty || '');
}

// ---- 执行聚合 ----
$('runBtn').addEventListener('click', function () {
  invalidateRoutePlanAfterAggregationChange();
  var maxDist = parseInt($('maxDist').value) || 500;
  var minP = parseInt($('minPeople').value) || 0;
  lastMaxDist = maxDist;
  $('runBtn').disabled = true;
  $('runMsg').textContent = '计算中...';
  $('runMsg').className = 'msg';

  setTimeout(function () {
    try {
      var out = cluster(summaryData, allStopsData, maxDist, minP);
      results = out.results;
      manualStartSelections = [];
      manualStartActiveRoute = 0;
      aggregationDeletedCount = 0;
      aggregationDeletedPeople = 0;
      clearAggregationStopSelection();
      renderResults(out.unabsorbed, minP);
      renderRegions(maxDist);
      var inputTotal = summaryData.reduce(function (s, p) { return s + p.count; }, 0);
      var resultTotal = results.reduce(function (s, r) { return s + r.totalCount; }, 0);
      if (resultTotal !== inputTotal) {
        $('runMsg').textContent = '警告: 人数不一致 ' + resultTotal + '/' + inputTotal;
        $('runMsg').className = 'msg error';
      } else if (out.unabsorbed > 0) {
        $('runMsg').textContent = '完成。' + out.unabsorbed + ' 个区域人数不足最小值（已保留，橙色标注）';
        $('runMsg').className = 'msg warn';
      } else {
        $('runMsg').textContent = '完成';
        $('runMsg').className = 'msg success';
      }
      $('runBtn').disabled = false;
    } catch (e) {
      $('runMsg').textContent = '失败: ' + e.message;
      $('runMsg').className = 'msg error';
      $('runBtn').disabled = false;
    }
  }, 30);
});

function refreshManualStartSelectors() {
  var manual = $('routeStartMode').value === 'manual';
  $('manualStartPanel').classList.toggle('hidden', !manual);
  if (!manual) {
    clearOverlayList(manualStartSelectionOverlays);
    return;
  }
  var n = Math.max(1, Math.min(20, parseInt($('routeCount').value, 10) || 1));
  var points = results && results.length ? getPickupPoints() : [];
  if (manualStartSelections.length > n) manualStartSelections.length = n;
  while (manualStartSelections.length < n) manualStartSelections.push(null);
  if (manualStartActiveRoute >= n) manualStartActiveRoute = n - 1;
  if (manualStartActiveRoute < 0) manualStartActiveRoute = 0;
  var box = $('manualStartList');
  box.innerHTML = '';
  for (var i = 0; i < n; i++) {
    var row = document.createElement('div');
    row.className = 'start-select-row' + (i === manualStartActiveRoute ? ' active' : '');
    var label = document.createElement('label');
    label.textContent = '线路' + (i + 1);
    var value = document.createElement('span');
    value.className = 'start-select-value';
    var selectedId = manualStartSelections[i];
    var selectedPoint = null;
    for (var pi = 0; pi < points.length; pi++) if (points[pi].regionIdx === selectedId) { selectedPoint = points[pi]; break; }
    value.textContent = selectedPoint ? selectedPoint.name + '（' + selectedPoint.people + '人 / ' + selectedPoint.stopCount + '站）' : '等待点击地图站点';
    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn btn-ghost';
    clearBtn.textContent = '清除';
    clearBtn.disabled = !selectedPoint;
    (function (routeIdx) {
      row.addEventListener('click', function () {
        manualStartActiveRoute = routeIdx;
        refreshManualStartSelectors();
      });
      clearBtn.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        manualStartSelections[routeIdx] = null;
        manualStartActiveRoute = routeIdx;
        refreshManualStartSelectors();
        $('routeMsg').textContent = '请在地图上点击线路' + (routeIdx + 1) + '的起点';
        $('routeMsg').className = 'msg';
      });
    })(i);
    row.appendChild(label);
    row.appendChild(value);
    row.appendChild(clearBtn);
    box.appendChild(row);
  }
  drawManualStartHighlights();
}

function drawManualStartHighlights() {
  clearOverlayList(manualStartSelectionOverlays);
  if ($('routeStartMode').value !== 'manual' || !map || typeof AMap === 'undefined' || !results) return;
  var points = getPickupPoints();
  manualStartSelections.forEach(function (regionIdx, routeIdx) {
    if (regionIdx == null) return;
    var point = null;
    for (var i = 0; i < points.length; i++) if (points[i].regionIdx === regionIdx) { point = points[i]; break; }
    if (!point) return;
    try {
      var active = routeIdx === manualStartActiveRoute;
      var marker = new AMap.Marker({
        position: [point.lng, point.lat],
        content: '<div style="min-width:26px;height:26px;padding:0 4px;border-radius:13px;background:' + (active ? '#16a34a' : '#047857') + ';color:#fff;border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.5);font-size:11px;font-weight:700;line-height:26px;text-align:center">起' + (routeIdx + 1) + '</div>',
        offset: new AMap.Pixel(-13, -13), zIndex: 320,
        title: '线路' + (routeIdx + 1) + '手动起点：' + point.name
      });
      marker.on('click', function () {
        selectAggregatedStopFromMap(regionIdx);
        handleManualStartMapSelection(regionIdx);
      });
      marker.setMap(map);
      manualStartSelectionOverlays.push(marker);
    } catch (_) {}
  });
}

function handleManualStartMapSelection(regionIdx) {
  if ($('routeStartMode').value !== 'manual' || !results || !results.length) return false;
  var n = Math.max(1, Math.min(20, parseInt($('routeCount').value, 10) || 1));
  var routeIdx = Math.max(0, Math.min(n - 1, manualStartActiveRoute));
  var duplicateAt = manualStartSelections.indexOf(regionIdx);
  if (duplicateAt >= 0 && duplicateAt !== routeIdx) {
    $('routeMsg').textContent = '该站点已经是线路' + (duplicateAt + 1) + '的起点，请选择其他站点';
    $('routeMsg').className = 'msg warn';
    return true;
  }
  manualStartSelections[routeIdx] = regionIdx;
  var nextEmpty = -1;
  for (var step = 1; step <= n; step++) {
    var candidate = (routeIdx + step) % n;
    if (manualStartSelections[candidate] == null) { nextEmpty = candidate; break; }
  }
  if (nextEmpty >= 0) manualStartActiveRoute = nextEmpty;
  refreshManualStartSelectors();
  var point = getPickupPoints().filter(function (p) { return p.regionIdx === regionIdx; })[0];
  $('routeMsg').textContent = '已将“' + (point ? point.name : '该站点') + '”设为线路' + (routeIdx + 1) + '起点' + (nextEmpty >= 0 ? '；请继续选择线路' + (nextEmpty + 1) : '；所有线路起点已选完');
  $('routeMsg').className = 'msg success';
  return true;
}

function readManualStartSelection(n) {
  if ($('routeStartMode').value !== 'manual') return null;
  var points = getPickupPoints();
  if (n > points.length) throw new Error('上车点数量不足，无法为' + n + '条线路分别选择不同起点');
  var ids = [], used = {};
  for (var i = 0; i < n; i++) {
    var id = manualStartSelections[i];
    if (id == null || !isFinite(id)) throw new Error('请在地图上选择线路' + (i + 1) + '的起点');
    if (used[id]) throw new Error('每条线路必须选择不同的起点，请修改线路' + (i + 1));
    used[id] = true;
    ids.push(id);
  }
  return ids;
}

function clearAggregationStopSelection() {
  selectedAggregationRegion = -1;
  clearOverlayList(aggregationSelectionOverlays);
  $('deleteAggregatedStopBtn').disabled = true;
  $('aggregationStopSelectionInfo').textContent = '点击地图上的上车点，可选择并删除该聚合上车点';
}

function drawAggregationStopSelection() {
  clearOverlayList(aggregationSelectionOverlays);
  if (!map || typeof AMap === 'undefined' || !results || selectedAggregationRegion < 0 || selectedAggregationRegion >= results.length) return;
  var r = results[selectedAggregationRegion];
  var board = r.boardingStop || r.center;
  try {
    var ring = new AMap.Circle({
      center: [board.lng, board.lat], radius: 32,
      strokeColor: '#f59e0b', strokeWeight: 4, strokeOpacity: 0.95,
      fillColor: '#f59e0b', fillOpacity: 0.12, zIndex: 305
    });
    ring.setMap(map);
    aggregationSelectionOverlays.push(ring);
  } catch (_) {}
}

function selectAggregatedStopFromMap(regionIdx) {
  if (!results || regionIdx < 0 || regionIdx >= results.length) return;
  selectedAggregationRegion = regionIdx;
  var r = results[regionIdx];
  var board = r.boardingStop || r.center;
  $('aggregationStopSelectionInfo').innerHTML = '已选择：<strong>' + (board.name || ('区域' + (regionIdx + 1))) +
    '</strong>（' + r.totalCount + '人 / ' + r.stopCount + '站）';
  $('deleteAggregatedStopBtn').disabled = false;
  drawAggregationStopSelection();
}

function invalidateRoutePlanAfterAggregationChange() {
  cancelRoutePlanRun();
  routePlans = null;
  routeSegmentCache = {};
  manualRouteVias = {};
  selectedRouteIndex = -1;
  selectedStopIndex = -1;
  selectedSwapStopAid = null;
  clearNearbyStopMarkers();
  clearManualPreview();
  clearManualAddStopSelection(true);
  clearRouteOverlays();
  $('routeList').innerHTML = '';
  $('routeStats').innerHTML = '';
  $('routeMsg').textContent = '';
  $('routeActions').classList.add('hidden');
  $('manualEditPanel').classList.add('hidden');
  setRouteWorkspaceAvailability(false);
  switchRouteWorkspace('setup', { keepScroll: true, instant: true });
  $('routeBtn').disabled = false;
  $('replanCurrentStopsBtn').disabled = false;
}

function renderResults(unabsorbed, minP) {
  $('resultCard').classList.remove('hidden');
  $('routeCard').classList.remove('hidden');
  setRouteWorkspaceAvailability(false);
  switchRouteWorkspace('setup', { keepScroll: true, instant: true });
  var totalPeople = results.reduce(function (s, r) { return s + r.totalCount; }, 0);
  var inputTotal = summaryData.reduce(function (s, p) { return s + p.count; }, 0);
  var totalStops = results.reduce(function (s, r) { return s + r.stopCount; }, 0);
  var suggestN = Math.max(1, Math.ceil(totalPeople / ROUTE_MAX_PEOPLE));
  var suggestN2 = Math.max(suggestN, Math.ceil(totalStops / 25));
  $('routeCount').value = Math.min(20, Math.max(1, suggestN2));
  refreshManualStartSelectors();
  $('statsBar').innerHTML =
    '<span>共 <strong>' + results.length + '</strong> 个区域</span>' +
    '<span>覆盖 <strong>' + totalPeople + '</strong>/' + inputTotal + ' 人</span>' +
    (aggregationDeletedCount ? '<span style="color:#b45309">已删除 <strong>' + aggregationDeletedCount + '</strong> 个上车点（' + aggregationDeletedPeople + '人）</span>' : '') +
    (unabsorbed > 0 ? '<span style="color:#b45309">不足最少人数: <strong>' + unabsorbed + '</strong></span>' : '');

  var tb = $('resultTable').querySelector('tbody');
  tb.innerHTML = '';
  results.forEach(function (r, i) {
    var tr = document.createElement('tr');
    tr.setAttribute('data-region', i);
    if (r.belowMin) tr.className = 'small-flag';
    tr.innerHTML =
      '<td>' + (i + 1) + (r.belowMin ? '*' : '') + '</td>' +
      '<td>' + (r.boardingStop ? r.boardingStop.name : '-') + '</td>' +
      '<td><strong>' + r.totalCount + '</strong></td>' +
      '<td>' + r.stopCount + '</td>' +
      '<td class="stop-list">' + r.stopNames.join('; ') + '</td>';
    tr.addEventListener('click', function () { hlRegion(i, r); });
    tb.appendChild(tr);
  });
}

$('deleteAggregatedStopBtn').addEventListener('click', function () {
  if (!results || selectedAggregationRegion < 0 || selectedAggregationRegion >= results.length) return;
  var removed = results[selectedAggregationRegion];
  var board = removed.boardingStop || removed.center;
  var name = board.name || ('区域' + (selectedAggregationRegion + 1));
  if (typeof window.confirm === 'function' && !window.confirm('确定删除上车点“' + name + '”吗？该点覆盖的' + removed.totalCount + '人将不再参与线路规划。')) return;
  results.splice(selectedAggregationRegion, 1);
  aggregationDeletedCount++;
  aggregationDeletedPeople += removed.totalCount;
  manualStartSelections = [];
  manualStartActiveRoute = 0;
  clearAggregationStopSelection();
  invalidateRoutePlanAfterAggregationChange();
  var minP = parseInt($('minPeople').value, 10) || 0;
  var unabsorbed = results.filter(function (r) { return r.belowMin; }).length;
  renderResults(unabsorbed, minP);
  renderRegions(lastMaxDist);
  $('runMsg').textContent = '已删除上车点“' + name + '”（' + removed.totalCount + '人）；后续线路规划将使用剩余上车点。';
  $('runMsg').className = 'msg warn';
  if (!results.length) $('routeCard').classList.add('hidden');
});

// ---- 线路规划 ----
function snapStopsToRoads(stops, callback) {
  if (!geocoderInst) { callback(); return; }

  var pending = [];
  stops.forEach(function (s) {
    var key = s.lng.toFixed(6) + ',' + s.lat.toFixed(6);
    if (!roadSnapCache[key]) {
      roadSnapCache[key] = null; // 标记为处理中
      pending.push({ key: key, lng: s.lng, lat: s.lat });
    }
  });

  if (pending.length === 0) { callback(); return; }

  var idx = 0;
  function next() {
    if (idx >= pending.length) { callback(); return; }
    var item = pending[idx];
    geocoderInst.getAddress([item.lng, item.lat], function (status, result) {
      var snapped = null;
      if (status === 'complete' && result.regeocode && result.regeocode.roads && result.regeocode.roads.length > 0) {
        var bestRoadM = Infinity;
        result.regeocode.roads.forEach(function (road) {
          var loc = road.location;
          if (!loc) return;
          var slng, slat;
          if (typeof loc === 'string') {
            var parts = loc.split(',');
            slng = parseFloat(parts[0]);
            slat = parseFloat(parts[1]);
          } else if (Array.isArray(loc)) {
            slng = loc[0]; slat = loc[1];
          } else {
            slng = loc.lng; slat = loc.lat;
          }
          if (!isNaN(slng) && !isNaN(slat)) {
            var roadM = geoDistance({ lng: item.lng, lat: item.lat }, { lng: slng, lat: slat });
            if (roadM < bestRoadM) {
              bestRoadM = roadM;
              snapped = [slng, slat];
              snapped.roadName = road.name || '';
            }
          }
        });
      }
      roadSnapCache[item.key] = snapped;
      idx++;
      setTimeout(next, 60);
    });
  }
  next();
}

function snappedCoord(s) {
  if (s.roadLng != null && s.roadLat != null) return [s.roadLng, s.roadLat];
  var sourceLng = s.stopLng != null ? s.stopLng : s.lng;
  var sourceLat = s.stopLat != null ? s.stopLat : s.lat;
  var key = sourceLng.toFixed(6) + ',' + sourceLat.toFixed(6);
  var sn = roadSnapCache[key];
  return (sn && sn[0] != null) ? sn : [s.lng, s.lat];
}

function prepareRoadRoutingPoints(points) {
  var matchedCount = 0;
  var fallbackCount = 0;
  points.forEach(function (p) {
    var key = p.lng.toFixed(6) + ',' + p.lat.toFixed(6);
    var cachedRoad = roadSnapCache[key];
    var road = (cachedRoad && cachedRoad[0] != null) ? cachedRoad : [p.lng, p.lat];
    var snapM = geoDistance(p, { lng: road[0], lat: road[1] });
    // 公交站可能位于道路对向一侧；在双向道路宽度内使用道路锚点，不再绑定站点方向。
    if (cachedRoad && cachedRoad[0] != null && snapM <= DIRECTION_AGNOSTIC_ROAD_PASS_RADIUS_M) {
      p.roadLng = road[0];
      p.roadLat = road[1];
      p.roadSnapM = snapM;
      p.roadName = cachedRoad.roadName || p.roadName || '';
      matchedCount++;
    } else {
      p.roadLng = p.lng;
      p.roadLat = p.lat;
      p.roadSnapM = 0;
      p.roadName = p.roadName || '';
      fallbackCount++;
    }
  });
  return { matched: matchedCount, fallback: fallbackCount };
}

function getPickupPoints() {
  return results.map(function (r, i) {
    var bs = r.boardingStop || r.center;
    return {
      id: i,
      name: bs.name || ('区域' + (i + 1)),
      lng: bs.lng,
      lat: bs.lat,
      people: r.totalCount,
      stopCount: r.stopCount,
      stopNames: r.stopNames.slice(),
      regionIdx: i
    };
  });
}

function clearRouteOverlays() {
  routeOverlays.forEach(function (o) {
    try { o.setMap(null); } catch (_) {}
  });
  routeOverlays = [];
  mainRouteLines = [];
}

function renderRouteList(plan) {
  var box = $('routeList');
  box.innerHTML = '';
  var ok = 0, warn = 0, err = 0;
  plan.routes.forEach(function (rt, i) {
    var m = rt.metrics;
    var issues = checkRoute(m, rt.roadKm);
    if (rt._hasFallback) {
      issues.push('部分路段无法获取驾车路径，已用直线估测');
    }
    if (rt.missedStops && rt.missedStops.length) {
      issues.push(rt.missedStops.length + '个上车点未经过其所在道路');
    }
    var level = issues.length === 0 ? 'ok' : (m.people > ROUTE_MAX_PEOPLE || (rt.roadKm != null && rt.roadKm > ROUTE_MAX_KM) || rt._hasFallback || (rt.missedStops && rt.missedStops.length) ? 'err' : 'warn');
    if (level === 'ok') ok++; else if (level === 'err') err++; else warn++;
    var color = RCOLORS[i % RCOLORS.length];
    var div = document.createElement('div');
    div.className = 'route-block' + (level === 'warn' ? ' warn' : level === 'err' ? ' err' : '');
    div.setAttribute('role', 'button');
    div.setAttribute('tabindex', '0');
    div.setAttribute('aria-label', '查看线路' + (i + 1) + '，' + m.people + '人，' + (rt.roadKm != null ? rt.roadKm.toFixed(1) : m.estRoadKm.toFixed(1)) + '公里');
    div.innerHTML =
      '<h3><i class="color-bar" style="background:' + color + '"></i>线路 ' + (i + 1) +
      (plan.manualStartMode ? ' <span style="color:#166534;font-size:0.68rem;font-weight:500">手动起点</span>' : '') +
      (level !== 'ok' ? ' <span style="color:#b45309;font-weight:400">*</span>' : '') + '</h3>' +
      '<div class="route-meta">上车点 <strong>' + m.boardingCount + '</strong> · 覆盖站 <strong>' + m.stopCount +
      '</strong> · 人数 <strong>' + m.people + '</strong> · 里程 <strong>' +
      (rt.roadKm != null ? rt.roadKm.toFixed(1) : m.estRoadKm.toFixed(1) + '(估)') + ' km</strong>' +
      (rt.durationMin != null ? ' · 约 ' + rt.durationMin + ' 分钟' : '') +
      (rt.passedStopCount != null ? ' · 道路双向经过 <strong>' + rt.passedStopCount + '/' + m.boardingCount + '</strong>' : '') + '</div>' +
      '<div class="route-stops">途经道路：' + m.names.join(' → ') + ' → ' + plan.dest.name + '</div>' +
      (issues.length ? '<div class="route-meta" style="color:#b45309;margin-top:0.2rem">' + issues.join('；') + '</div>' : '');
    function activateRouteCard() {
      box.querySelectorAll('.route-block.selected').forEach(function (item) { item.classList.remove('selected'); });
      div.classList.add('selected');
      hlRoute(i, rt, plan.dest);
    }
    div.addEventListener('click', activateRouteCard);
    div.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateRouteCard();
      }
    });
    box.appendChild(div);
  });

  $('routeStats').innerHTML =
    '<span><strong>' + plan.routes.length + '</strong> 条线路</span>' +
    '<span>共 <strong>' + plan.totalPeople + '</strong> 人</span>' +
    (plan.manualAddedCount > 0 ? '<span style="color:#166534">手动新增 ' + plan.manualAddedCount + ' 个上车点（' + plan.manualAddedPeople + ' 人）</span>' : '') +
    (plan.removedCount > 0 ? '<span style="color:#b45309">已剔除 ' + plan.removedCount + ' 个上车点（' + plan.removedPeople + ' 人）</span>' : '') +
    (plan.manualDeletedCount > 0 ? '<span style="color:#b45309">手动删除 ' + plan.manualDeletedCount + ' 个上车点（' + plan.manualDeletedPeople + ' 人）</span>' : '') +
    '<span style="color:#166534">合规 ' + ok + '</span>' +
    (warn ? '<span style="color:#b45309">警告 ' + warn + '</span>' : '') +
    (err ? '<span style="color:#b91c1c">超限 ' + err + '</span>' : '');
  $('routeActions').classList.remove('hidden');
  $('manualEditPanel').classList.remove('hidden');
  setRouteWorkspaceAvailability(true);
  updateManualEditor();
}

function manualMessage(text, type) {
  $('manualEditMsg').textContent = text || '';
  $('manualEditMsg').className = 'msg ' + (type || '');
}

function clearOverlayList(list) {
  list.forEach(function (o) { try { o.setMap(null); } catch (_) {} });
  list.length = 0;
}

function clearNearbyStopMarkers() {
  nearbySearchToken++;
  clearOverlayList(manualCandidateOverlays);
  nearbyStopCandidates = [];
  selectedNearbyIndex = -1;
  $('nearbyStopSelect').innerHTML = '';
  $('replaceStopBtn').disabled = true;
}

function clearManualPreview() {
  clearOverlayList(manualTempOverlays);
  manualViaPoints = [];
}

function routeNodeKey(node, isDest) {
  if (isDest) return 'dest:' + Number(node.lng).toFixed(6) + ',' + Number(node.lat).toFixed(6);
  if (node._aid != null) return 'stop:' + node._aid;
  return 'stop:' + Number(node.lng).toFixed(6) + ',' + Number(node.lat).toFixed(6);
}

function manualSegmentKey(from, to, toIsDest) {
  return routeNodeKey(from, false) + '>' + routeNodeKey(to, !!toIsDest);
}

function clearManualViasTouchingStops(stops) {
  var nodeKeys = {};
  (stops || []).forEach(function (stop) { nodeKeys[routeNodeKey(stop, false)] = true; });
  Object.keys(manualRouteVias).forEach(function (key) {
    var nodes = key.split('>');
    if (nodeKeys[nodes[0]] || nodeKeys[nodes[1]]) delete manualRouteVias[key];
  });
}

function selectedSegmentContext() {
  if (!routePlans || selectedRouteIndex < 0 || selectedRouteIndex >= routePlans.routes.length) return null;
  var rt = routePlans.routes[selectedRouteIndex];
  if (selectedStopIndex < 0 || selectedStopIndex >= rt.stops.length) return null;
  var from = rt.stops[selectedStopIndex];
  var toIsDest = selectedStopIndex === rt.stops.length - 1;
  var to = toIsDest ? routePlans.dest : rt.stops[selectedStopIndex + 1];
  return { route: rt, from: from, to: to, toIsDest: toIsDest, key: manualSegmentKey(from, to, toIsDest) };
}

function updateSubsequentStopControls() {
  var select = $('subsequentStopSelect');
  select.innerHTML = '';
  var valid = routePlans && selectedRouteIndex >= 0 && selectedRouteIndex < routePlans.routes.length;
  if (!valid) {
    select.disabled = true;
    $('moveSubsequentEarlierBtn').disabled = true;
    $('moveSubsequentLaterBtn').disabled = true;
    $('setSelectedStopAsStartBtn').disabled = true;
    $('replanSelectedRouteBtn').disabled = true;
    return;
  }
  var rt = routePlans.routes[selectedRouteIndex];
  if (selectedStopIndex < 0 || selectedStopIndex >= rt.stops.length) {
    select.disabled = true;
    $('moveSubsequentEarlierBtn').disabled = true;
    $('moveSubsequentLaterBtn').disabled = true;
    $('setSelectedStopAsStartBtn').disabled = true;
    $('replanSelectedRouteBtn').disabled = true;
    return;
  }
  for (var i = selectedStopIndex + 1; i < rt.stops.length; i++) {
    var opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = (i + 1) + '. ' + rt.stops[i].name;
    if (selectedSubsequentStopAid != null && rt.stops[i]._aid === selectedSubsequentStopAid) opt.selected = true;
    select.appendChild(opt);
  }
  var hasFollowing = rt.stops.length > selectedStopIndex + 1;
  select.disabled = !hasFollowing;
  if (hasFollowing && select.value === '') select.value = String(selectedStopIndex + 1);
  var selectedIdx = parseInt(select.value, 10);
  $('moveSubsequentEarlierBtn').disabled = !hasFollowing || selectedIdx <= selectedStopIndex + 1;
  $('moveSubsequentLaterBtn').disabled = !hasFollowing || selectedIdx >= rt.stops.length - 1;
  $('setSelectedStopAsStartBtn').disabled = selectedStopIndex <= 0 || rt.stops.length < 2;
  $('replanSelectedRouteBtn').disabled = selectedStopIndex !== 0 || rt.stops.length < 2;
}

function updateSwapStopControls() {
  var select = $('swapStopSelect');
  var button = $('swapStopsBtn');
  var hint = $('swapStopHint');
  select.innerHTML = '';
  var validSource = routePlans && selectedRouteIndex >= 0 && selectedRouteIndex < routePlans.routes.length &&
    selectedStopIndex >= 0 && selectedStopIndex < routePlans.routes[selectedRouteIndex].stops.length;
  var targetRouteIndex = parseInt($('targetRouteSelect').value, 10);
  var validTarget = validSource && isFinite(targetRouteIndex) && targetRouteIndex >= 0 &&
    targetRouteIndex < routePlans.routes.length && targetRouteIndex !== selectedRouteIndex;
  if (!validTarget) {
    select.disabled = true;
    button.disabled = true;
    hint.className = 'manual-help';
    hint.textContent = routePlans && routePlans.routes.length < 2 ? '至少需要两条线路才能交换站点' : '请先选择当前站点和目标线路';
    return;
  }

  var targetRoute = routePlans.routes[targetRouteIndex];
  targetRoute.stops.forEach(function (stop, index) {
    var opt = document.createElement('option');
    opt.value = String(index);
    opt.textContent = (index + 1) + '. ' + stop.name + '（' + stop.people + '人）';
    if (selectedSwapStopAid != null && stop._aid === selectedSwapStopAid) opt.selected = true;
    select.appendChild(opt);
  });
  select.disabled = !targetRoute.stops.length;
  if (!targetRoute.stops.length) {
    button.disabled = true;
    hint.className = 'manual-help warn';
    hint.textContent = '目标线路没有可交换的站点';
    return;
  }
  if (select.value === '') select.value = '0';
  var targetStopIndex = parseInt(select.value, 10);
  var sourceStop = routePlans.routes[selectedRouteIndex].stops[selectedStopIndex];
  var targetStop = targetRoute.stops[targetStopIndex];
  if (!targetStop) {
    button.disabled = true;
    return;
  }
  selectedSwapStopAid = targetStop._aid;
  var sourcePeople = routePlans.routes[selectedRouteIndex].stops.reduce(function (sum, stop) { return sum + stop.people; }, 0);
  var targetPeople = targetRoute.stops.reduce(function (sum, stop) { return sum + stop.people; }, 0);
  var sourceAfter = sourcePeople - sourceStop.people + targetStop.people;
  var targetAfter = targetPeople - targetStop.people + sourceStop.people;
  var exceedsCapacity = sourceAfter > ROUTE_MAX_PEOPLE || targetAfter > ROUTE_MAX_PEOPLE;
  button.disabled = false;
  hint.className = 'manual-help ' + (exceedsCapacity ? 'warn' : 'ok');
  hint.textContent = '交换后：线路' + (selectedRouteIndex + 1) + ' ' + sourceAfter + '人 · 线路' +
    (targetRouteIndex + 1) + ' ' + targetAfter + '人' +
    (exceedsCapacity ? '（警告：超过' + ROUTE_MAX_PEOPLE + '人上限，但仍可交换）' : '');
}

function updateManualEditor() {
  updateAddStopControls();
  var valid = routePlans && selectedRouteIndex >= 0 && selectedRouteIndex < routePlans.routes.length &&
    selectedStopIndex >= 0 && selectedStopIndex < routePlans.routes[selectedRouteIndex].stops.length;
  $('moveStopBtn').disabled = !valid || routePlans.routes.length < 2;
  $('deleteRouteStopBtn').disabled = !valid;
  $('startLocalRouteBtn').disabled = !valid;
  $('resetLocalRouteBtn').disabled = !valid;
  $('targetRouteSelect').disabled = !valid || routePlans.routes.length < 2;

  if (!valid) {
    $('selectedStopInfo').textContent = '点击地图上的上车点开始调整';
    $('targetRouteSelect').innerHTML = '';
    updateSubsequentStopControls();
    updateSwapStopControls();
    return;
  }

  var rt = routePlans.routes[selectedRouteIndex];
  var s = rt.stops[selectedStopIndex];
  var nextName = selectedStopIndex < rt.stops.length - 1 ? rt.stops[selectedStopIndex + 1].name : routePlans.dest.name;
  $('selectedStopInfo').innerHTML = '已选：<strong>线路' + (selectedRouteIndex + 1) + ' · ' + s.name +
    '</strong><br>当前局部路段：' + s.name + ' → ' + nextName;

  var target = $('targetRouteSelect');
  var previousTargetRoute = target.value;
  target.innerHTML = '';
  routePlans.routes.forEach(function (targetRoute, i) {
    if (i === selectedRouteIndex) return;
    var opt = document.createElement('option');
    opt.value = i;
    opt.textContent = '线路 ' + (i + 1) + '（' + targetRoute.metrics.people + '人 / ' + targetRoute.stops.length + '站）';
    if (String(i) === previousTargetRoute) opt.selected = true;
    target.appendChild(opt);
  });
  var seg = selectedSegmentContext();
  $('resetLocalRouteBtn').disabled = !seg || !manualRouteVias[seg.key];
  updateSubsequentStopControls();
  updateSwapStopControls();
}

function renderNearbyStopCandidates(items) {
  clearOverlayList(manualCandidateOverlays);
  nearbyStopCandidates = items.slice().sort(function (a, b) { return a.dist - b.dist; });
  selectedNearbyIndex = -1;
  var select = $('nearbyStopSelect');
  select.innerHTML = '';
  if (!nearbyStopCandidates.length) {
    var none = document.createElement('option');
    none.textContent = NEARBY_BUS_SEARCH_RADIUS_M + '米内没有其他公交站';
    select.appendChild(none);
    $('replaceStopBtn').disabled = true;
    return;
  }

  nearbyStopCandidates.forEach(function (item, idx) {
    var opt = document.createElement('option');
    opt.value = idx;
    opt.textContent = item.stop.name + '（约 ' + Math.round(item.dist) + ' 米）';
    select.appendChild(opt);
    if (!map || typeof AMap === 'undefined') return;
    try {
      var mk = new AMap.Marker({
        position: [item.stop.lng, item.stop.lat],
        content: '<div style="width:14px;height:14px;border-radius:50%;background:#22c55e;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>',
        offset: new AMap.Pixel(-7, -7),
        zIndex: 260,
        title: item.stop.name + ' · 距原上车点' + Math.round(item.dist) + 'm'
      });
      mk.on('click', function () {
        selectedNearbyIndex = idx;
        select.value = String(idx);
        $('replaceStopBtn').disabled = false;
        manualMessage('候选站：' + item.stop.name + '，距当前上车点' + Math.round(item.dist) + '米', 'success');
      });
      mk.setMap(map);
      manualCandidateOverlays.push(mk);
    } catch (_) {}
  });
  selectedNearbyIndex = 0;
  select.value = '0';
  $('replaceStopBtn').disabled = false;
}

function showNearbyStopsForSelection() {
  clearNearbyStopMarkers();
  var token = nearbySearchToken;
  var seg = selectedSegmentContext();
  if (!seg) return;
  var s = seg.from;
  var currentName = s.name.replace(/\(班\d+\)$/, '');
  var center = { lng: s.stopLng != null ? s.stopLng : s.lng, lat: s.stopLat != null ? s.stopLat : s.lat };
  var merged = [];

  function addStop(stop, source) {
    if (!stop || !stop.name || !isFinite(stop.lng) || !isFinite(stop.lat)) return;
    var d = geoDistance(center, stop);
    if (d > NEARBY_BUS_SEARCH_RADIUS_M + 0.001 || (d < 1 && stop.name === currentName)) return;
    var normalized = stop.name.replace(/\s+/g, '').replace(/[（(].*?[）)]/g, '');
    var duplicate = merged.some(function (x) {
      var otherName = x.stop.name.replace(/\s+/g, '').replace(/[（(].*?[）)]/g, '');
      return normalized === otherName && geoDistance(stop, x.stop) < 5;
    });
    if (!duplicate) merged.push({ stop: { name: stop.name, lng: Number(stop.lng), lat: Number(stop.lat) }, dist: d, source: source });
  }

  allStopsData.forEach(function (stop) { addStop(stop, '站点库'); });
  (summaryData || []).forEach(function (stop) { addStop(stop, '导入数据'); });
  if (routePlans) {
    routePlans.routes.forEach(function (rt) {
      rt.stops.forEach(function (stop) {
        addStop({ name: stop.name.replace(/\(班\d+\)$/, ''), lng: stop.stopLng != null ? stop.stopLng : stop.lng, lat: stop.stopLat != null ? stop.stopLat : stop.lat }, '当前方案');
      });
    });
  }
  renderNearbyStopCandidates(merged);
  manualMessage('正在查找附近公交站...', '');

  if (!placeSearchInst) {
    manualMessage(merged.length ? '附近找到' + merged.length + '个公交站。' : '附近未找到其他公交站。', merged.length ? 'success' : 'warn');
    return;
  }
  placeSearchInst.searchNearBy('公交站', [center.lng, center.lat], NEARBY_BUS_SEARCH_RADIUS_M, function (status, result) {
    if (token !== nearbySearchToken) return;
    if (status === 'complete' && result && result.poiList && result.poiList.pois) {
      result.poiList.pois.forEach(function (poi) {
        var loc = poi.location;
        var lng = loc && (loc.lng != null ? loc.lng : (loc.getLng ? loc.getLng() : loc[0]));
        var lat = loc && (loc.lat != null ? loc.lat : (loc.getLat ? loc.getLat() : loc[1]));
        addStop({ name: poi.name, lng: Number(lng), lat: Number(lat) }, '高德');
      });
      renderNearbyStopCandidates(merged);
      manualMessage(merged.length ? '附近找到' + merged.length + '个公交站。' : '附近未找到其他公交站。', merged.length ? 'success' : 'warn');
    } else {
      manualMessage(merged.length ? '附近找到' + merged.length + '个公交站。' : '附近公交站查找失败，请稍后重试。', merged.length ? 'success' : 'warn');
    }
  });
}

function selectRouteStop(routeIdx, stopIdx) {
  if (manualViaMode || manualAddStopMode) return;
  selectedRouteIndex = routeIdx;
  selectedStopIndex = stopIdx;
  selectedSubsequentStopAid = null;
  selectedSwapStopAid = null;
  setSidebarCollapsed(false);
  switchRouteWorkspace('manual');
  manualMessage('已选中站点：可移动或交换所属线路、调整顺序、更换附近公交站，或修改下一局部路段。', 'success');
  updateManualEditor();
  showNearbyStopsForSelection();
}

function refreshPlanMetrics() {
  if (!routePlans) return;
  routePlans.routes = routePlans.routes.filter(function (rt) { return rt.stops && rt.stops.length; });
  routePlans.routes.forEach(function (rt) {
    rt.metrics = routeMetrics(rt.stops, routePlans.dest);
    delete rt.roadM; delete rt.roadKm; delete rt.durationMin;
    delete rt.missedStops; delete rt.passedStopCount;
    delete rt._forcedRoutingAnchorAids;
    delete rt._routingAnchorIndexes;
    delete rt._directionlessSkippedStopCount;
    delete rt._directionlessRefined;
  });
  routePlans.numRoutes = routePlans.routes.length;
  routePlans.totalPeople = routePlans.routes.reduce(function (sum, rt) { return sum + rt.metrics.people; }, 0);
  routePlans.totalStops = routePlans.routes.reduce(function (sum, rt) { return sum + rt.metrics.stopCount; }, 0);
}

function redrawAfterManualEdit(message, keepSelection, messageType) {
  clearNearbyStopMarkers();
  clearManualPreview();
  manualViaMode = false;
  clearManualAddStopSelection(true);
  refreshPlanMetrics();
  drawRoutesOnMap(routePlans, function () {
    renderRouteList(routePlans);
    if (keepSelection && selectedRouteIndex >= 0 && selectedRouteIndex < routePlans.routes.length &&
        selectedStopIndex >= 0 && selectedStopIndex < routePlans.routes[selectedRouteIndex].stops.length) {
      updateManualEditor();
      showNearbyStopsForSelection();
    } else {
      selectedRouteIndex = -1;
      selectedStopIndex = -1;
      selectedSwapStopAid = null;
      updateManualEditor();
    }
    manualMessage(message, messageType || 'success');
  });
}

function bestInsertionIndex(stops, unit, dest) {
  var bestPos = 0, bestScore = Infinity;
  for (var pos = 0; pos <= stops.length; pos++) {
    var candidate = stops.slice();
    candidate.splice(pos, 0, unit);
    var m = routeMetrics(candidate, dest);
    var score = routeOrderScore(candidate, dest) + constraintViolation(m);
    if (score < bestScore) { bestScore = score; bestPos = pos; }
  }
  return bestPos;
}

function manualAddStopUnit(point) {
  return {
    _aid: 'manual-add-preview',
    name: ($('addStopNameInput').value || '').trim() || '手动上车点',
    lng: point.lng,
    lat: point.lat,
    people: Math.max(0, parseInt($('addStopPeopleInput').value, 10) || 0),
    stopCount: 1,
    stopNames: [($('addStopNameInput').value || '').trim() || '手动上车点']
  };
}

function manualAddPositionText(route, pos) {
  if (!route || !route.stops.length) return '作为该线路的起点';
  if (pos <= 0) return '在“' + route.stops[0].name + '”之前（作为新起点）';
  var before = route.stops[pos - 1].name;
  var after = pos < route.stops.length ? route.stops[pos].name : routePlans.dest.name;
  return '在“' + before + '”与“' + after + '”之间';
}

function updateAddStopControls() {
  var section = $('manualAddStopSection');
  var routeSelect = $('addStopRouteSelect');
  var planReady = !!(routePlans && routePlans.routes && routePlans.routes.length);
  var previousRoute = routeSelect.value;
  routeSelect.innerHTML = '';
  if (planReady) {
    routePlans.routes.forEach(function (rt, idx) {
      var opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = '线路 ' + (idx + 1) + '（' + rt.metrics.people + '人 / ' + rt.stops.length + '站）';
      if (String(idx) === previousRoute) opt.selected = true;
      routeSelect.appendChild(opt);
    });
  }
  if (routeSelect.value === '' && planReady) routeSelect.value = '0';

  section.classList.toggle('is-picking', manualAddStopMode);
  $('startAddStopBtn').disabled = !planReady;
  $('startAddStopBtn').textContent = manualAddStopMode ? '重新在地图选点' : '在地图选点';
  $('cancelAddStopBtn').classList.toggle('hidden', !manualAddStopMode);
  var hasPoint = planReady && !!manualAddStopPoint;
  routeSelect.disabled = !hasPoint;
  $('addStopNameInput').disabled = !hasPoint;
  $('addStopPeopleInput').disabled = !hasPoint;

  if (!hasPoint) {
    $('confirmAddStopBtn').disabled = true;
    $('addStopPointInfo').textContent = manualAddStopMode ? '选点模式已开启：请点击地图上要新增的位置' : '点击“在地图选点”，再点击地图上要新增的位置';
    $('addStopInsertHint').textContent = '选点后将自动计算绕路较少的插入位置';
    return;
  }

  var routeIdx = parseInt(routeSelect.value, 10);
  var route = routePlans.routes[routeIdx];
  var previewUnit = manualAddStopUnit(manualAddStopPoint);
  var pos = bestInsertionIndex(route.stops, previewUnit, routePlans.dest);
  var afterPeople = route.metrics.people + previewUnit.people;
  var exceedsCapacity = previewUnit.people > 0 && afterPeople > ROUTE_MAX_PEOPLE;
  $('addStopPointInfo').textContent = '已在地图选择新上车点';
  $('addStopInsertHint').className = 'manual-help ' + (exceedsCapacity ? 'warn' : 'ok');
  $('addStopInsertHint').textContent = '预计插入' + manualAddPositionText(route, pos) + '；添加后线路人数 ' + afterPeople + '人' +
    (exceedsCapacity ? '（超过' + ROUTE_MAX_PEOPLE + '人上限）' : '') + '。';
  $('confirmAddStopBtn').disabled = exceedsCapacity;
}

function clearManualAddStopSelection(exitMode) {
  manualAddStopLookupToken++;
  clearOverlayList(manualAddStopOverlays);
  manualAddStopPoint = null;
  if (exitMode) manualAddStopMode = false;
  try { if (map && map.setDefaultCursor) map.setDefaultCursor('default'); } catch (_) {}
  if ($('addStopNameInput')) $('addStopNameInput').value = '手动上车点';
  if ($('addStopPeopleInput')) $('addStopPeopleInput').value = '0';
  if ($('manualAddStopSection')) updateAddStopControls();
}

function drawManualAddStopPoint(lng, lat) {
  clearOverlayList(manualAddStopOverlays);
  if (!map || typeof AMap === 'undefined') return;
  try {
    var circle = new AMap.Circle({
      center: [lng, lat], radius: STOP_PASS_RADIUS_M,
      strokeColor: '#16a34a', strokeWeight: 2, strokeOpacity: 0.9,
      fillColor: '#22c55e', fillOpacity: 0.14, zIndex: 275
    });
    circle.setMap(map);
    manualAddStopOverlays.push(circle);
    var marker = new AMap.Marker({
      position: [lng, lat],
      content: '<div style="background:#16a34a;color:#fff;width:26px;height:26px;border-radius:50%;font-size:11px;line-height:26px;text-align:center;font-weight:700;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)">+</div>',
      offset: new AMap.Pixel(-13, -13), zIndex: 290, title: '待新增的上车点'
    });
    marker.setMap(map);
    manualAddStopOverlays.push(marker);
  } catch (_) {}
}

function chooseManualAddStopPoint(lng, lat) {
  manualAddStopPoint = { lng: Number(lng), lat: Number(lat) };
  $('addStopNameInput').value = '手动上车点';
  drawManualAddStopPoint(manualAddStopPoint.lng, manualAddStopPoint.lat);
  updateAddStopControls();
  manualMessage('已选择新上车点位置，请选择所属线路并确认添加。', 'success');

  var token = ++manualAddStopLookupToken;
  if (!geocoderInst) return;
  geocoderInst.getAddress([manualAddStopPoint.lng, manualAddStopPoint.lat], function (status, result) {
    if (token !== manualAddStopLookupToken || !manualAddStopPoint || status !== 'complete' || !result.regeocode) return;
    var roads = result.regeocode.roads || [];
    var suggested = roads.length && roads[0].name ? roads[0].name + '（手动上车点）' : '';
    if (!suggested && result.regeocode.formattedAddress) suggested = result.regeocode.formattedAddress;
    if (suggested) $('addStopNameInput').value = suggested;
    updateAddStopControls();
  });
}

$('startAddStopBtn').addEventListener('click', function () {
  if (!routePlans || !routePlans.routes.length) return;
  manualViaMode = false;
  clearManualPreview();
  $('applyLocalRouteBtn').classList.add('hidden');
  $('cancelLocalRouteBtn').classList.add('hidden');
  $('startLocalRouteBtn').classList.remove('hidden');
  clearManualAddStopSelection(false);
  manualAddStopMode = true;
  try { if (map && map.setDefaultCursor) map.setDefaultCursor('crosshair'); } catch (_) {}
  updateAddStopControls();
  manualMessage('新增上车点模式已开启：请在地图上点击一个位置。', '');
});

$('cancelAddStopBtn').addEventListener('click', function () {
  clearManualAddStopSelection(true);
  manualMessage('已取消新增上车点。', '');
});

$('addStopRouteSelect').addEventListener('change', updateAddStopControls);
$('addStopNameInput').addEventListener('input', updateAddStopControls);
$('addStopPeopleInput').addEventListener('input', updateAddStopControls);

$('confirmAddStopBtn').addEventListener('click', function () {
  if (!routePlans || !manualAddStopPoint) return;
  var routeIdx = parseInt($('addStopRouteSelect').value, 10);
  var route = routePlans.routes[routeIdx];
  if (!route) return;
  var unit = manualAddStopUnit(manualAddStopPoint);
  unit._aid = nextManualAid++;
  unit._manualAdded = true;
  unit.stopLng = unit.lng;
  unit.stopLat = unit.lat;
  if (unit.people > 0 && route.metrics.people + unit.people > ROUTE_MAX_PEOPLE) {
    manualMessage('无法添加：所选线路人数将超过' + ROUTE_MAX_PEOPLE + '人。', 'error');
    updateAddStopControls();
    return;
  }
  var button = $('confirmAddStopBtn');
  var activePlan = routePlans;
  var addToken = manualAddStopLookupToken;
  button.disabled = true;
  button.textContent = '正在贴合道路...';
  snapStopsToRoads([unit], function () {
    if (routePlans !== activePlan || manualAddStopLookupToken !== addToken || !manualAddStopPoint || activePlan.routes[routeIdx] !== route) {
      button.textContent = '添加并局部重新规划';
      updateAddStopControls();
      return;
    }
    prepareRoadRoutingPoints([unit]);
    var pos = bestInsertionIndex(route.stops, unit, routePlans.dest);
    if (pos > 0) {
      var previous = route.stops[pos - 1];
      var nextIsDest = pos === route.stops.length;
      var next = nextIsDest ? routePlans.dest : route.stops[pos];
      var oldManualKey = manualSegmentKey(previous, next, nextIsDest);
      var oldWaypoints = (manualRouteVias[oldManualKey] || []).map(function (p) { return p.slice(); });
      delete manualRouteVias[oldManualKey];
      var oldStart = snappedCoord(previous);
      var oldEnd = nextIsDest ? [next.lng, next.lat] : snappedCoord(next);
      delete routeSegmentCache[drivingSegmentCacheKey(oldStart, oldEnd, oldWaypoints)];
      delete routeSegmentCache[drivingSegmentCacheKey(oldStart, oldEnd, [])];
    }
    route.stops.splice(pos, 0, unit);
    routePlans.manualAddedCount = (routePlans.manualAddedCount || 0) + 1;
    routePlans.manualAddedPeople = (routePlans.manualAddedPeople || 0) + unit.people;
    selectedRouteIndex = routeIdx;
    selectedStopIndex = pos;
    selectedSubsequentStopAid = null;
    selectedSwapStopAid = null;
    button.textContent = '添加并局部重新规划';
    redrawAfterManualEdit('已将“' + unit.name + '”添加到线路' + (routeIdx + 1) + '，并仅重新规划新站点前后的局部路段。', true);
  });
});

$('targetRouteSelect').addEventListener('change', function () {
  selectedSwapStopAid = null;
  updateSwapStopControls();
});
$('swapStopSelect').addEventListener('change', function () {
  var targetRouteIndex = parseInt($('targetRouteSelect').value, 10);
  var targetStopIndex = parseInt(this.value, 10);
  var targetRoute = routePlans && routePlans.routes[targetRouteIndex];
  selectedSwapStopAid = targetRoute && targetRoute.stops[targetStopIndex] ? targetRoute.stops[targetStopIndex]._aid : null;
  updateSwapStopControls();
});
$('nearbyStopSelect').addEventListener('change', function () {
  selectedNearbyIndex = parseInt(this.value, 10);
  $('replaceStopBtn').disabled = isNaN(selectedNearbyIndex);
});
$('subsequentStopSelect').addEventListener('change', function () {
  var idx = parseInt(this.value, 10);
  var rt = routePlans && routePlans.routes[selectedRouteIndex];
  selectedSubsequentStopAid = rt && rt.stops[idx] ? rt.stops[idx]._aid : null;
  updateSubsequentStopControls();
});

function moveSubsequentStop(delta) {
  if (!routePlans || selectedRouteIndex < 0 || selectedStopIndex < 0) return;
  var rt = routePlans.routes[selectedRouteIndex];
  var idx = parseInt($('subsequentStopSelect').value, 10);
  var targetIdx = idx + delta;
  if (!isFinite(idx) || targetIdx <= selectedStopIndex || targetIdx >= rt.stops.length) return;
  var unit = rt.stops[idx];
  rt.stops[idx] = rt.stops[targetIdx];
  rt.stops[targetIdx] = unit;
  selectedSubsequentStopAid = unit._aid;
  redrawAfterManualEdit('已调整“' + unit.name + '”在所选站点之后的顺序；仅受影响的连接路段会重新规划。', true);
}

$('moveSubsequentEarlierBtn').addEventListener('click', function () { moveSubsequentStop(-1); });
$('moveSubsequentLaterBtn').addEventListener('click', function () { moveSubsequentStop(1); });

// 站序发生整体变化时，只清除当前线路使用的驾车缓存；其他线路共用的缓存继续保留。
function invalidateSingleRoutePathCache(routeIndex, previousStops) {
  if (!routePlans || routeIndex < 0 || routeIndex >= routePlans.routes.length) return;
  var rt = routePlans.routes[routeIndex];
  var protectedKeys = {};
  routePlans.routes.forEach(function (other, idx) {
    if (idx === routeIndex) return;
    (other._segmentCacheKeys || []).forEach(function (key) { protectedKeys[key] = true; });
  });
  (rt._segmentCacheKeys || []).forEach(function (key) {
    if (!protectedKeys[key]) delete routeSegmentCache[key];
  });

  var oldStops = previousStops || rt.stops;
  clearManualViasTouchingStops(oldStops);

  function invalidateAdjacentSegments(stops) {
    for (var i = 0; i < stops.length; i++) {
      var toIsDest = i === stops.length - 1;
      var to = toIsDest ? routePlans.dest : stops[i + 1];
      var key = drivingSegmentCacheKey(
        snappedCoord(stops[i]),
        toIsDest ? [to.lng, to.lat] : snappedCoord(to),
        []
      );
      if (!protectedKeys[key]) delete routeSegmentCache[key];
    }
  }

  invalidateAdjacentSegments(oldStops);
  invalidateAdjacentSegments(rt.stops);
  delete rt._segmentCacheKeys;
}

$('swapStopsBtn').addEventListener('click', function () {
  if (!routePlans || selectedRouteIndex < 0 || selectedStopIndex < 0) return;
  var sourceRouteIndex = selectedRouteIndex;
  var targetRouteIndex = parseInt($('targetRouteSelect').value, 10);
  var targetStopIndex = parseInt($('swapStopSelect').value, 10);
  if (!isFinite(targetRouteIndex) || !isFinite(targetStopIndex) || targetRouteIndex === sourceRouteIndex) return;
  var sourceRoute = routePlans.routes[sourceRouteIndex];
  var targetRoute = routePlans.routes[targetRouteIndex];
  if (!sourceRoute || !targetRoute || !sourceRoute.stops[selectedStopIndex] || !targetRoute.stops[targetStopIndex]) return;
  var sourceStop = sourceRoute.stops[selectedStopIndex];
  var targetStop = targetRoute.stops[targetStopIndex];
  var sourceAfter = sourceRoute.metrics.people - sourceStop.people + targetStop.people;
  var targetAfter = targetRoute.metrics.people - targetStop.people + sourceStop.people;
  var exceedsCapacity = sourceAfter > ROUTE_MAX_PEOPLE || targetAfter > ROUTE_MAX_PEOPLE;

  clearManualViasTouchingStops([sourceStop, targetStop]);
  var sourceFixedStart = sourceStop._manualStartIndex;
  sourceStop._manualStartIndex = targetStop._manualStartIndex;
  targetStop._manualStartIndex = sourceFixedStart;
  sourceRoute.stops[selectedStopIndex] = targetStop;
  targetRoute.stops[targetStopIndex] = sourceStop;
  selectedRouteIndex = targetRouteIndex;
  selectedStopIndex = targetStopIndex;
  selectedSubsequentStopAid = null;
  selectedSwapStopAid = null;
  redrawAfterManualEdit(
    '已交换“' + sourceStop.name + '”与“' + targetStop.name + '”的所属线路；两条线路中受影响的连接路段已重新规划。' +
      (exceedsCapacity ? ' 警告：交换后线路人数超过' + ROUTE_MAX_PEOPLE + '人上限，请检查运力安排。' : ''),
    true,
    exceedsCapacity ? 'warn' : 'success'
  );
});

$('setSelectedStopAsStartBtn').addEventListener('click', function () {
  if (!routePlans || selectedRouteIndex < 0 || selectedRouteIndex >= routePlans.routes.length || selectedStopIndex <= 0) return;
  var rt = routePlans.routes[selectedRouteIndex];
  if (!rt.stops || selectedStopIndex >= rt.stops.length) return;
  var previousStops = rt.stops.slice();
  var newStartName = rt.stops[selectedStopIndex].name;
  rt.stops = promoteRouteStopToStart(rt.stops, selectedStopIndex, {
    manualStartMode: routePlans.manualStartMode,
    routeIndex: selectedRouteIndex
  });
  invalidateSingleRoutePathCache(selectedRouteIndex, previousStops);
  selectedStopIndex = 0;
  selectedSubsequentStopAid = null;
  selectedSwapStopAid = null;
  redrawAfterManualEdit('已将“' + newStartName + '”设为线路' + (selectedRouteIndex + 1) + '的新起点；其他站点相对顺序保持不变，并仅重新规划此线路。', true);
});

$('replanSelectedRouteBtn').addEventListener('click', function () {
  if (!routePlans || selectedRouteIndex < 0 || selectedRouteIndex >= routePlans.routes.length || selectedStopIndex !== 0) return;
  var rt = routePlans.routes[selectedRouteIndex];
  if (!rt.stops || rt.stops.length < 2) return;
  var previousStops = rt.stops.slice();
  var fixedStart = rt.stops[0];
  rt.stops = orderStopsFromFixedStart(rt.stops, fixedStart, routePlans.dest);
  invalidateSingleRoutePathCache(selectedRouteIndex, previousStops);
  selectedStopIndex = 0;
  selectedSubsequentStopAid = null;
  selectedSwapStopAid = null;
  redrawAfterManualEdit('已仅重新规划线路' + (selectedRouteIndex + 1) + '：起点保持不变，后续站点顺序和全部道路段已重新计算；其他线路保持不变。', true);
});

$('moveStopBtn').addEventListener('click', function () {
  var seg = selectedSegmentContext();
  var targetIdx = parseInt($('targetRouteSelect').value, 10);
  if (!seg || isNaN(targetIdx) || targetIdx === selectedRouteIndex) return;
  var unit = seg.from;
  if (routePlans.routes[targetIdx].metrics.people + unit.people > ROUTE_MAX_PEOPLE) {
    manualMessage('无法移动：目标线路人数将超过' + ROUTE_MAX_PEOPLE + '人。', 'error');
    return;
  }
  var fromIdx = selectedRouteIndex;
  routePlans.routes[fromIdx].stops.splice(selectedStopIndex, 1);
  if (routePlans.routes[fromIdx].stops.length === 0) {
    routePlans.routes.splice(fromIdx, 1);
    if (targetIdx > fromIdx) targetIdx--;
  }
  var targetStops = routePlans.routes[targetIdx].stops;
  var pos = bestInsertionIndex(targetStops, unit, routePlans.dest);
  targetStops.splice(pos, 0, unit);
  selectedRouteIndex = targetIdx;
  selectedStopIndex = pos;
  selectedSwapStopAid = null;
  redrawAfterManualEdit('已将“' + unit.name + '”移动到线路' + (targetIdx + 1) + '；仅新连接的局部路段已重新规划。', true);
});

$('deleteRouteStopBtn').addEventListener('click', function () {
  var seg = selectedSegmentContext();
  if (!seg) return;
  var removed = seg.route.stops.splice(selectedStopIndex, 1)[0];
  if (removed._manualAdded) {
    routePlans.manualAddedCount = Math.max(0, (routePlans.manualAddedCount || 0) - 1);
    routePlans.manualAddedPeople = Math.max(0, (routePlans.manualAddedPeople || 0) - removed.people);
  } else {
    routePlans.manualDeletedCount = (routePlans.manualDeletedCount || 0) + 1;
    routePlans.manualDeletedPeople = (routePlans.manualDeletedPeople || 0) + removed.people;
  }
  if (!seg.route.stops.length) routePlans.routes.splice(selectedRouteIndex, 1);
  redrawAfterManualEdit('已删除“' + removed.name + '”；仅其前后站点之间的路段已重新规划。', false);
});

$('replaceStopBtn').addEventListener('click', function () {
  var seg = selectedSegmentContext();
  var item = nearbyStopCandidates[selectedNearbyIndex];
  if (!seg || !item) return;
  manualMessage('正在将上车点匹配到新站点所在道路...', '');
  var p = {
    name: item.stop.name, lng: item.stop.lng, lat: item.stop.lat,
    people: seg.from.people, stopCount: seg.from.stopCount,
    stopNames: seg.from.stopNames.slice(), regionIdx: seg.from.regionIdx
  };
  snapStopsToRoads([p], function () {
    prepareRoadRoutingPoints([p]);
    var suffixMatch = seg.from.name.match(/(\(班\d+\))$/);
    var suffix = suffixMatch ? suffixMatch[1] : '';
    seg.from.name = p.name + suffix;
    seg.from.stopLng = p.lng; seg.from.stopLat = p.lat;
    seg.from.lng = p.roadLng; seg.from.lat = p.roadLat;
    seg.from.roadLng = p.roadLng; seg.from.roadLat = p.roadLat; seg.from.roadSnapM = p.roadSnapM || 0; seg.from.roadName = p.roadName || '';
    seg.from._aid = nextManualAid++;
    redrawAfterManualEdit('已更换为“' + p.name + '”；仅该站点前后的路段已重新规划。', true);
  });
});

function drawManualViaPreview() {
  clearOverlayList(manualTempOverlays);
  var seg = selectedSegmentContext();
  if (!seg || !map || typeof AMap === 'undefined') return;
  var preview = [snappedCoord(seg.from)].concat(manualViaPoints).concat([seg.toIsDest ? [seg.to.lng, seg.to.lat] : snappedCoord(seg.to)]);
  try {
    var line = new AMap.Polyline({ path: preview, strokeColor: '#f59e0b', strokeWeight: 4, strokeStyle: 'dashed', zIndex: 310 });
    line.setMap(map); manualTempOverlays.push(line);
    manualViaPoints.forEach(function (p, idx) {
      var mk = new AMap.Marker({
        position: p,
        content: '<div style="background:#f59e0b;color:#fff;width:20px;height:20px;border-radius:50%;line-height:20px;text-align:center;font-size:10px;border:2px solid #fff">' + (idx + 1) + '</div>',
        offset: new AMap.Pixel(-10, -10), zIndex: 320
      });
      mk.setMap(map); manualTempOverlays.push(mk);
    });
  } catch (_) {}
}

$('startLocalRouteBtn').addEventListener('click', function () {
  var seg = selectedSegmentContext();
  if (!seg) return;
  clearManualAddStopSelection(true);
  manualViaMode = true;
  manualViaPoints = (manualRouteVias[seg.key] || []).map(function (p) { return p.slice(); });
  $('applyLocalRouteBtn').classList.remove('hidden');
  $('cancelLocalRouteBtn').classList.remove('hidden');
  $('startLocalRouteBtn').classList.add('hidden');
  clearNearbyStopMarkers();
  drawManualViaPreview();
  manualMessage('请在地图上依次点击希望经过的位置（最多8个），然后点击“应用局部改道”。', 'warn');
});

$('applyLocalRouteBtn').addEventListener('click', function () {
  var seg = selectedSegmentContext();
  if (!seg || !manualViaMode) return;
  if (manualViaPoints.length) manualRouteVias[seg.key] = manualViaPoints.map(function (p) { return p.slice(); });
  else delete manualRouteVias[seg.key];
  $('applyLocalRouteBtn').classList.add('hidden');
  $('cancelLocalRouteBtn').classList.add('hidden');
  $('startLocalRouteBtn').classList.remove('hidden');
  redrawAfterManualEdit('局部走向已应用；仅“' + seg.from.name + '”到“' + seg.to.name + '”之间重新规划。', true);
});

$('cancelLocalRouteBtn').addEventListener('click', function () {
  manualViaMode = false;
  clearManualPreview();
  $('applyLocalRouteBtn').classList.add('hidden');
  $('cancelLocalRouteBtn').classList.add('hidden');
  $('startLocalRouteBtn').classList.remove('hidden');
  showNearbyStopsForSelection();
  manualMessage('已取消局部改道。', '');
});

$('resetLocalRouteBtn').addEventListener('click', function () {
  var seg = selectedSegmentContext();
  if (!seg || !manualRouteVias[seg.key]) return;
  delete manualRouteVias[seg.key];
  redrawAfterManualEdit('已恢复该局部路段的自动路线。', true);
});

function handleManualMapClick(e) {
  if (!e || !e.lnglat) return;
  var lng = e.lnglat.getLng ? e.lnglat.getLng() : e.lnglat.lng;
  var lat = e.lnglat.getLat ? e.lnglat.getLat() : e.lnglat.lat;
  if (manualAddStopMode) {
    chooseManualAddStopPoint(lng, lat);
    return;
  }
  if (!manualViaMode) return;
  if (manualViaPoints.length >= 8) {
    manualMessage('最多可设置8个局部途经位置。', 'warn');
    return;
  }
  manualViaPoints.push([lng, lat]);
  drawManualViaPreview();
}

function hlRoute(idx, rt, dest) {
  if (!map || !rt.stops.length) return;
  var path = rt.stops.map(function (s) { return [s.lng, s.lat]; });
  path.push([dest.lng, dest.lat]);
  try { map.setFitView(null, false, [60, 60, 60, 380]); } catch (_) {}
  try { map.setZoomAndCenter(13, [rt.stops[0].lng, rt.stops[0].lat]); } catch (_) {}
}

function drawRoutesOnMap(plan, done, isActive) {
  isActive = isActive || function () { return true; };
  if (!isActive()) return;
  clearRouteOverlays();
  routePathData = [];
  if (!map || typeof AMap === 'undefined') {
    if (done) done();
    return;
  }

  // 绘制终点标记。
  try {
    var destMk = new AMap.Marker({
      position: [plan.dest.lng, plan.dest.lat],
      icon: new AMap.Icon({
        size: new AMap.Size(28, 36),
        image: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_b.png',
        imageSize: new AMap.Size(28, 36)
      }),
      offset: new AMap.Pixel(-14, -36),
      zIndex: 300,
      label: {
        content: '<div style="background:#1d4ed8;color:#fff;border-radius:8px;padding:2px 8px;font-size:11px;font-weight:600">' + plan.dest.name + '</div>',
        direction: 'top',
        offset: new AMap.Pixel(0, -6)
      }
    });
    destMk.setMap(map);
    routeOverlays.push(destMk);
  } catch (_) {}

  var pending = plan.routes.length;
  if (pending === 0) { if (done) done(); return; }

  function finishOne() {
    if (!isActive()) return;
    pending--;
    if (pending <= 0) {
      renderOverlapLines();
      try { map.setFitView(null, false, [60, 60, 60, 380]); } catch (_) {}
      if (done) done();
    }
  }

  function drawRouteMarker(s, si, color, routeIdx) {
    if (!isActive()) return;
    var isFirst = (si === 0);
    var markerPos = [s.stopLng != null ? s.stopLng : s.lng, s.stopLat != null ? s.stopLat : s.lat];
    try {
      var passArea = new AMap.Circle({
        center: markerPos,
        radius: STOP_PASS_RADIUS_M,
        strokeColor: color,
        strokeWeight: 1,
        strokeOpacity: 0.65,
        fillColor: color,
        fillOpacity: 0.08,
        zIndex: 80
      });
      passArea.setMap(map);
      routeOverlays.push(passArea);
      var mkLabel = isFirst ? {
        content: '<div style="color:#' + color.slice(1) + ';font-size:10px;font-weight:700;white-space:nowrap;margin-top:2px">起点</div>',
        direction: 'bottom',
        offset: new AMap.Pixel(0, 3)
      } : null;
      var mk = new AMap.Marker({
        position: markerPos,
        content: '<div style="background:' + color + ';color:#fff;width:' + (isFirst ? 24 : 20) + 'px;height:' + (isFirst ? 24 : 20) + 'px;border-radius:50%;font-size:' + (isFirst ? 11 : 10) + 'px;line-height:' + (isFirst ? 24 : 20) + 'px;text-align:center;font-weight:700;border:' + (isFirst ? 3 : 2) + 'px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3)">' + (isFirst ? '起' : (si + 1)) + '</div>',
        offset: new AMap.Pixel(isFirst ? -12 : -10, isFirst ? -12 : -10),
        zIndex: 220,
        title: s.name + ' · ' + s.people + '人',
        label: mkLabel
      });
      mk.on('click', function () { selectRouteStop(routeIdx, si); });
      mk.setMap(map);
      routeOverlays.push(mk);
    } catch (_) {}
  }

  function drawRoutePolyline(path, color, i, opacity) {
    if (!isActive()) return;
    routePathData.push({ color: color, path: path.slice() });
    try {
      var line = new AMap.Polyline({
        path: path,
        strokeColor: color,
        strokeWeight: 5,
        strokeOpacity: opacity,
        showDir: true,
        zIndex: 120 + i
      });
      line.setMap(map);
      routeOverlays.push(line);
      mainRouteLines.push(line);
    } catch (_) {}
  }

  function drawStraight(rt, i, color) {
    var path = rt.stops.map(function (s) { return snappedCoord(s); });
    path.push([plan.dest.lng, plan.dest.lat]);
    evaluateRoutePasses(rt, path, []);
    drawRoutePolyline(path, color, i, 0.75);
    rt.stops.forEach(function (s, si) { drawRouteMarker(s, si, color, i); });
  }

  function searchDriving(rt, i, color, cb, refinementPass) {
    refinementPass = refinementPass || 0;
    if (!isActive()) { cb(); return; }
    if (!drivingInst) {
      drawStraight(rt, i, color);
      rt._hasFallback = true;
      rt._roadFailed = true;
      cb();
      return;
    }
    if (!rt.stops.length) { cb(); return; }

    var MAX_RETRIES = 3;
    var forcedAnchors = rt._forcedRoutingAnchorAids || {};

    function forceKey(stop, stopIndex) {
      return stop && stop._aid != null ? 'aid:' + stop._aid : 'index:' + stopIndex;
    }

    function hasManualConnection(stopIndex) {
      var current = rt.stops[stopIndex];
      var previous = stopIndex > 0 ? rt.stops[stopIndex - 1] : null;
      var nextIsDest = stopIndex === rt.stops.length - 1;
      var next = nextIsDest ? plan.dest : rt.stops[stopIndex + 1];
      if (previous && manualRouteVias[manualSegmentKey(previous, current, false)]) return true;
      return !!(next && manualRouteVias[manualSegmentKey(current, next, nextIsDest)]);
    }

    var anchorIndexes = buildDirectionlessRoutingAnchorIndexes(
      rt.stops,
      plan.dest,
      snappedCoord,
      function (stopIndex) {
        return !!forcedAnchors[forceKey(rt.stops[stopIndex], stopIndex)] || hasManualConnection(stopIndex);
      }
    );
    var anchorLookup = {};
    anchorIndexes.forEach(function (stopIndex) { anchorLookup[stopIndex] = true; });
    var skippedIndexes = [];
    for (var stopIndex = 0; stopIndex < rt.stops.length; stopIndex++) {
      if (!anchorLookup[stopIndex]) skippedIndexes.push(stopIndex);
    }
    rt._routingAnchorIndexes = anchorIndexes.slice();
    rt._directionlessSkippedStopCount = skippedIndexes.length;

    var segments = [];
    for (var si = 0; si < anchorIndexes.length; si++) {
      var fromNode = rt.stops[anchorIndexes[si]];
      var toIsDest = si === anchorIndexes.length - 1;
      var toNode = toIsDest ? plan.dest : rt.stops[anchorIndexes[si + 1]];
      var manualKey = manualSegmentKey(fromNode, toNode, toIsDest);
      segments.push({
        start: snappedCoord(fromNode),
        end: toIsDest ? [toNode.lng, toNode.lat] : snappedCoord(toNode),
        waypoints: (manualRouteVias[manualKey] || []).map(function (p) { return p.slice(); }),
        manualKey: manualKey
      });
    }

    function segmentCacheKey(seg) {
      return drivingSegmentCacheKey(seg.start, seg.end, seg.waypoints);
    }

    rt._segmentCacheKeys = segments.map(segmentCacheKey);

    function fallbackSegment(seg) {
      var seq = [seg.start].concat(seg.waypoints).concat([seg.end]);
      var meters = 0;
      for (var k = 0; k < seq.length - 1; k++) {
        meters += geoDistance({ lng: seq[k][0], lat: seq[k][1] }, { lng: seq[k + 1][0], lat: seq[k + 1][1] });
      }
      var dist = meters * ROAD_FACTOR, tm = dist / 8;
      return { path: seq, steps: [{ path: seq, distance: dist, time: tm }], distance: dist, time: tm, fallback: true };
    }

    function routeToSegmentResult(seg, route) {
      var path = [];
      var atomicSteps = [];
      (route.steps || []).forEach(function (step) {
        var stepPath = [];
        (step.path || []).forEach(function (p) {
          var lng = p.lng != null ? p.lng : p[0];
          var lat = p.lat != null ? p.lat : p[1];
          if (lng != null && lat != null) {
            var coord = [lng, lat];
            path.push(coord); stepPath.push(coord);
          }
        });
        if (stepPath.length >= 2) {
          var stepDist = Number(step.distance) || pathDistanceM(stepPath);
          atomicSteps.push({
            path: stepPath,
            distance: stepDist,
            time: Number(step.time) || stepDist / 8,
            roadName: step.road || step.road_name || ''
          });
        }
      });
      if (!path.length && route.path) {
        route.path.forEach(function (p) {
          var lng = p.lng != null ? p.lng : p[0];
          var lat = p.lat != null ? p.lat : p[1];
          if (lng != null && lat != null) path.push([lng, lat]);
        });
      }
      if (!path.length) path = [seg.start].concat(seg.waypoints).concat([seg.end]);
      if (!atomicSteps.length) {
        var fallbackDist = Number(route.distance) || pathDistanceM(path);
        atomicSteps.push({ path: path, distance: fallbackDist, time: Number(route.time) || fallbackDist / 8, roadName: '' });
      }
      return { path: path, steps: atomicSteps, distance: route.distance || 0, time: route.time || 0, fallback: false };
    }

    function requestSegment(seg, attempt, done) {
      if (!isActive()) { done(null, false, true); return; }
      var cacheKey = segmentCacheKey(seg);
      var cached = routeSegmentCache[cacheKey];
      if (cached && (!cached.fallback || Date.now() - (cached.failedAt || 0) < 30000)) { done(cached, false); return; }
      if (cached && cached.fallback) delete routeSegmentCache[cacheKey];
      queueAmapDriving(seg.start, seg.end, { waypoints: seg.waypoints }, function (status, result) {
        if (!isActive()) { done(null, false, true); return; }
        if (status === 'complete' && result && result.routes && result.routes[0]) {
          var routeResult = routeToSegmentResult(seg, result.routes[0]);
          routeSegmentCache[cacheKey] = routeResult;
          done(routeResult, true);
        } else if (attempt < MAX_RETRIES) {
          setTimeout(function () { requestSegment(seg, attempt + 1, done); }, 1000 * (attempt + 1));
        } else {
          var fallback = fallbackSegment(seg);
          fallback.failedAt = Date.now();
          fallback.failInfo = result && result.info ? result.info : status;
          routeSegmentCache[cacheKey] = fallback;
          done(fallback, true);
        }
      });
    }

    var segmentResults = new Array(segments.length);
    var nextIdx = 0, active = 0, finished = 0, requested = 0;
    var cancelled = false;
    function cancelSearch() {
      if (cancelled) return;
      cancelled = true;
      cb();
    }
    function pump() {
      if (cancelled) return;
      if (!isActive()) { cancelSearch(); return; }
      while (active < AMAP_CONCURRENCY && nextIdx < segments.length) {
        (function (segIdx) {
          active++;
          requestSegment(segments[segIdx], 0, function (result, didRequest, wasCancelled) {
            active--;
            if (wasCancelled || !isActive()) { cancelSearch(); return; }
            if (didRequest) requested++;
            segmentResults[segIdx] = result;
            finished++;
            if (finished === segments.length) finishSegments();
            else pump();
          });
        })(nextIdx++);
      }
    }

    function finishSegments() {
      if (!isActive()) { cancelSearch(); return; }
      var totalDist = 0, totalTime = 0, paths = [], passSteps = [];
      rt._hasFallback = false;
      segmentResults.forEach(function (result, resultIdx) {
        if (result.fallback) rt._hasFallback = true;
        var atomicSteps = result.steps && result.steps.length ? result.steps : [{ path: result.path || [], distance: result.distance || 0, time: result.time || 0 }];
        var segmentDist = Number(result.distance) || atomicSteps.reduce(function (sum, step) {
          return sum + (Number(step.distance) || pathDistanceM(step.path || []));
        }, 0);
        var segmentTime = Number(result.time) || atomicSteps.reduce(function (sum, step) {
          var dist = Number(step.distance) || pathDistanceM(step.path || []);
          return sum + (Number(step.time) || dist / 8);
        }, 0);
        atomicSteps.forEach(function (step) {
          passSteps.push({ path: step.path || [], roadName: step.roadName || step.road || '' });
          (step.path || []).forEach(function (p) {
            if (paths.length && geoDistance({ lng: paths[paths.length - 1][0], lat: paths[paths.length - 1][1] }, { lng: p[0], lat: p[1] }) < 0.5) return;
            paths.push(p);
          });
        });
        totalDist += Math.max(0, segmentDist);
        totalTime += Math.max(0, segmentTime);
      });
      rt.roadM = totalDist;
      rt.roadKm = totalDist / 1000;
      rt.durationMin = Math.round(totalTime / 60);
      rt._replannedSegments = requested;
      evaluateRoutePasses(rt, paths, passSteps);

      var missedSkippedIndexes = skippedIndexes.filter(function (stopIndex) {
        return !rt.stops[stopIndex].passedWithinRadius;
      });
      if (missedSkippedIndexes.length && refinementPass < 1) {
        rt._forcedRoutingAnchorAids = rt._forcedRoutingAnchorAids || {};
        missedSkippedIndexes.forEach(function (stopIndex) {
          rt._forcedRoutingAnchorAids[forceKey(rt.stops[stopIndex], stopIndex)] = true;
        });
        rt._directionlessRefined = true;
        searchDriving(rt, i, color, cb, refinementPass + 1);
        return;
      }
      drawRoutePolyline(paths, color, i, 0.8);
      rt.stops.forEach(function (s, si) { drawRouteMarker(s, si, color, i); });
      cb();
    }
    pump();
  }

  plan.routes.forEach(function (rt, i) {
    var color = RCOLORS[i % RCOLORS.length];
    searchDriving(rt, i, color, finishOne);
  });
}

function renderOverlapLines() {
  if (routePathData.length < 2 || !map) return;
  var OVERLAP_THRESHOLD = 30;
  var OFFSET_METERS = 8;

  function distM(a, b) {
    var dLat = toRad(b[1] - a[1]);
    var dLng = toRad(b[0] - a[0]);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function perpVecs(path, k) {
    var lng = path[k][0], lat = path[k][1];
    var dx, dy;
    if (k < path.length - 1) {
      dx = path[k + 1][0] - lng;
      dy = path[k + 1][1] - lat;
    } else {
      dx = lng - path[k - 1][0];
      dy = lat - path[k - 1][1];
    }
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) return { px: 0, py: 0 };
    var px = -dy / len;
    var py = dx / len;
    var latPerM = 1 / 111320;
    var lngPerM = 1 / (111320 * Math.cos(toRad(lat)));
    return { px: px * lngPerM, py: py * latPerM };
  }

  function findOverlapRanges(pathA, pathB) {
    var maxSample = 150;
    var step = Math.max(1, Math.floor(Math.max(pathA.length, pathB.length) / maxSample));
    var sA = step === 1 ? pathA : [];
    var sB = step === 1 ? pathB : [];
    if (step > 1) {
      for (var k = 0; k < pathA.length; k += step) sA.push(pathA[k]);
      for (var k = 0; k < pathB.length; k += step) sB.push(pathB[k]);
    }
    var ranges = [];
    var inOverlap = false;
    var start = -1;
    for (var k = 0; k < sA.length; k++) {
      var minD = Infinity;
      for (var m = 0; m < sB.length; m++) {
        var d = distM(sA[k], sB[m]);
        if (d < minD) minD = d;
      }
      if (minD < OVERLAP_THRESHOLD) {
        if (!inOverlap) { inOverlap = true; start = k; }
      } else {
        if (inOverlap && k - start >= 2) {
          ranges.push({ from: start * step, to: Math.min((k - 1) * step, pathA.length - 1) });
        }
        inOverlap = false;
      }
    }
    if (inOverlap && sA.length - start >= 2) {
      ranges.push({ from: start * step, to: Math.min((sA.length - 1) * step, pathA.length - 1) });
    }
    return ranges;
  }

  mainRouteLines.forEach(function (l) {
    try { l.setMap(null); } catch (_) {}
  });
  mainRouteLines = [];

  var rawRanges = [];
  for (var i = 0; i < routePathData.length; i++) rawRanges.push([]);
  for (var i = 0; i < routePathData.length; i++) {
    for (var j = i + 1; j < routePathData.length; j++) {
      var rA = findOverlapRanges(routePathData[i].path, routePathData[j].path);
      var rB = findOverlapRanges(routePathData[j].path, routePathData[i].path);
      for (var k = 0; k < rA.length; k++) rawRanges[i].push(rA[k]);
      for (var k = 0; k < rB.length; k++) rawRanges[j].push(rB[k]);
    }
  }

  var overlapRanges = [];
  for (var i = 0; i < routePathData.length; i++) {
    rawRanges[i].sort(function (a, b) { return a.from - b.from; });
    var merged = [];
    for (var k = 0; k < rawRanges[i].length; k++) {
      var r = rawRanges[i][k];
      if (merged.length === 0 || merged[merged.length - 1].to + 5 < r.from) {
        merged.push({ from: r.from, to: r.to });
      } else {
        merged[merged.length - 1].to = Math.max(merged[merged.length - 1].to, r.to);
      }
    }
    for (var k = 0; k < merged.length; k++) {
      var r = merged[k];
      var midPt = routePathData[i].path[Math.floor((r.from + r.to) / 2)];
      var participants = [i];
      for (var j = 0; j < routePathData.length; j++) {
        if (j === i) continue;
        for (var m = 0; m < rawRanges[j].length; m++) {
          var rj = rawRanges[j][m];
          var midJ = routePathData[j].path[Math.floor((rj.from + rj.to) / 2)];
          if (distM(midPt, midJ) < OVERLAP_THRESHOLD * 3) { participants.push(j); break; }
        }
      }
      participants.sort(function (a, b) { return a - b; });
      r.participants = participants;
    }
    overlapRanges.push(merged);
  }

  function drawNormalPolyline(path, color, idx, showDir) {
    if (path.length < 2) return;
    try {
      var line = new AMap.Polyline({
        path: path,
        strokeColor: color,
        strokeWeight: 5,
        strokeOpacity: 0.8,
        showDir: showDir || false,
        zIndex: 120 + idx
      });
      line.setMap(map);
      routeOverlays.push(line);
      mainRouteLines.push(line);
    } catch (_) {}
  }

  function drawOffsetPolyline(path, offsetM, color, idx) {
    if (path.length < 2) return;
    var pts = [];
    for (var k = 0; k < path.length; k++) {
      var v = perpVecs(path, k);
      pts.push([path[k][0] + offsetM * v.px, path[k][1] + offsetM * v.py]);
    }
    try {
      var line = new AMap.Polyline({
        path: pts,
        strokeColor: color,
        strokeWeight: 4,
        strokeOpacity: 0.9,
        zIndex: 250
      });
      line.setMap(map);
      routeOverlays.push(line);
    } catch (_) {}
  }

  for (var i = 0; i < routePathData.length; i++) {
    var path = routePathData[i].path;
    var color = routePathData[i].color;
    var groups = overlapRanges[i];

    if (groups.length === 0) {
      drawNormalPolyline(path, color, i, true);
      continue;
    }

    var cursor = 0;
    for (var k = 0; k < groups.length; k++) {
      var g = groups[k];
      if (cursor < g.from) {
        drawNormalPolyline(path.slice(cursor, g.from + 1), color, i, true);
      }
      var overlapSeg = path.slice(g.from, g.to + 1);
      if (overlapSeg.length >= 2) {
        var n = g.participants.length;
        var pos = g.participants.indexOf(i);
        var offset = (pos - (n - 1) / 2) * OFFSET_METERS * 2;
        drawOffsetPolyline(overlapSeg, offset, color, i);
      }
      cursor = g.to + 1;
    }
    if (cursor < path.length - 1) {
      drawNormalPolyline(path.slice(cursor), color, i, true);
    }
  }
}

function boardingStopPhysicalCoord(stop) {
  return [
    stop.stopLng != null ? stop.stopLng : stop.lng,
    stop.stopLat != null ? stop.stopLat : stop.lat
  ];
}

function safeDrivingResult(origin, destination) {
  return amapDrivingPromise(origin, destination).catch(function () { return null; });
}

function applyBoardingStopSideChoice(stop, candidate, comparison) {
  if (!stop._originalBoardingStop) {
    stop._originalBoardingStop = {
      name: stop.name,
      lng: stop.lng,
      lat: stop.lat,
      stopLng: stop.stopLng,
      stopLat: stop.stopLat,
      roadLng: stop.roadLng,
      roadLat: stop.roadLat,
      roadSnapM: stop.roadSnapM
    };
  }
  stop.name = candidate.name;
  stop.lng = candidate.lng;
  stop.lat = candidate.lat;
  stop.stopLng = candidate.lng;
  stop.stopLat = candidate.lat;
  // 候车位置使用通过道路中心线校验后的坐标；车辆的驾车途经点仍使用
  // 高德返回的道路中心锚点，不再强制驶入道路某一侧，从而避免额外掉头。
  stop.roadLng = candidate.roadLng != null ? candidate.roadLng : candidate.lng;
  stop.roadLat = candidate.roadLat != null ? candidate.roadLat : candidate.lat;
  stop.roadSnapM = candidate.roadSnapM || 0;
  stop._sideChoice = comparison;
  stop._sideGeometryChecked = !!candidate.sideGeometryChecked;
  stop._sideGeometryCorrected = !!candidate.sideGeometryCorrected;
  stop._oppositeSelected = candidate.side === 'opposite';
}

function optimizeOppositeBoardingStops(plan, onProgress) {
  var total = 0;
  plan.routes.forEach(function (route) {
    for (var i = 1; i < route.stops.length; i++) {
      if (findOtherSideBoardingStop(route.stops[i])) total++;
    }
  });
  var completed = 0;
  var stats = { compared: 0, switched: 0, oppositeSelected: 0, geometryCorrected: 0 };

  function report() {
    if (onProgress) onProgress(completed, total);
  }

  function optimizeRoute(route) {
    var chain = Promise.resolve();
    for (var stopIndex = 1; stopIndex < route.stops.length; stopIndex++) {
      (function (index) {
        chain = chain.then(function () {
          var previous = route.stops[index - 1];
          var current = route.stops[index];
          var alternative = findOtherSideBoardingStop(current);
          if (!alternative) return;
          var originCoord = boardingStopPhysicalCoord(previous);
          var currentCoord = boardingStopPhysicalCoord(current);
          var alternativeCoord = [alternative.lng, alternative.lat];
          return Promise.all([
            safeDrivingResult(originCoord, currentCoord),
            safeDrivingResult(originCoord, alternativeCoord)
          ]).then(function (results) {
            stats.compared++;
            completed++;
            var currentResult = results[0];
            var alternativeResult = results[1];
            var comparison = {
              from: previous.name,
              currentName: current.name,
              alternativeName: alternative.name,
              currentDistanceM: currentResult ? Number(currentResult.dist) || 0 : null,
              currentTimeS: currentResult ? Number(currentResult.time) || 0 : null,
              alternativeDistanceM: alternativeResult ? Number(alternativeResult.dist) || 0 : null,
              alternativeTimeS: alternativeResult ? Number(alternativeResult.time) || 0 : null,
              selected: 'current'
            };
            if (preferAlternativeDrivingResult(currentResult, alternativeResult)) {
              comparison.selected = alternative.side;
              applyBoardingStopSideChoice(current, alternative, comparison);
              stats.switched++;
              if (alternative.side === 'opposite') stats.oppositeSelected++;
              if (alternative.sideGeometryCorrected) stats.geometryCorrected++;
            } else {
              current._sideChoice = comparison;
            }
            report();
          });
        });
      })(stopIndex);
    }
    return chain.then(function () {
      route.metrics = routeMetrics(route.stops, plan.dest);
    });
  }

  report();
  return Promise.all(plan.routes.map(optimizeRoute)).then(function () {
    if (stats.switched) {
      // 规划矩阵基于替换前坐标；换侧后清空，防止后续超长线路优化读取旧值。
      amapDistCache = {};
      amapDistReady = false;
    }
    // 必须在旧距离矩阵失效之后重新计算指标，否则相同_aid可能继续命中
    // 替换前站点的缓存距离。真实道路里程会在随后绘制驾车路线时覆盖。
    plan.routes.forEach(function (route) {
      route.metrics = routeMetrics(route.stops, plan.dest);
    });
    return stats;
  });
}

function runPlan(n, dest, manualStartRegionIds, sourcePoints, runOptions) {
  runOptions = runOptions || {};
  var runId = runOptions.runId != null ? runOptions.runId : beginRoutePlanRun();
  function isCurrentRun() { return isRoutePlanRunActive(runId); }
  if (!isCurrentRun()) return;
  var points = (sourcePoints || getPickupPoints()).map(function (p) {
    var copy = {};
    Object.keys(p).forEach(function (key) { copy[key] = p[key]; });
    copy.stopNames = (p.stopNames || []).slice();
    return copy;
  });
  if (points.length === 0) {
    $('routeMsg').textContent = '无可用上车点';
    $('routeMsg').className = 'msg error';
    $('routeBtn').disabled = false;
    $('replanCurrentStopsBtn').disabled = false;
    return;
  }

  $('routeMsg').textContent = '正在准备规划数据...';
  $('routeMsg').className = 'msg';

  snapStopsToRoads(points, function () {
    if (!isCurrentRun()) return;
    var roadStats = prepareRoadRoutingPoints(points);
    var snappedCount = roadStats.matched;
    var units = expandCapacityUnits(points);
    var manualStartError = '';
    if (manualStartRegionIds && manualStartRegionIds.length) {
      manualStartRegionIds.forEach(function (regionIdx, routeIdx) {
        var selected = null;
        for (var ui = 0; ui < units.length; ui++) {
          if (units[ui].regionIdx === regionIdx && (selected == null || units[ui].part === 0)) selected = units[ui];
          if (selected && selected.part === 0) break;
        }
        if (!selected) manualStartError = '线路' + (routeIdx + 1) + '的手动起点已不在可规划站点中';
        else selected._manualStartIndex = routeIdx;
      });
    }
    if (manualStartError) {
      $('routeMsg').textContent = manualStartError;
      $('routeMsg').className = 'msg error';
      $('routeBtn').disabled = false;
      $('replanCurrentStopsBtn').disabled = false;
      return;
    }
    // 不同运行可能复用容量单元编号，因此缓存的点对距离不能串到其他数据集、
    // 工厂或道路纠偏结果中。
    var runDistCache = {};
    amapDistCache = runDistCache;
    amapDistReady = false;
    delete dest._aid;
    var rawTotalPeople = units.reduce(function (s, u) { return s + u.people; }, 0);
    var trimResult = trimExcessUnits(units, n, dest);
    units = trimResult.units;
    if (units.length === 0) {
      $('routeMsg').textContent = '指定线路数的运力不足，无法保留可规划上车点';
      $('routeMsg').className = 'msg error';
      $('routeBtn').disabled = false;
      $('replanCurrentStopsBtn').disabled = false;
      return;
    }
    $('routeMsg').textContent = '正在规划路线，请稍候...';

    computeAmapDistMatrix(units, dest, function (done, total) {
      if (!isCurrentRun()) return;
      $('routeMsg').textContent = '正在规划路线，请稍候...';
    }, runDistCache).then(function () {
    if (!isCurrentRun()) return;
    dest._aid = 'dest';
    var plan = planRoutes(n, dest, units, { rawTotalPeople: rawTotalPeople, removed: trimResult.removed });
    $('routeMsg').textContent = '正在优化上车位置...';
    return optimizeOppositeBoardingStops(plan, function (done, total) {
      if (!isCurrentRun()) return;
      $('routeMsg').textContent = '正在优化上车位置...';
    }).then(function (sideStats) {
    if (!isCurrentRun()) return;
    plan.sideComparedCount = sideStats.compared;
    plan.sideSwitchedCount = sideStats.switched;
    plan.oppositeSelectedCount = sideStats.oppositeSelected;
    plan.oppositeGeometryCorrectedCount = sideStats.geometryCorrected;
    plan.replannedFromAdjustedStops = !!runOptions.replannedFromAdjustedStops;
    plan.roadSnappedCount = snappedCount;
    plan.roadFallbackCount = roadStats.fallback;
    plan.manualDeletedCount = 0;
    plan.manualDeletedPeople = 0;
    plan.manualAddedCount = 0;
    plan.manualAddedPeople = 0;
    routeSegmentCache = {};
    manualRouteVias = {};
    selectedRouteIndex = -1;
    selectedStopIndex = -1;
    selectedSwapStopAid = null;
    clearNearbyStopMarkers();
    clearManualPreview();
    clearManualAddStopSelection(true);
    routePlans = plan;
    if (plan.numRoutes !== n) {
      $('routeCount').value = plan.numRoutes;
    }
    clearMapMarkers();
    clearRouteOverlays();
    routePathData = [];
    drawRoutesOnMap(plan, function () {
      if (!isCurrentRun()) return;
      optimizeOverlength(plan, 0, n, dest, null);
    }, isCurrentRun);

    function syncPlanTotals(plan) {
      plan.totalPeople = plan.routes.reduce(function (s, r) { return s + r.metrics.people; }, 0);
      plan.totalStops = plan.routes.reduce(function (s, r) { return s + r.metrics.stopCount; }, 0);
      plan.numRoutes = plan.routes.length;
    }

    function optimizeOverlength(plan, iter, n, dest, state) {
      if (!isCurrentRun()) return;
      state = state || { seen: Object.create(null), accepted: 0, attempts: 0, consecutiveFailures: 0 };
      var currentSignature = routeAssignmentSignature(plan.routes);
      state.seen[currentSignature] = true;
      var currentScore = routeConstraintOptimizationScore(plan.routes);
      if (currentScore.violations === 0) {
        finishRouteUI(plan, n, dest, state.accepted, state.attempts, state.consecutiveFailures);
        return;
      }

      var snapshot = cloneRoutesForOptimization(plan.routes);
      var changed = false;
      var alternativeIndex = state.consecutiveFailures;
      state.attempts++;
      var attemptNumber = state.attempts;
      var hasNonDistanceViolation = plan.routes.some(function (route) {
        return route.metrics.people < ROUTE_MIN_PEOPLE || route.metrics.people > ROUTE_MAX_PEOPLE ||
          route.metrics.stopCount < ROUTE_MIN_STOPS;
      });

      function failAttempt(reason, candidateSignature) {
        if (candidateSignature) state.seen[candidateSignature] = true;
        plan.routes = snapshot;
        syncPlanTotals(plan);
        state.consecutiveFailures++;

        if (shouldStopConstraintReplanning(state.consecutiveFailures, MAX_CONSECUTIVE_REPLAN_FAILURES)) {
          $('routeMsg').textContent = '已完成优化，正在显示当前最佳方案...';
          drawRoutesOnMap(plan, function () {
            if (!isCurrentRun()) return;
            finishRouteUI(plan, n, dest, state.accepted, state.attempts, state.consecutiveFailures);
          }, isCurrentRun);
          return;
        }

        $('routeMsg').textContent = '正在继续优化超限线路...';
        setTimeout(function () {
          if (!isCurrentRun()) return;
          optimizeOverlength(plan, iter + 1, n, dest, state);
        }, 0);
      }

      // 人数和站点数超限时先运行硬约束修复；它可能移动容量单元或合并低载线路。
      if (hasNonDistanceViolation) {
        var repaired;
        if (alternativeIndex === 0) {
          repaired = repairHardConstraints(plan.routes, dest);
        } else {
          // 后续候选改用线路再均衡；第三次再叠加横向离群点修复，扩大候选差异。
          repaired = balanceRoutes(plan.routes.map(function (route) { return route.stops; }), dest);
          if (alternativeIndex >= 2) repaired = fixLateralOutliers(repaired, dest);
        }
        if (routeAssignmentSignature(repaired) !== currentSignature) {
          plan.routes = repaired;
          changed = true;
        }
      }

      // 若硬约束修复没有产生新方案，再针对真实驾车里程超限线路移动绕路站点。
      if (!changed) {
        var order = plan.routes.map(function (rt, idx) { return { rt: rt, idx: idx }; })
          .sort(function (a, b) { return (b.rt.roadKm || 0) - (a.rt.roadKm || 0); });
        order.forEach(function (item) {
          var rt = item.rt;
          if (rt.roadKm != null && rt.roadKm > ROUTE_MAX_KM && rt.stops.length > 2) {
            if (trimDetourStops(rt, dest, plan.routes, item.idx, alternativeIndex)) changed = true;
          }
        });
      }

      plan.routes = plan.routes.filter(function (route) { return route.stops && route.stops.length > 0; });
      syncPlanTotals(plan);
      if (!changed) {
        failAttempt('无法生成新的有效分配');
        return;
      }

      var candidateSignature = routeAssignmentSignature(plan.routes);
      if (state.seen[candidateSignature]) {
        // 已评估过的分配只计为本轮失败；达到连续三次后才会停止。
        failAttempt('与已评估方案重复', candidateSignature);
        return;
      }

      state.seen[candidateSignature] = true;
      $('routeMsg').textContent = '正在优化超限线路...';
      drawRoutesOnMap(plan, function () {
        if (!isCurrentRun()) return;
        var candidateScore = routeConstraintOptimizationScore(plan.routes);
        if (isBetterRouteConstraintScore(candidateScore, currentScore)) {
          state.accepted++;
          state.consecutiveFailures = 0;
          optimizeOverlength(plan, iter + 1, n, dest, state);
          return;
        }

        // 新方案没有降低超限条数/程度，也没有明显缩短总里程，记一次连续失败并继续。
        failAttempt('未改善约束', candidateSignature);
      }, isCurrentRun);
    }

    function finishRouteUI(plan, n, dest, acceptedReplans, attemptedReplans, consecutiveFailures) {
      if (!isCurrentRun()) return;
      syncPlanTotals(plan);
      plan.coverageComplete = plan.totalPeople === plan.rawTotalPeople - plan.removedPeople;
      renderRouteList(plan);
      switchRouteWorkspace('results');
      var hard = 0, fallbackRoutes = 0, missedTotal = 0;
      plan.routes.forEach(function (rt) {
        var missed = rt.missedStops ? rt.missedStops.length : 0;
        missedTotal += missed;
        if (checkRoute(rt.metrics, rt.roadKm).length || missed) hard++;
        if (rt._hasFallback) fallbackRoutes++;
      });
      var notices = [];
      var msg = '规划完成：' + plan.routes.length + ' 条线路，共 ' + plan.totalPeople + ' 人，终点为' + dest.name;
      if (plan.replannedFromAdjustedStops) notices.push('已应用调整后的上车点');
      if (plan.manualStartMode) notices.push('已应用手动起点');
      if (fallbackRoutes) notices.push(fallbackRoutes + '条线路含直线估算路段');
      if (missedTotal) notices.push(missedTotal + '个上车点未被路线有效覆盖');
      if (plan.numRoutes !== n) notices.push('线路数已自动调整为' + plan.numRoutes + '条');
      if (plan.removedCount > 0) notices.push('因运力限制未纳入' + plan.removedCount + '个上车点（' + plan.removedPeople + '人）');
      if (plan.constraintBandConflict) notices.push('部分规划要求无法同时满足');
      if (!plan.coverageComplete) notices.push('规划人数与导入人数不一致');
      if (notices.length) msg += '；' + notices.join('；');
      $('routeMsg').textContent = msg;
      $('routeMsg').className = (hard || fallbackRoutes || plan.roadFallbackCount || !plan.coverageComplete || plan.constraintBandConflict) ? 'msg warn' : 'msg success';
      $('legend').style.display = 'block';
      $('legend').innerHTML =
        '<span><i class="dot" style="background:#1d4ed8"></i> 终点工厂</span>' +
        '<span><i class="dot" style="background:#dc2626"></i> 上车点</span>' +
        '<span><i class="dot" style="background:#94a3b8"></i> 驾车路线</span>';
      $('routeBtn').disabled = false;
      $('replanCurrentStopsBtn').disabled = false;
    }
    });
  }).catch(function (e) {
    if (!isCurrentRun()) return;
    $('routeMsg').textContent = '路线规划失败，无法获取道路信息，请检查网络后重试';
    $('routeMsg').className = 'msg error';
    $('routeBtn').disabled = false;
    $('replanCurrentStopsBtn').disabled = false;
  });
  });
}

$('routeBtn').addEventListener('click', function () {
  if (!results || !results.length) {
    $('routeMsg').textContent = '请先完成聚合计算';
    $('routeMsg').className = 'msg error';
    return;
  }
  var n = Math.max(1, Math.min(20, parseInt($('routeCount').value, 10) || 1));
  $('routeCount').value = n;
  var factoryKey = (document.querySelector('input[name="factory"]:checked') || {}).value || 'yinhu';
  var dest = FACTORIES[factoryKey];
  var manualStartRegionIds;
  try {
    manualStartRegionIds = readManualStartSelection(n);
  } catch (e) {
    $('routeMsg').textContent = e.message;
    $('routeMsg').className = 'msg error';
    return;
  }
  $('routeBtn').disabled = true;
  $('routeMsg').textContent = '规划中...';
  $('routeMsg').className = 'msg';
  var runId = beginRoutePlanRun();
  setTimeout(function () {
    if (!isRoutePlanRunActive(runId)) return;
    try { runPlan(n, dest, manualStartRegionIds, null, { runId: runId }); } catch (e) {
      if (!isRoutePlanRunActive(runId)) return;
      $('routeMsg').textContent = '失败: ' + e.message;
      $('routeMsg').className = 'msg error';
      $('routeBtn').disabled = false;
    }
  }, 40);
});

$('routeStartMode').addEventListener('change', function () {
  refreshManualStartSelectors();
  if ($('routeStartMode').value === 'manual' && results && results.length) {
    renderRegions(lastMaxDist);
    $('routeMsg').textContent = '请先选择线路1，再在地图上点击其起点站';
    $('routeMsg').className = 'msg';
  }
});
$('routeCount').addEventListener('input', refreshManualStartSelectors);

function currentAdjustedPickupPointsForReplan() {
  if (!routePlans) return { points: [], preservesManualStarts: false };
  var points = [];
  routePlans.routes.forEach(function (rt) {
    rt.stops.forEach(function (s) {
      points.push({
        id: points.length,
        name: s.name,
        lng: s.stopLng != null ? s.stopLng : s.lng,
        lat: s.stopLat != null ? s.stopLat : s.lat,
        people: s.people,
        stopCount: s.stopCount,
        stopNames: (s.stopNames || []).slice(),
        regionIdx: points.length,
        _manualStartIndex: s._manualStartIndex != null ? s._manualStartIndex : null
      });
    });
  });

  var routeCount = routePlans.routes.length;
  var fixed = points.filter(function (p) { return p._manualStartIndex != null; });
  var seen = {};
  fixed.forEach(function (p) { seen[p._manualStartIndex] = (seen[p._manualStartIndex] || 0) + 1; });
  var validFixedStarts = fixed.length === routeCount;
  for (var i = 0; i < routeCount; i++) if (seen[i] !== 1) validFixedStarts = false;
  if (!validFixedStarts) points.forEach(function (p) { p._manualStartIndex = null; });
  return { points: points, preservesManualStarts: validFixedStarts };
}

$('replanCurrentStopsBtn').addEventListener('click', function () {
  if (!routePlans || !routePlans.routes.length) return;
  var current = currentAdjustedPickupPointsForReplan();
  if (!current.points.length) {
    $('routeMsg').textContent = '当前线路中没有可用于重新规划的上车点';
    $('routeMsg').className = 'msg error';
    return;
  }
  if (typeof window.confirm === 'function' && !window.confirm('将保留当前删除或修改后的上车点，但重新计算所有站点的线路归属和顺序；已有局部改道将被清除。是否继续？')) return;
  var n = routePlans.routes.length;
  var dest = { name: routePlans.dest.name, lng: routePlans.dest.lng, lat: routePlans.dest.lat };
  if (!current.preservesManualStarts) {
    $('routeStartMode').value = 'auto';
    manualStartSelections = [];
    refreshManualStartSelectors();
  }
  $('routeCount').value = n;
  $('routeBtn').disabled = true;
  $('replanCurrentStopsBtn').disabled = true;
  $('routeMsg').textContent = '正在按手动调整后的上车点重新进行全局规划...';
  $('routeMsg').className = 'msg';
  var runId = beginRoutePlanRun();
  setTimeout(function () {
    if (!isRoutePlanRunActive(runId)) return;
    try {
      runPlan(n, dest, null, current.points, { replannedFromAdjustedStops: true, runId: runId });
    } catch (e) {
      if (!isRoutePlanRunActive(runId)) return;
      $('routeMsg').textContent = '重新规划失败: ' + e.message;
      $('routeMsg').className = 'msg error';
      $('routeBtn').disabled = false;
      $('replanCurrentStopsBtn').disabled = false;
    }
  }, 40);
});

function setRouteImportMessage(message, type) {
  $('routeImportMsg').textContent = message || '';
  $('routeImportMsg').className = 'msg' + (type ? ' ' + type : '');
}

function finishImportedRouteDisplay(plan) {
  if (routePlans !== plan) return;
  renderRouteList(plan);
  switchRouteWorkspace('results');
  var fallbackRoutes = plan.routes.filter(function (route) { return route._hasFallback; }).length;
  $('routeMsg').textContent = '已从 Excel 导入并显示 ' + plan.routes.length + ' 条线路，共 ' +
    plan.routes.reduce(function (sum, route) { return sum + route.stops.length; }, 0) + ' 个上车点。' +
    (fallbackRoutes ? '（' + fallbackRoutes + '条线路含直线估测段）' : '');
  $('routeMsg').className = fallbackRoutes ? 'msg warn' : 'msg success';
  setRouteImportMessage('导入完成：' + plan.routes.length + '条线路已全部显示到地图上。', fallbackRoutes ? 'warn' : 'success');
  $('legend').style.display = 'block';
  $('legend').innerHTML =
    '<span><i class="dot" style="background:#1d4ed8"></i> 终点</span>' +
    '<span><i class="dot" style="background:#dc2626"></i> 导入的上车点（序号）</span>' +
    '<span><i class="dot" style="background:#94a3b8"></i> 驾车路线</span>';
}

function drawImportedRoutePlan(plan) {
  if (!plan || routePlans !== plan) return;
  var runId = plan._importRunId;
  var isActive = function () { return routePlans === plan && isRoutePlanRunActive(runId); };
  if (!map || typeof AMap === 'undefined' || !drivingInst) {
    setRouteImportMessage('Excel 已读取，等待地图服务加载后自动显示全部线路。', 'warn');
    return;
  }
  setRouteImportMessage('正在根据 Excel 中的站点顺序绘制 ' + plan.routes.length + ' 条线路...', '');
  $('routeMsg').textContent = '正在获取导入线路的驾车路径...';
  $('routeMsg').className = 'msg';
  drawRoutesOnMap(plan, function () {
    if (!isActive()) return;
    finishImportedRouteDisplay(plan);
  }, isActive);
}

function applyImportedRoutePlan(plan, fileName) {
  cancelRoutePlanRun();
  var runId = beginRoutePlanRun();
  plan._importRunId = runId;
  plan.importFileName = fileName || '';
  routeSegmentCache = {};
  manualRouteVias = {};
  amapDistCache = {};
  amapDistReady = false;
  selectedRouteIndex = -1;
  selectedStopIndex = -1;
  selectedSwapStopAid = null;
  selectedSubsequentStopAid = null;
  clearNearbyStopMarkers();
  clearManualPreview();
  clearManualAddStopSelection(true);
  clearMapMarkers();
  clearRouteOverlays();
  routePathData = [];
  routePlans = plan;
  $('routeCard').classList.remove('hidden');
  $('routeCount').value = plan.routes.length;
  $('routeStartMode').value = 'auto';
  $('manualStartPanel').classList.add('hidden');
  $('routeBtn').disabled = !(results && results.length);
  $('replanCurrentStopsBtn').disabled = false;
  renderRouteList(plan);
  setRouteWorkspaceAvailability(true);
  switchRouteWorkspace('results');
  drawImportedRoutePlan(plan);
}

$('routeExcelInput').addEventListener('change', function () {
  var file = this.files && this.files[0];
  $('importRouteExcelBtn').disabled = !file;
  setRouteImportMessage(file ? '已选择：' + file.name : '', '');
});

$('importRouteExcelBtn').addEventListener('click', function () {
  var file = $('routeExcelInput').files && $('routeExcelInput').files[0];
  if (!file) return;
  if (typeof readRouteExcelFile !== 'function') {
    setRouteImportMessage('路线 Excel 解析模块未加载，请刷新页面后重试。', 'error');
    return;
  }
  var button = $('importRouteExcelBtn');
  button.disabled = true;
  setRouteImportMessage('正在读取并校验 Excel 中的全部线路...', '');
  readRouteExcelFile(file).then(function (plan) {
    applyImportedRoutePlan(plan, file.name);
  }).catch(function (error) {
    setRouteImportMessage('导入失败：' + error.message, 'error');
  }).finally(function () {
    button.disabled = false;
  });
});

$('downloadRouteBtn').addEventListener('click', function () {
  if (!routePlans) return;
  if (typeof XLSX === 'undefined') {
    alert('Excel 组件加载失败，请刷新页面后重试');
    return;
  }

  var wb = XLSX.utils.book_new();

  // --- 线路汇总工作表 ---
  var summaryRows = [['线路编号', '起点', '上车点数量', '覆盖站点数', '覆盖人数', '总里程(km)', '预估时间(分钟)', '途经道路']];
  routePlans.routes.forEach(function (rt, ri) {
    var m = rt.metrics;
    var km = rt.roadKm != null ? rt.roadKm.toFixed(2) : m.estRoadKm.toFixed(2);
    var dur = rt.durationMin != null ? rt.durationMin : '--';
    var firstStop = rt.stops.length ? rt.stops[0].name : '';
    summaryRows.push([
      '线路' + (ri + 1),
      firstStop,
      m.boardingCount,
      m.stopCount,
      m.people,
      km,
      dur,
      m.names.join(' → ') + ' → ' + routePlans.dest.name
    ]);
  });
  var wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary['!cols'] = [
    { wch: 10 }, { wch: 18 }, { wch: 12 }, { wch: 12 },
    { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 60 }
  ];
  XLSX.utils.book_append_sheet(wb, wsSummary, '线路汇总');

  // --- 每条线路一个工作表 ---
  routePlans.routes.forEach(function (rt, ri) {
    var m = rt.metrics;
    var km = rt.roadKm != null ? rt.roadKm.toFixed(2) : m.estRoadKm.toFixed(2);
    var dur = rt.durationMin != null ? rt.durationMin : '--';
    var rows = [
      ['线路编号', '线路' + (ri + 1)],
      ['终点', routePlans.dest.name],
      ['起点', rt.stops.length ? rt.stops[0].name : ''],
      ['上车点数量', m.boardingCount],
      ['覆盖站点数', m.stopCount],
      ['覆盖人数', m.people],
      ['总里程(km)', km],
      ['预估时间(分钟)', dur],
      ['途经道路列表', m.names.join(' → ') + ' → ' + routePlans.dest.name],
      [''],  // 空白行。
      ['顺序', '上车点', '上车点经度', '上车点纬度', '道路途经经度', '道路途经纬度', '站点所在道路', '道路偏移(m)', '距实际路线(m)', '道路双向经过', '本点人数', '覆盖站点数']
    ];
    rt.stops.forEach(function (s, si) {
      rows.push([
        si + 1,
        s.name,
        (s.stopLng != null ? s.stopLng : s.lng).toFixed(6),
        (s.stopLat != null ? s.stopLat : s.lat).toFixed(6),
        s.lng.toFixed(6),
        s.lat.toFixed(6),
        s.roadName || '',
        Math.round(s.roadSnapM || 0),
        isFinite(s.passDistanceM) ? Number(s.passDistanceM.toFixed(1)) : '--',
        s.passedWithinRadius === true ? '是' : (s.passedWithinRadius === false ? '否' : '未校验'),
        s.people,
        s.stopCount
      ]);
    });
    rows.push([
      rt.stops.length + 1,
      routePlans.dest.name + '(终点)',
      routePlans.dest.lng.toFixed(6),
      routePlans.dest.lat.toFixed(6),
      routePlans.dest.lng.toFixed(6),
      routePlans.dest.lat.toFixed(6),
      '', 0, 0, '是', 0, 0
    ]);
    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [
      { wch: 10 }, { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 16 },
      { wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, '线路' + (ri + 1));
  });

  XLSX.writeFile(wb, '线路规划结果.xlsx');
});

// --- 导出线路地图 ---
$('exportMapBtn').addEventListener('click', function () {
  if (!routePlans) return;
  exportRouteMap(routePlans);
});

function exportRouteMap(plan) {
  var W = 1600, H = 1200;
  var MARGIN = 80;
  var canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  var ctx = canvas.getContext('2d');

  // 绘制背景。
  ctx.fillStyle = '#f8f9fa';
  ctx.fillRect(0, 0, W, H);

  // 收集所有坐标。
  var allLngs = [plan.dest.lng], allLats = [plan.dest.lat];
  plan.routes.forEach(function (rt) {
    rt.stops.forEach(function (s) {
      allLngs.push(s.lng);
      allLats.push(s.lat);
    });
  });
  routePathData.forEach(function (routePath) {
    (routePath.path || []).forEach(function (p) {
      allLngs.push(p[0]); allLats.push(p[1]);
    });
  });
  var minLng = Math.min.apply(null, allLngs);
  var maxLng = Math.max.apply(null, allLngs);
  var minLat = Math.min.apply(null, allLats);
  var maxLat = Math.max.apply(null, allLats);

  // 为边界框增加留白。
  var padLng = (maxLng - minLng) * 0.1 || 0.01;
  var padLat = (maxLat - minLat) * 0.1 || 0.01;
  minLng -= padLng; maxLng += padLng;
  minLat -= padLat; maxLat += padLat;

  // 扩展范围以保持宽高比。
  var rangeLng = maxLng - minLng || 0.1;
  var rangeLat = maxLat - minLat || 0.1;
  var scaleW = (W - MARGIN * 2) / rangeLng;
  var scaleH = (H - MARGIN * 2) / rangeLat;
  var scale = Math.min(scaleW, scaleH);
  var cx = (W - rangeLng * scale) / 2;
  var cy = (H - rangeLat * scale) / 2;

  function px(lng, lat) {
    return [cx + (lng - minLng) * scale, cy + (maxLat - lat) * scale];
  }

  // 绘制标题。
  ctx.fillStyle = '#1c1c1c';
  ctx.font = 'bold 28px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('班车线路规划图 → ' + plan.dest.name, W / 2, 48);
  ctx.font = '16px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle = '#666';
  ctx.fillText('共 ' + plan.numRoutes + ' 条线路  |  覆盖 ' + plan.totalPeople + ' 人', W / 2, 72);

  // 绘制终点标记。
  var dp = px(plan.dest.lng, plan.dest.lat);
  ctx.fillStyle = '#1d4ed8';
  ctx.beginPath();
  ctx.arc(dp[0], dp[1], 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#1d4ed8';
  ctx.font = 'bold 13px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(plan.dest.name, dp[0], dp[1] + 24);

  // 绘制右侧图例区域。
  var legX = W - MARGIN - 320;
  var legY = MARGIN + 10;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(legX, legY, 310, 22 + plan.routes.length * 70 + 10, 8);
  ctx.fill();
  ctx.stroke();

  // 绘制每条线路。
  plan.routes.forEach(function (rt, i) {
    var color = RCOLORS[i % RCOLORS.length];
    var m = rt.metrics;
    var km = rt.roadKm != null ? rt.roadKm.toFixed(1) : m.estRoadKm.toFixed(1);
    var dur = rt.durationMin != null ? rt.durationMin + 'min' : '--';

    // 绘制线路折线。
    var actualPath = routePathData[i] && routePathData[i].path && routePathData[i].path.length ? routePathData[i].path : null;
    var path = actualPath ? actualPath.map(function (p) { return px(p[0], p[1]); }) : [];
    if (!path.length) {
      rt.stops.forEach(function (s) { path.push(px(s.lng, s.lat)); });
      path.push(dp);
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(path[0][0], path[0][1]);
    for (var k = 1; k < path.length; k++) {
      ctx.lineTo(path[k][0], path[k][1]);
    }
    ctx.stroke();

    // 绘制站点标记。
    rt.stops.forEach(function (s, si) {
      var p = px(s.lng, s.lat);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p[0], p[1], si === 0 ? 7 : 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (si === 0) {
        ctx.fillStyle = '#000';
        ctx.font = 'bold 11px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('起点', p[0] + 10, p[1] + 4);
        ctx.fillStyle = '#666';
        ctx.font = '10px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.fillText(s.name, p[0] + 10, p[1] + 18);
      }
    });

    // 绘制图例条目。
    var ey = legY + 16 + i * 70;
    ctx.fillStyle = color;
    ctx.fillRect(legX + 12, ey + 2, 16, 16);
    ctx.fillStyle = '#1c1c1c';
    ctx.font = 'bold 14px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('线路' + (i + 1), legX + 36, ey + 16);
    ctx.fillStyle = '#444';
    ctx.font = '12px "PingFang SC","Microsoft YaHei",sans-serif';
    var labelText = '上车点 ' + m.boardingCount + ' · 覆盖站 ' + m.stopCount + ' · ' + m.people + '人 · ' + km + 'km · ' + dur;
    ctx.fillText(labelText, legX + 36, ey + 36);

    // 绘制从图例指向线路中点的辅助虚线。
    var midP = path[Math.floor(path.length / 2)];
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(legX, ey + 10);
    ctx.lineTo(midP[0], midP[1]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  });

  // 绘制页脚。
  ctx.fillStyle = '#999';
  ctx.font = '11px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('生成时间: ' + new Date().toLocaleString('zh-CN'), W / 2, H - 20);

  // 触发图片下载。
  var link = document.createElement('a');
  link.download = '班车线路规划图_' + plan.dest.name + '.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function clearMapMarkers() {
  mapMarkers.forEach(function (m) { m.setMap(null); });
  mapMarkers = [];
  clearOverlayList(manualStartSelectionOverlays);
  clearOverlayList(aggregationSelectionOverlays);
}

function renderRegions(maxDist) {
  if (!map || typeof AMap === 'undefined') return;
  clearMapMarkers();
  $('legend').style.display = 'block';
  $('legend').innerHTML =
    '<span><i class="dot" style="background:#dc2626"></i> 上车公交站（含人数）</span>' +
    '<span><i class="dot" style="background:#94a3b8"></i> 覆盖范围</span>' +
    ($('routeStartMode').value === 'manual' ? '<span><i class="dot" style="background:#16a34a"></i> 已选线路起点</span>' : '');

  results.forEach(function (r, i) {
    var color = RCOLORS[i % RCOLORS.length];
    var board = r.boardingStop || r.center;

    // 绘制上车点周围的覆盖范围圆。
    try {
      var cir = new AMap.Circle({
        center: [board.lng, board.lat],
        radius: maxDist,
        strokeColor: color,
        strokeWeight: 1,
        strokeOpacity: 0.2,
        fillColor: color,
        fillOpacity: 0.03,
        zIndex: 50
      });
      cir.setMap(map);
      mapMarkers.push(cir);
    } catch (_) {}

    // 绘制带人数标记的上车点。
    try {
      var labelBg = r.belowMin ? '#b45309' : color;
      var mk = new AMap.Marker({
        position: [board.lng, board.lat],
        icon: new AMap.Icon({
          size: new AMap.Size(20, 26),
          image: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png',
          imageSize: new AMap.Size(20, 26)
        }),
        offset: new AMap.Pixel(-10, -26),
        zIndex: 200,
        title: (r.boardingStop ? r.boardingStop.name : '上车点') + ' · ' + r.totalCount + '人',
        label: {
          content: '<div style="background:' + labelBg + ';color:#fff;border-radius:8px;padding:1px 5px;font-size:10px;font-weight:600;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.25)">R' + (i + 1) + ' ' + r.totalCount + '人</div>',
          direction: 'top',
          offset: new AMap.Pixel(0, -6)
        }
      });
      mk.setMap(map);
      mk.on('click', function () {
        selectAggregatedStopFromMap(i);
        handleManualStartMapSelection(i);
        hlRegion(i, r);
      });
      mapMarkers.push(mk);
    } catch (_) {}
  });

  drawManualStartHighlights();
  drawAggregationStopSelection();

  try { map.setFitView(null, false, [60, 60, 60, 380]); } catch (_) {}
}

function hlRegion(idx, r) {
  var trs = $('resultTable').querySelectorAll('tbody tr');
  trs.forEach(function (t) { t.classList.remove('highlight'); });
  var t = $('resultTable').querySelector('[data-region="' + idx + '"]');
  if (t) {
    t.classList.add('highlight');
    t.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (map) {
    var board = r.boardingStop || r.center;
    try { map.setZoomAndCenter(15, [board.lng, board.lat]); } catch (_) {}
  }
}

// ---- 下载聚合结果 ----
$('downloadBtn').addEventListener('click', function () {
  if (!results) return;
  var h = '区域编号,上车公交站,站点经度,站点纬度,到最优中心距离(m),覆盖人数,覆盖站点数,覆盖站点列表';
  var lines = [h];
  results.forEach(function (r, i) {
    var bs = r.boardingStop;
    lines.push([
      i + 1,
      bs ? bs.name : '',
      bs ? bs.lng.toFixed(6) : r.center.lng.toFixed(6),
      bs ? bs.lat.toFixed(6) : r.center.lat.toFixed(6),
      r.distToStop,
      r.totalCount,
      r.stopCount,
      '"' + r.stopNames.join('; ') + '"'
    ].join(','));
  });
  var blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '区域聚合结果.csv';
  a.click();
});

// ---- 重置页面 ----
$('resetBtn').addEventListener('click', function () {
  cancelRoutePlanRun();
  summaryData = null;
  results = null;
  routePlans = null;
  routeSegmentCache = {};
  manualRouteVias = {};
  selectedRouteIndex = -1;
  selectedStopIndex = -1;
  selectedSwapStopAid = null;
  manualViaMode = false;
  clearNearbyStopMarkers();
  clearManualPreview();
  clearManualAddStopSelection(true);
  $('summaryInput').value = '';
  $('fileMsg').textContent = '';
  $('configCard').classList.add('hidden');
  $('resultCard').classList.add('hidden');
  $('routeCard').classList.add('hidden');
  $('routeList').innerHTML = '';
  $('routeStats').innerHTML = '';
  $('routeMsg').textContent = '';
  $('routeStartMode').value = 'auto';
  manualStartSelections = [];
  manualStartActiveRoute = 0;
  selectedAggregationRegion = -1;
  aggregationDeletedCount = 0;
  aggregationDeletedPeople = 0;
  clearOverlayList(aggregationSelectionOverlays);
  $('deleteAggregatedStopBtn').disabled = true;
  $('aggregationStopSelectionInfo').textContent = '点击地图上的上车点，可选择并删除该聚合上车点';
  $('manualStartPanel').classList.add('hidden');
  $('manualStartList').innerHTML = '';
  $('routeActions').classList.add('hidden');
  $('manualEditPanel').classList.add('hidden');
  setRouteWorkspaceAvailability(false);
  switchRouteWorkspace('setup', { keepScroll: true, instant: true });
  $('routeExcelInput').value = '';
  $('importRouteExcelBtn').disabled = true;
  setRouteImportMessage('', '');
  $('runBtn').disabled = false;
  $('routeBtn').disabled = false;
  $('replanCurrentStopsBtn').disabled = false;
  $('runMsg').textContent = '';
  clearMapMarkers();
  clearRouteOverlays();
  amapDistCache = {};
  amapDistReady = false;
  $('legend').style.display = 'none';
});

// ---- 初始化地图 ----
window.initMap = function () {
  try {
    map = new AMap.Map('map', { center: [118.376451, 31.326319], zoom: 12, mapStyle: 'amap://styles/grey' });
    map.on('click', handleManualMapClick);
    var hint = $('map').querySelector('.map-hint');
    if (hint) hint.style.display = 'none';
    AMap.plugin(['AMap.Driving', 'AMap.Geocoder', 'AMap.PlaceSearch'], function () {
      drivingInst = new AMap.Driving({
        policy: AMap.DrivingPolicy.LEAST_DISTANCE,
        map: null,
        autoFitView: false
      });
      geocoderInst = new AMap.Geocoder({ city: '芜湖市' });
      placeSearchInst = new AMap.PlaceSearch({ city: '芜湖市', citylimit: true, pageSize: 50, pageIndex: 1, extensions: 'base' });
      if (routePlans && routePlans.importedFromExcel) drawImportedRoutePlan(routePlans);
    });
  } catch (e) {}
};
