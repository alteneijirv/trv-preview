/* TRV offline routing, classic worker for Android Chromium 80. No network geocoding or GPS persistence. */
(function (scope) {
  'use strict';
  var MAX_BYTES = 100 * 1024 * 1024, MAX_REFS = 4000000, CELL = 0.02, SNAP_M = 500;
  var graph = null, loading = null, routeToken = 0;
  function fail(code) { var e = new Error(code); e.code = code; throw e; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function finite(v) { return typeof v === 'number' && Number.isFinite(v); }
  function uint(v, max) { return Number.isInteger(v) && v >= 0 && v <= max; }
  function point(v) { return obj(v) && finite(v.lat) && finite(v.lon) && Math.abs(v.lat) <= 90 && Math.abs(v.lon) <= 180; }
  function bounds(v) { return obj(v) && finite(v.south) && finite(v.north) && finite(v.west) && finite(v.east) && v.south <= v.north && v.west <= v.east && v.south >= -90 && v.north <= 90 && v.west >= -180 && v.east <= 180; }
  function pause() { return new Promise(function (resolve) { setTimeout(resolve, 0); }); }
  function meters(a, b) {
    var rad = Math.PI / 180, dlat = (b.lat - a.lat) * rad, dlon = (b.lon - a.lon) * rad;
    var h = Math.sin(dlat / 2) * Math.sin(dlat / 2) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dlon / 2) * Math.sin(dlon / 2);
    return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function coord(g, i) { return { lat: g.geomLatE7[i] / 1e7, lon: g.geomLonE7[i] / 1e7 }; }
  function node(g, i) { return { lat: g.latE7[i] / 1e7, lon: g.lonE7[i] / 1e7 }; }
  function inside(p, b, pad) { return p.lat >= b.south - pad && p.lat <= b.north + pad && p.lon >= b.west - pad && p.lon <= b.east + pad; }
  function sameGeometry(g, a, b) {
    var a0 = g.geomOffsets[a], a1 = g.geomOffsets[a + 1], b0 = g.geomOffsets[b], b1 = g.geomOffsets[b + 1];
    if (a1 - a0 !== b1 - b0) return false;
    var reverse = g.geomLatE7[a0] !== g.geomLatE7[b0] || g.geomLonE7[a0] !== g.geomLonE7[b0];
    for (var i = 0; i < a1 - a0; i++) {
      var j = reverse ? b1 - 1 - i : b0 + i;
      if (g.geomLatE7[a0 + i] !== g.geomLatE7[j] || g.geomLonE7[a0 + i] !== g.geomLonE7[j]) return false;
    }
    return true;
  }
  function validateBoundary(value) {
    var geometry = obj(value) && value.type === 'Feature' ? value.geometry : value;
    if (!obj(geometry) || !['Polygon', 'MultiPolygon'].includes(geometry.type) || !Array.isArray(geometry.coordinates)) fail('invalid-data');
    var polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates, count = 0;
    if (!polygons.length || polygons.length > 1000) fail('invalid-data');
    polygons.forEach(function (polygon) {
      if (!Array.isArray(polygon) || !polygon.length || polygon.length > 1000) fail('invalid-data');
      polygon.forEach(function (ring) {
        if (!Array.isArray(ring) || ring.length < 4 || (count += ring.length) > 50000) fail('invalid-data');
        ring.forEach(function (p) { if (!Array.isArray(p) || p.length !== 2 || !finite(p[0]) || !finite(p[1]) || p[0] < 49 || p[0] > 59 || p[1] < 20 || p[1] > 28) fail('invalid-data'); });
        var a = ring[0], b = ring[ring.length - 1]; if (a[0] !== b[0] || a[1] !== b[1]) fail('invalid-data');
      });
    });
    return polygons;
  }
  function ringStatus(p, ring) {
    var contained = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = ring[j], b = ring[i], cross = (p.lon - a[0]) * (b[1] - a[1]) - (p.lat - a[1]) * (b[0] - a[0]);
      if (Math.abs(cross) <= 1e-12 && p.lon >= Math.min(a[0], b[0]) - 1e-10 && p.lon <= Math.max(a[0], b[0]) + 1e-10 && p.lat >= Math.min(a[1], b[1]) - 1e-10 && p.lat <= Math.max(a[1], b[1]) + 1e-10) return 0;
      if ((a[1] > p.lat) !== (b[1] > p.lat) && p.lon < (b[0] - a[0]) * (p.lat - a[1]) / (b[1] - a[1]) + a[0]) contained = !contained;
    }
    return contained ? 1 : -1;
  }
  function covered(polygons, p) {
    for (var i = 0; i < polygons.length; i++) {
      var outer = ringStatus(p, polygons[i][0]); if (outer < 0) continue; if (outer === 0) return true;
      var hole = false;
      for (var j = 1; j < polygons[i].length; j++) { var status = ringStatus(p, polygons[i][j]); if (status === 0) return true; if (status > 0) { hole = true; break; } }
      if (!hole) return true;
    }
    return false;
  }
  function coveredConnector(polygons, a, b) {
    if (!covered(polygons, a) || !covered(polygons, b)) return false;
    var ts = [0, 1], dx = b.lon - a.lon, dy = b.lat - a.lat;
    polygons.forEach(function (poly) { poly.forEach(function (ring) {
      for (var i = 1; i < ring.length; i++) {
        var c = ring[i - 1], d = ring[i], sx = d[0] - c[0], sy = d[1] - c[1], den = dx * sy - dy * sx;
        if (Math.abs(den) < 1e-18) continue;
        var t = ((c[0] - a.lon) * sy - (c[1] - a.lat) * sx) / den, u = ((c[0] - a.lon) * dy - (c[1] - a.lat) * dx) / den;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
      }
    }); });
    ts.sort(function (a, b) { return a - b; });
    for (var i = 1; i < ts.length; i++) {
      var t = (ts[i - 1] + ts[i]) / 2;
      if (!covered(polygons, { lat: a.lat + dy * t, lon: a.lon + dx * t })) return false;
    }
    return true;
  }
  function layoutFor(n, e, p, r) {
    var fields = [['latE7', n, 'i32'], ['lonE7', n, 'i32'], ['offsets', n + 1, 'u32'], ['targets', e, 'u32'],
      ['distanceM', e, 'f32'], ['seconds', e, 'f32'], ['mask', e, 'u8'], ['kind', e, 'u8'],
      ['geomOffsets', e + 1, 'u32'], ['geomLatE7', p, 'i32'], ['geomLonE7', p, 'i32'], ['restrictionFrom', r, 'u32'], ['restrictionTo', r, 'u32']];
    var offset = 64, out = {};
    fields.forEach(function (f) { offset = Math.ceil(offset / 4) * 4; out[f[0]] = { offset: offset, count: f[1], type: f[2] }; offset += f[1] * (f[2] === 'u8' ? 1 : 4); });
    return { fields: out, bytes: offset };
  }
  function validateManifest(m) {
    if (!obj(m) || m.schemaVersion !== 1 || typeof m.datasetId !== 'string' || m.datasetId.length < 1 || m.datasetId.length > 128
      || typeof m.sourceDate !== 'string' || m.sourceDate.length > 64 || !bounds(m.bounds) || m.bounds.south < 20 || m.bounds.north > 28 || m.bounds.west < 49 || m.bounds.east > 59
      || !obj(m.counts) || !uint(m.counts.nodes, 2000000) || !uint(m.counts.edges, 4000000) || !uint(m.counts.points, 12000000) || !uint(m.counts.restrictions, 4000000)
      || !m.counts.nodes || !m.counts.edges || m.counts.points < m.counts.edges * 2 || !obj(m.graph) || m.graph.file !== 'routing-graph.bin'
      || !obj(m.boundary) || m.boundary.file !== 'routing-boundary.geojson' || !uint(m.boundary.bytes, 1000000) || !m.boundary.bytes || !/^[0-9a-f]{64}$/.test(m.boundary.sha256)
      || !uint(m.graph.bytes, MAX_BYTES) || !/^[0-9a-f]{64}$/.test(m.graph.sha256) || !obj(m.layout)) fail('invalid-data');
    var expected = layoutFor(m.counts.nodes, m.counts.edges, m.counts.points, m.counts.restrictions);
    if (expected.bytes !== m.graph.bytes) fail('invalid-data');
    Object.keys(expected.fields).forEach(function (name) {
      var got = m.layout[name], want = expected.fields[name];
      if (!obj(got) || got.offset !== want.offset || got.count !== want.count || got.type !== want.type) fail('invalid-data');
    });
    return m;
  }
  async function parse(buffer, manifest, progress, boundary) {
    var m = validateManifest(manifest);
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== m.graph.bytes || buffer.byteLength < 64) fail('invalid-data');
    var view = new DataView(buffer), magic = '';
    for (var i = 0; i < 8; i++) magic += String.fromCharCode(view.getUint8(i));
    if (magic !== 'TRVG0001' || view.getUint32(8, true) !== 1 || view.getUint32(12, true) !== m.counts.nodes || view.getUint32(16, true) !== m.counts.edges
      || view.getUint32(20, true) !== m.counts.points || view.getUint32(24, true) !== m.counts.restrictions) fail('invalid-data');
    for (i = 28; i < 64; i++) if (view.getUint8(i) !== 0) fail('invalid-data');
    // Reject non-little-endian hosts instead of silently interpreting corrupt typed arrays.
    if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) fail('invalid-data');
    var g = { manifest: m, n: m.counts.nodes, e: m.counts.edges, p: m.counts.points, grid: new Map(), forbidden: new Map(), boundary: validateBoundary(boundary) };
    Object.keys(m.layout).forEach(function (name) {
      if (!Object.prototype.hasOwnProperty.call(layoutFor(g.n, g.e, g.p, m.counts.restrictions).fields, name)) fail('invalid-data');
      var f = m.layout[name], C = { i32: Int32Array, u32: Uint32Array, f32: Float32Array, u8: Uint8Array }[f.type];
      g[name] = new C(buffer, f.offset, f.count);
    });
    g.sources = new Uint32Array(g.e);
    if (g.offsets[0] !== 0 || g.offsets[g.n] !== g.e || g.geomOffsets[0] !== 0 || g.geomOffsets[g.e] !== g.p) fail('invalid-data');
    for (i = 0; i < g.n; i++) {
      if (!inside(node(g, i), m.bounds, 0.00001) || g.offsets[i] > g.offsets[i + 1] || g.offsets[i + 1] > g.e) fail('invalid-data');
      for (var se = g.offsets[i]; se < g.offsets[i + 1]; se++) g.sources[se] = i;
    }
    var references = 0;
    for (i = 0; i < g.e; i++) {
      var begin = g.geomOffsets[i], end = g.geomOffsets[i + 1];
      if (g.targets[i] >= g.n || !finite(g.distanceM[i]) || g.distanceM[i] <= 0 || g.distanceM[i] > 2000000 || !finite(g.seconds[i]) || g.seconds[i] <= 0
        || !g.mask[i] || g.mask[i] > 3 || g.kind[i] > 1 || g.kind[i] === 1 && (g.mask[i] & 1) || end < begin + 2 || end > g.p) fail('invalid-data');
      var a = coord(g, begin), z = coord(g, end - 1), ns = node(g, g.sources[i]), nt = node(g, g.targets[i]);
      if (meters(a, ns) > 0.2 || meters(z, nt) > 0.2 || g.distanceM[i] < meters(ns, nt) * 0.999) fail('invalid-data');
      var south = 90, north = -90, west = 180, east = -180, geometryLength = 0, previousPoint = null;
      for (var j = begin; j < end; j++) {
        var q = coord(g, j); if (previousPoint) geometryLength += meters(previousPoint, q); previousPoint = q; if (!inside(q, m.bounds, 0.00001)) fail('invalid-data');
        south = Math.min(south, q.lat); north = Math.max(north, q.lat); west = Math.min(west, q.lon); east = Math.max(east, q.lon);
      }
      if (g.distanceM[i] < geometryLength * 0.999) fail('invalid-data');
      var x0 = Math.floor(west / CELL), x1 = Math.floor(east / CELL), y0 = Math.floor(south / CELL), y1 = Math.floor(north / CELL);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) fail('invalid-data');
      for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
        if (++references > MAX_REFS) fail('budget-exceeded');
        var key = x + ':' + y, bucket = g.grid.get(key); if (!bucket) { bucket = []; g.grid.set(key, bucket); } bucket.push(i);
      }
      if (i % 8192 === 0) { if (progress) progress('indexing', i / g.e); await pause(); }
    }
    g.grid.forEach(function (values, key) { g.grid.set(key, new Uint32Array(values)); });
    for (i = 0; i < m.counts.restrictions; i++) {
      var from = g.restrictionFrom[i], to = g.restrictionTo[i];
      if (from >= g.e || to >= g.e || g.targets[from] !== g.sources[to]) fail('invalid-data');
      var blocked = g.forbidden.get(from); if (!blocked) { blocked = new Set(); g.forbidden.set(from, blocked); } blocked.add(to);
    }
    if (progress) progress('ready', 1);
    return g;
  }
  function candidates(g, b, limit) {
    var x0 = Math.floor(b.west / CELL), x1 = Math.floor(b.east / CELL), y0 = Math.floor(b.south / CELL), y1 = Math.floor(b.north / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 30000) fail('budget-exceeded');
    var found = new Set(), truncated = false;
    outer: for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
      var bucket = g.grid.get(x + ':' + y); if (!bucket) continue;
      for (var i = 0; i < bucket.length; i++) { found.add(bucket[i]); if (found.size >= limit) { truncated = true; break outer; } }
    }
    return { edges: Array.from(found), truncated: truncated };
  }
  function project(p, a, b) {
    var c = Math.cos(p.lat * Math.PI / 180), dx = (b.lon - a.lon) * c, dy = b.lat - a.lat;
    var t = dx * dx + dy * dy ? ((p.lon - a.lon) * c * dx + (p.lat - a.lat) * dy) / (dx * dx + dy * dy) : 0;
    t = Math.max(0, Math.min(1, t));
    var q = { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
    return { point: q, t: t, gapM: meters(p, q) };
  }
  function snaps(g, p, mask, guard) {
    if (!inside(p, g.manifest.bounds, 0.01) || !covered(g.boundary, p)) fail('outside-coverage');
    var latPad = SNAP_M / 110000, lonPad = latPad / Math.max(0.1, Math.cos(p.lat * Math.PI / 180));
    var items = candidates(g, { south: p.lat - latPad, north: p.lat + latPad, west: p.lon - lonPad, east: p.lon + lonPad }, 120000);
    if (items.truncated) fail('budget-exceeded');
    var out = [], examined = 0;
    items.edges.forEach(function (e) {
      if (!(g.mask[e] & mask)) return;
      var first = g.geomOffsets[e], last = g.geomOffsets[e + 1], total = 0, best = null;
      examined += last - first; if (examined > 1000000) fail('budget-exceeded'); if (guard) guard();
      for (var j = first; j < last - 1; j++) {
        var a = coord(g, j), b = coord(g, j + 1), length = meters(a, b), pr = project(p, a, b);
        if (!best || pr.gapM < best.gapM) best = { edge: e, segment: j, t: pr.t, point: pr.point, gapM: pr.gapM, along: total + pr.t * length };
        total += length;
      }
      if (best && best.gapM <= SNAP_M && total > 0) { best.fraction = Math.max(0, Math.min(1, best.along / total)); out.push(best); }
    });
    out.sort(function (a, b) { return a.gapM - b.gapM || a.edge - b.edge; });
    if (!out.length) fail('snap-too-far');
    // Never relocate an endpoint onto a farther edge to bypass a barrier or forbidden turn.
    // Direction alternatives must share the exact geometry, or the same real graph junction.
    var nearest = out[0];
    function snapNode(s) { return s.fraction < 1e-9 ? g.sources[s.edge] : s.fraction > 1 - 1e-9 ? g.targets[s.edge] : -1; }
    var junction = snapNode(nearest);
    var selected = out.filter(function (s) {
      return s.gapM <= nearest.gapM + 0.001 && meters(s.point, nearest.point) <= 0.02
        && ((g.sources[nearest.edge] === g.sources[s.edge] && g.targets[nearest.edge] === g.targets[s.edge] || g.sources[nearest.edge] === g.targets[s.edge] && g.targets[nearest.edge] === g.sources[s.edge]) && sameGeometry(g, nearest.edge, s.edge) || junction >= 0 && snapNode(s) === junction);
    }).slice(0, 64).filter(function (s) { return coveredConnector(g.boundary, p, s.point); });
    if (!selected.length) fail('outside-coverage');
    return selected;
  }
  function forbidden(g, from, to) { var v = g.forbidden.get(from); return !!v && v.has(to); }
  function Heap(size) { this.ids = new Uint32Array(size); this.f = new Float64Array(size); this.positions = new Int32Array(size); this.positions.fill(-1); this.length = 0; }
  Heap.prototype.swap = function (a, b) { var e = this.ids[a], f = this.f[a]; this.ids[a] = this.ids[b]; this.f[a] = this.f[b]; this.ids[b] = e; this.f[b] = f; this.positions[this.ids[a]] = a; this.positions[this.ids[b]] = b; };
  Heap.prototype.push = function (id, f) {
    var k = this.positions[id]; if (k < 0) { k = this.length++; this.ids[k] = id; this.f[k] = f; this.positions[id] = k; } else { if (f >= this.f[k]) return; this.f[k] = f; }
    while (k > 0) { var p = (k - 1) >> 1; if (this.f[p] <= this.f[k]) break; this.swap(k, p); k = p; }
  };
  Heap.prototype.pop = function () {
    var id = this.ids[0]; this.positions[id] = -1; this.length--;
    if (this.length) {
      this.ids[0] = this.ids[this.length]; this.f[0] = this.f[this.length]; this.positions[this.ids[0]] = 0;
      var k = 0;
      while (true) { var l = k * 2 + 1, r = l + 1, b = k; if (l < this.length && this.f[l] < this.f[b]) b = l; if (r < this.length && this.f[r] < this.f[b]) b = r; if (b === k) break; this.swap(k, b); k = b; }
    }
    return id;
  };
  function append(out, p) { var last = out[out.length - 1]; if (!last || last[0] !== p.lat || last[1] !== p.lon) out.push([p.lat, p.lon]); if (out.length > 100000) fail('budget-exceeded'); }
  function edgePart(g, e, start, finish, out) {
    var first = g.geomOffsets[e], last = g.geomOffsets[e + 1];
    append(out, start ? start.point : coord(g, first));
    var from = start ? start.segment + 1 : first + 1, to = finish ? finish.segment : last - 1;
    for (var j = from; j <= to; j++) append(out, coord(g, j));
    if (finish) append(out, finish.point);
  }
  async function route(g, input, control) {
    if (!obj(input) || !point(input.from) || !point(input.to) || input.profile !== 'road' && input.profile !== '4wd') fail('invalid-request');
    var startTime = Date.now(), visited = 0;
    var maxVisited = control && control.maxVisited || 500000, maxMs = control && control.maxMs || 10000;
    function check() { if (control && control.cancelled && control.cancelled()) fail('cancelled'); if (visited > maxVisited || Date.now() - startTime > maxMs) fail('budget-exceeded'); }
    check();
    var mask = input.profile === 'road' ? 1 : 2, from = snaps(g, input.from, mask, check), to = snaps(g, input.to, mask, check);
    var distance = new Float64Array(g.e); distance.fill(Infinity);
    var parents = new Int32Array(g.e); parents.fill(-1);
    var roots = new Int16Array(g.e); roots.fill(-1);
    var heap = new Heap(g.e), best = null, bestCost = Infinity, terminal = new Map(), nodeGoals = new Map();
    function heuristic(n) { var p = node(g, n), d = Infinity; for (var i = 0; i < to.length; i++) d = Math.min(d, meters(p, to[i].point)); return d * 0.998; }
    function goal(s, index) {
      var n = g.sources[s.edge], list = terminal.get(n); if (!list) { list = []; terminal.set(n, list); } list.push(index);
      if (s.fraction < 0.000001 || s.fraction > 0.999999) {
        n = s.fraction < 0.5 ? g.sources[s.edge] : g.targets[s.edge]; list = nodeGoals.get(n); if (!list) { list = []; nodeGoals.set(n, list); } list.push(index);
      }
    }
    to.forEach(goal);
    from.forEach(function (s, i) {
      var cost = (1 - s.fraction) * g.distanceM[s.edge] + s.gapM * 4;
      if (cost < distance[s.edge]) { distance[s.edge] = cost; roots[s.edge] = i; parents[s.edge] = -1; heap.push(s.edge, cost + heuristic(g.targets[s.edge])); }
      to.forEach(function (t, j) {
        if (s.edge === t.edge && t.fraction >= s.fraction) {
          var v = (t.fraction - s.fraction) * g.distanceM[s.edge] + s.gapM * 4 + t.gapM * 4;
          if (v < bestCost) { bestCost = v; best = { direct: true, start: i, end: j }; }
        }
      });
    });
    while (heap.length) {
      check();
      if (heap.f[0] >= bestCost) break;
      var e = heap.pop(), n = g.targets[e], gscore = distance[e], root = from[roots[e]], atStartNode = parents[e] === -1 && root.fraction > 0.999999;
      var ng = nodeGoals.get(n) || [];
      ng.forEach(function (j) { var c = gscore + to[j].gapM * 4; if (c < bestCost) { bestCost = c; best = { edge: e, end: j, nodeEnd: true }; } });
      var ends = terminal.get(n) || [];
      ends.forEach(function (j) {
        var t = to[j]; if (!atStartNode && forbidden(g, e, t.edge)) return;
        var c = gscore + t.fraction * g.distanceM[t.edge] + t.gapM * 4;
        if (c < bestCost) { bestCost = c; best = { edge: e, end: j, nodeEnd: false }; }
      });
      for (var next = g.offsets[n]; next < g.offsets[n + 1]; next++) {
        if (!(g.mask[next] & mask) || !atStartNode && forbidden(g, e, next)) continue;
        var cost = gscore + g.distanceM[next];
        if (cost + 0.000001 < distance[next]) { distance[next] = cost; parents[next] = e; roots[next] = roots[e]; heap.push(next, cost + heuristic(g.targets[next])); }
      }
      visited++;
      if (visited % 2048 === 0) { if (control && control.progress) control.progress('planning', Math.min(0.95, visited / maxVisited)); await pause(); }
    }
    check(); if (!best) fail('no-connected-route');
    var geometry = [], dist = 0, seconds = 0, track = 0, start, finish = to[best.end];
    function add(e, f) { var d = g.distanceM[e] * f; dist += d; seconds += g.seconds[e] * f; if (g.kind[e] === 1) track += d; }
    if (best.direct) { start = from[best.start]; edgePart(g, start.edge, start, finish, geometry); add(start.edge, finish.fraction - start.fraction); }
    else {
      var chain = [], cursor = best.edge, guard = 0;
      while (cursor >= 0) { chain.push(cursor); cursor = parents[cursor]; if (++guard > g.e) fail('invalid-data'); }
      chain.reverse(); start = from[roots[best.edge]];
      chain.forEach(function (edge, i) { edgePart(g, edge, i === 0 ? start : null, null, geometry); add(edge, i === 0 ? 1 - start.fraction : 1); });
      if (!best.nodeEnd) { edgePart(g, finish.edge, null, finish, geometry); add(finish.edge, finish.fraction); }
    }
    if (geometry.length === 1) geometry.push(geometry[0].slice());
    return { geometry: geometry, distanceM: dist, estimatedSeconds: seconds, trackDistanceM: track,
      from: { requested: { lat: input.from.lat, lon: input.from.lon }, point: start.point, gapM: start.gapM },
      to: { requested: { lat: input.to.lat, lon: input.to.lon }, point: finish.point, gapM: finish.gapM },
      warnings: ['estimated-time', 'not-vehicle-clearance-checked'].concat(track > 0 ? ['mapped-tracks-not-verified'] : []).concat(start.gapM > 5 || finish.gapM > 5 ? ['off-network-endpoints'] : []) };
  }
  function viewportCandidates(g, b) {
    var cells = [], count = 0;
    g.grid.forEach(function (bucket, key) {
      var split = key.indexOf(':'), x = Number(key.slice(0, split)), y = Number(key.slice(split + 1));
      if ((x + 1) * CELL >= b.west && x * CELL <= b.east && (y + 1) * CELL >= b.south && y * CELL <= b.north) { cells.push(bucket); count += bucket.length; }
    });
    var budget = 120000, perCell = Math.max(1, Math.floor(budget / Math.max(1, cells.length))), seen = new Set();
    cells.forEach(function (bucket) {
      var step = count > budget ? Math.max(1, Math.ceil(bucket.length / perCell)) : 1;
      for (var i = 0; i < bucket.length; i += step) { if (seen.size < budget) seen.add(bucket[i]); }
    });
    return { edges: Array.from(seen), truncated: count > budget };
  }
  function simplifyShape(shape, metersPerPoint) {
    if (shape.length <= 2) return shape;
    var out = [shape[0]], last = { lat: shape[0][0], lon: shape[0][1] };
    for (var i = 1; i < shape.length - 1; i++) {
      var p = { lat: shape[i][0], lon: shape[i][1] };
      if (meters(last, p) >= metersPerPoint) { out.push(shape[i]); last = p; }
    }
    out.push(shape[shape.length - 1]); return out;
  }
  function query(g, input) {
    if (!obj(input) || !bounds(input.bounds)) fail('invalid-request');
    var options = obj(input.options) ? input.options : {}, maxWays = uint(options.maxWays, 3000) && options.maxWays > 0 ? options.maxWays : 1500;
    var maxPoints = uint(options.maxPoints, 60000) && options.maxPoints > 1 ? options.maxPoints : 30000, zoom = finite(options.zoom) ? options.zoom : 12;
    var found = viewportCandidates(g, input.bounds), out = [], points = 0, examined = 0, seen = new Map(), truncated = found.truncated;
    // Ordinary roads first on an overview; tracks are included when the scale can distinguish them.
    found.edges.sort(function (a, b) { return g.kind[a] - g.kind[b] || g.distanceM[b] - g.distanceM[a] || a - b; });
    for (var i = 0; i < found.edges.length; i++) {
      if (out.length >= maxWays) { truncated = true; break; }
      var e = found.edges[i]; if (zoom < 10 && g.kind[e] === 1) continue;
      var first = g.geomOffsets[e], end = g.geomOffsets[e + 1], a = coord(g, first), b = coord(g, end - 1);
      var key;
      var one = a.lat + ',' + a.lon, two = b.lat + ',' + b.lon;
      key = (one < two ? one + ':' + two : two + ':' + one) + ':' + (end - first) + ':' + Math.round(g.distanceM[e] * 10);
      var possible = seen.get(key) || []; if (possible.some(function (other) { return sameGeometry(g, e, other); })) continue;
      examined += end - first; if (examined > 500000) { truncated = true; break; }
      var shape = [], visible = false, previous = null;
      for (var j = first; j < end; j++) {
        var p = coord(g, j); shape.push([p.lat, p.lon]);
        if (inside(p, input.bounds, 0)) visible = true;
        if (previous && Math.min(previous.lat, p.lat) <= input.bounds.north && Math.max(previous.lat, p.lat) >= input.bounds.south && Math.min(previous.lon, p.lon) <= input.bounds.east && Math.max(previous.lon, p.lon) >= input.bounds.west) visible = true;
        previous = p;
      }
      if (!visible) continue;
      shape = simplifyShape(shape, 40075016 * Math.cos((input.bounds.south + input.bounds.north) / 2 * Math.PI / 180) / Math.pow(2, Math.max(0, Math.min(22, zoom))) / 256 * 1.5);
      if (out.length >= maxWays || points + shape.length > maxPoints) { truncated = true; continue; }
      possible.push(e); seen.set(key, possible); points += shape.length; out.push({ geometry: shape, kind: g.kind[e], mask: g.mask[e] });
    }
    return { segments: out, truncated: truncated };
  }
  async function boundedFetch(url, bytes) {
    var response = await fetch(url, { credentials: 'omit', cache: 'force-cache' }); if (!response.ok) fail('data-unavailable');
    var header = response.headers.get('content-length'); if (header && Number(header) > bytes) fail('invalid-data');
    if (response.body && response.body.getReader) {
      var reader = response.body.getReader(), joined = new Uint8Array(bytes), size = 0;
      while (true) { var part = await reader.read(); if (part.done) break; if (size + part.value.byteLength > bytes) { await reader.cancel(); fail('invalid-data'); } joined.set(part.value, size); size += part.value.byteLength; }
      return size === bytes ? joined.buffer : joined.buffer.slice(0, size);
    }
    var buffer = await response.arrayBuffer(); if (buffer.byteLength > bytes) fail('invalid-data'); return buffer;
  }
  // SHA-256 fallback is necessary for the same LAN UI served over plain HTTP,
  // where Chromium omits SubtleCrypto. It hashes only bundled public map assets.
  async function digestHex(data) {
    if (scope.crypto && scope.crypto.subtle) {
      var digest = new Uint8Array(await scope.crypto.subtle.digest('SHA-256', data)), hex = '';
      digest.forEach(function (b) { hex += b.toString(16).padStart(2, '0'); }); return hex;
    }
    var k = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
    var h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]), w = new Uint32Array(64), bytes = new Uint8Array(data);
    var paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
    function byte(at) {
      if (at < bytes.length) return bytes[at]; if (at === bytes.length) return 128;
      if (at >= paddedLength - 4) return (bytes.length * 8) >>> ((paddedLength - 1 - at) * 8) & 255;
      return 0; // MAX_BYTES is below 2^29, so the high bit-length word is zero.
    }
    for (var offset = 0; offset < paddedLength; offset += 64) {
      for (var i = 0; i < 16; i++) { var at = offset + i * 4; w[i] = (byte(at) << 24) | (byte(at + 1) << 16) | (byte(at + 2) << 8) | byte(at + 3); }
      for (i = 16; i < 64; i++) { var x = w[i - 15], y = w[i - 2]; w[i] = w[i - 16] + (rotr(x, 7) ^ rotr(x, 18) ^ x >>> 3) + w[i - 7] + (rotr(y, 17) ^ rotr(y, 19) ^ y >>> 10); }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) >>> 0;
        var t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
      if (offset && offset % 1048576 === 0) await pause();
    }
    return Array.from(h).map(function (v) { return v.toString(16).padStart(8, '0'); }).join('');
  }
  async function load(progress) {
    if (graph) return graph;
    if (!loading) loading = (async function () {
      var bytes = await boundedFetch('/maps/uae-offline/routing-manifest.json', 1000000), m;
      try { m = JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { fail('invalid-data'); }
      validateManifest(m); progress('loading-data', 0);
      var boundaryBytes = await boundedFetch('/maps/uae-offline/routing-boundary.geojson', m.boundary.bytes);
      if (boundaryBytes.byteLength !== m.boundary.bytes || await digestHex(boundaryBytes) !== m.boundary.sha256) fail('invalid-data');
      var boundary; try { boundary = JSON.parse(new TextDecoder().decode(boundaryBytes)); } catch (e) { fail('invalid-data'); }
      validateBoundary(boundary);
      var data = await boundedFetch('/maps/uae-offline/routing-graph.bin', m.graph.bytes);
      var hash = await digestHex(data);
      if (hash !== m.graph.sha256) fail('invalid-data');
      graph = await parse(data, m, progress, boundary); return graph;
    })().catch(function (error) { loading = null; throw error; });
    return loading;
  }
  function reply(id, type, value) { scope.postMessage({ version: 1, requestId: id, type: type, value: value }); }
  scope.onmessage = async function (event) {
    var request = event.data; if (!obj(request) || request.version !== 1 || !uint(request.requestId, Number.MAX_SAFE_INTEGER)) return;
    var id = request.requestId, progress = function (phase, fraction) { scope.postMessage({ version: 1, requestId: id, type: 'progress', phase: phase, fraction: fraction }); };
    try {
      if (request.type === 'cancel') { routeToken++; reply(id, 'result', null); return; }
      var g = await load(progress);
      if (request.type === 'init') reply(id, 'ready', { datasetId: g.manifest.datasetId, sourceDate: g.manifest.sourceDate, coverageBounds: g.manifest.bounds, counts: g.manifest.counts });
      else if (request.type === 'query') reply(id, 'result', query(g, request));
      else if (request.type === 'route') { var token = ++routeToken; reply(id, 'result', await route(g, request, { cancelled: function () { return token !== routeToken; }, progress: progress })); }
      else fail('invalid-request');
    } catch (error) { scope.postMessage({ version: 1, requestId: id, type: 'error', code: error && error.code || 'data-unavailable' }); }
  };
  if (scope.__TRV_ROUTING_TEST__ === true) scope.TRVOfflineRouting = { parse: parse, route: route, query: query, layoutFor: layoutFor, validateManifest: validateManifest, meters: meters, digestHex: digestHex, validateBoundary: validateBoundary, covered: covered, coveredConnector: coveredConnector };
})(self);
