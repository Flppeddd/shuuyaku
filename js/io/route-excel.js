// 将路线工作簿导入为地图渲染所使用的统一规划数据结构。
(function () {
  function text(value) {
    return value == null ? '' : String(value).trim();
  }

  function normalized(value) {
    return text(value).replace(/\s+/g, '').replace(/[（]/g, '(').replace(/[）]/g, ')');
  }

  function number(value) {
    if (typeof value === 'number') return isFinite(value) ? value : NaN;
    var raw = text(value);
    if (!raw) return NaN;
    var cleaned = raw.replace(/,/g, '').replace(/[^0-9.\-+]/g, '');
    if (!cleaned || cleaned === '+' || cleaned === '-' || cleaned === '.') return NaN;
    var parsed = Number(cleaned);
    return isFinite(parsed) ? parsed : NaN;
  }

  function findColumn(headers, aliases) {
    var normalizedAliases = aliases.map(normalized);
    for (var i = 0; i < headers.length; i++) {
      if (normalizedAliases.indexOf(normalized(headers[i])) >= 0) return i;
    }
    return -1;
  }

  function findHeader(rows) {
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r] || [];
      var nameIndex = findColumn(row, ['上车点', '站点', '站点名称', '名称']);
      var lngIndex = findColumn(row, ['道路途经经度', '上车点经度', '经度', 'lng', 'longitude']);
      var latIndex = findColumn(row, ['道路途经纬度', '上车点纬度', '纬度', 'lat', 'latitude']);
      if (nameIndex >= 0 && lngIndex >= 0 && latIndex >= 0) return { rowIndex: r, headers: row };
    }
    return null;
  }

  function metadata(rows, key) {
    var wanted = normalized(key);
    for (var i = 0; i < rows.length; i++) {
      if (normalized((rows[i] || [])[0]) === wanted) return (rows[i] || [])[1];
    }
    return '';
  }

  function endpointName(name) {
    return /(?:\(|（)终点(?:\)|）)|终点$/.test(name);
  }

  function cleanEndpointName(name) {
    return text(name).replace(/(?:\(|（)终点(?:\)|）)/g, '').replace(/终点$/g, '').trim();
  }

  function factoryByName(name) {
    if (typeof FACTORIES === 'undefined') return null;
    var wanted = normalized(name);
    var keys = Object.keys(FACTORIES);
    for (var i = 0; i < keys.length; i++) {
      var factory = FACTORIES[keys[i]];
      if (normalized(factory.name) === wanted || wanted.indexOf(normalized(factory.name)) >= 0) {
        return { name: factory.name, lng: Number(factory.lng), lat: Number(factory.lat) };
      }
    }
    return null;
  }

  function routeGroupsFromSheet(sheetName, rows) {
    var header = findHeader(rows);
    if (!header) return [];
    var headers = header.headers;
    var nameCol = findColumn(headers, ['上车点', '站点', '站点名称', '名称']);
    var orderCol = findColumn(headers, ['顺序', '站序', '序号']);
    var routeCol = findColumn(headers, ['线路编号', '路线编号', '线路', '路线']);
    var originalLngCol = findColumn(headers, ['上车点经度', '站点经度', '原始经度']);
    var originalLatCol = findColumn(headers, ['上车点纬度', '站点纬度', '原始纬度']);
    var roadLngCol = findColumn(headers, ['道路途经经度', '道路经度', '经度', 'lng', 'longitude']);
    var roadLatCol = findColumn(headers, ['道路途经纬度', '道路纬度', '纬度', 'lat', 'latitude']);
    var roadNameCol = findColumn(headers, ['站点所在道路', '所在道路', '道路名称', '道路']);
    if (roadLngCol < 0) roadLngCol = originalLngCol;
    if (roadLatCol < 0) roadLatCol = originalLatCol;
    if (originalLngCol < 0) originalLngCol = roadLngCol;
    if (originalLatCol < 0) originalLatCol = roadLatCol;
    var peopleCol = findColumn(headers, ['本点人数', '人数', '覆盖人数']);
    var stopCountCol = findColumn(headers, ['覆盖站点数', '站点数']);
    var roadOffsetCol = findColumn(headers, ['道路偏移(m)', '道路偏移']);
    var defaultRouteName = text(metadata(rows, '线路编号')) || sheetName;
    var groups = {};

    for (var r = header.rowIndex + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var name = text(row[nameCol]);
      var originalLng = number(row[originalLngCol]);
      var originalLat = number(row[originalLatCol]);
      var roadLng = number(row[roadLngCol]);
      var roadLat = number(row[roadLatCol]);
      if (!name || !isFinite(originalLng) || !isFinite(originalLat) || !isFinite(roadLng) || !isFinite(roadLat)) continue;
      if (originalLng < 70 || originalLng > 140 || originalLat < 0 || originalLat > 60 || roadLng < 70 || roadLng > 140 || roadLat < 0 || roadLat > 60) continue;
      var routeName = routeCol >= 0 ? text(row[routeCol]) : defaultRouteName;
      if (!routeName) routeName = sheetName;
      if (!groups[routeName]) groups[routeName] = { name: routeName, stops: [], destinations: [], metaRows: rows };
      var item = {
        order: orderCol >= 0 && isFinite(number(row[orderCol])) ? number(row[orderCol]) : r,
        name: name,
        originalLng: originalLng,
        originalLat: originalLat,
        roadLng: roadLng,
        roadLat: roadLat,
        roadName: roadNameCol >= 0 ? text(row[roadNameCol]) : '',
        people: peopleCol >= 0 && isFinite(number(row[peopleCol])) ? Math.max(0, number(row[peopleCol])) : 0,
        stopCount: stopCountCol >= 0 && isFinite(number(row[stopCountCol])) ? Math.max(0, number(row[stopCountCol])) : 1,
        roadSnapM: roadOffsetCol >= 0 && isFinite(number(row[roadOffsetCol])) ? Math.max(0, number(row[roadOffsetCol])) : 0
      };
      if (endpointName(name)) groups[routeName].destinations.push(item);
      else groups[routeName].stops.push(item);
    }
    return Object.keys(groups).map(function (key) { return groups[key]; });
  }

  function parseRouteWorkbook(workbook) {
    if (!workbook || !workbook.SheetNames || !workbook.SheetNames.length) throw new Error('Excel 中没有可读取的工作表');
    var groups = [];
    workbook.SheetNames.forEach(function (sheetName) {
      var rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: '' });
      routeGroupsFromSheet(sheetName, rows).forEach(function (group) { groups.push(group); });
    });
    if (!groups.length) throw new Error('未找到包含站点名称、经度和纬度的线路明细表');

    var destination = null;
    groups.forEach(function (group) {
      if (!group.destinations.length) return;
      var d = group.destinations[0];
      var candidate = { name: cleanEndpointName(d.name) || text(metadata(group.metaRows, '终点')) || '终点', lng: d.originalLng, lat: d.originalLat };
      if (!destination) destination = candidate;
      else if (typeof geoDistance === 'function' && geoDistance(destination, candidate) > 100) throw new Error('不同线路的终点坐标不一致');
    });
    if (!destination) {
      for (var gi = 0; gi < groups.length && !destination; gi++) destination = factoryByName(metadata(groups[gi].metaRows, '终点'));
    }
    if (!destination) throw new Error('未在线路明细中找到终点坐标');
    destination._aid = 'import-dest';

    var routes = [];
    groups.forEach(function (group) {
      group.stops.sort(function (a, b) { return a.order - b.order; });
      if (!group.stops.length) return;
      var routeIndex = routes.length;
      var stops = group.stops.map(function (item, stopIndex) {
        return {
          _aid: 'import-' + routeIndex + '-' + stopIndex,
          name: item.name,
          lng: item.roadLng, lat: item.roadLat,
          roadLng: item.roadLng, roadLat: item.roadLat,
          stopLng: item.originalLng, stopLat: item.originalLat,
          roadSnapM: item.roadSnapM,
          roadName: item.roadName || '',
          people: item.people,
          stopCount: item.stopCount || 1,
          stopNames: [item.name]
        };
      });
      var route = { importName: group.name, stops: stops };
      route.metrics = routeMetrics(stops, destination);
      var km = number(metadata(group.metaRows, '总里程(km)'));
      var duration = number(metadata(group.metaRows, '预估时间(分钟)'));
      if (isFinite(km)) { route.roadKm = km; route.roadM = km * 1000; }
      if (isFinite(duration)) route.durationMin = duration;
      routes.push(route);
    });
    if (!routes.length) throw new Error('线路明细中没有可用的上车点');
    var totalPeople = routes.reduce(function (sum, route) { return sum + route.metrics.people; }, 0);
    var totalStops = routes.reduce(function (sum, route) { return sum + route.metrics.stopCount; }, 0);
    return {
      routes: routes,
      numRoutes: routes.length,
      totalPeople: totalPeople,
      totalStops: totalStops,
      dest: destination,
      rawTotalPeople: totalPeople,
      removedCount: 0,
      removedPeople: 0,
      removedNames: [],
      coverageComplete: true,
      constraintBandConflict: false,
      manualStartMode: false,
      manualDeletedCount: 0,
      manualDeletedPeople: 0,
      importedFromExcel: true
    };
  }

  function readRouteExcelFile(file) {
    if (typeof XLSX === 'undefined') return Promise.reject(new Error('Excel 解析库尚未加载'));
    if (!file) return Promise.reject(new Error('请先选择 Excel 文件'));
    var bufferPromise;
    if (typeof file.arrayBuffer === 'function') {
      bufferPromise = file.arrayBuffer();
    } else {
      bufferPromise = new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = function () { reject(new Error('读取 Excel 文件失败'));
        };
        reader.readAsArrayBuffer(file);
      });
    }
    return bufferPromise.then(function (buffer) {
      var workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
      return parseRouteWorkbook(workbook);
    });
  }

  window.parseRouteWorkbook = parseRouteWorkbook;
  window.readRouteExcelFile = readRouteExcelFile;
})();
