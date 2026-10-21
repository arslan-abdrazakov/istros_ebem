/*
  Карта путешествия: подложка из реальных геоданных, облака, огоньки остановок,
  линии связи между главами и управление «камерой».
  Используется Leaflet (без тайлов — вся карта рисуется из content/geo.js).
*/
(function () {
  "use strict";
  var U = window.JourneyUtil;
  var KM_PER_DEG = 111.32;

  /* ===================================================================
     ОБЛАКА
     Холст в отдельном слое карты. Облака привязаны к координатам,
     поэтому при масштабировании и изменении размера окна они остаются
     на своих местах, как и «окна» в них над открытыми главами.
     =================================================================== */

  function makeCloudSprite(seed, light) {
    var size = 256, c = document.createElement("canvas");
    c.width = c.height = size;
    var g = c.getContext("2d"), r = U.rng(seed);
    var puffs = 14 + Math.floor(r() * 8);
    for (var i = 0; i < puffs; i++) {
      var a = r() * Math.PI * 2, d = Math.pow(r(), 0.7) * size * 0.27;
      var x = size / 2 + Math.cos(a) * d * 1.25, y = size / 2 + Math.sin(a) * d * 0.8;
      var rad = size * (0.12 + r() * 0.14);
      var grd = g.createRadialGradient(x, y - rad * 0.25, rad * 0.1, x, y, rad);
      if (light) {
        grd.addColorStop(0, "rgba(105,115,124,0.17)");
        grd.addColorStop(0.55, "rgba(91,101,110,0.10)");
        grd.addColorStop(1, "rgba(75,84,93,0)");
      } else {
        grd.addColorStop(0, "rgba(8,11,15,0.52)");
        grd.addColorStop(0.6, "rgba(20,25,30,0.30)");
        grd.addColorStop(1, "rgba(20,25,30,0)");
      }
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    }
    return c;
  }

  var FogLayer = L.Renderer.extend({
    options: { padding: 0.2, pane: "fog" },

    initialize: function (opts) {
      L.Renderer.prototype.initialize.call(this, opts);
      this._holes = {};        // id -> {lat, lng, km, k}
      this._corridors = {};    // id -> {points:[latlng], km, k}
      this._regions = {};      // id -> {points:[latlng], km, k}
      this._alpha = 1;         // общая плотность облаков (для финала)
      this._sprites = { light: [], shade: [] };
      for (var i = 0; i < 4; i++) {
        this._sprites.light.push(makeCloudSprite(11 + i * 7, true));
        this._sprites.shade.push(makeCloudSprite(101 + i * 13, false));
      }
      this._clouds = [];
      this._raf = null;
    },

    // Облака трёх размеров: крупные по всей карте, средние и мелкие — у остановок,
    // чтобы и при сильном приближении облака оставались фактурными.
    setCloudField: function (extent, focusPoints) {
      var rnd = U.rng(20260), clouds = [];
      var lon0 = extent[0], lat0 = extent[1], lon1 = extent[2], lat1 = extent[3];
      var stepLat = 0.22, stepLon = 0.38;
      for (var la = lat0; la < lat1; la += stepLat) {
        for (var lo = lon0; lo < lon1; lo += stepLon) {
          clouds.push({ lat: la + rnd() * stepLat, lng: lo + rnd() * stepLon, km: 26 + rnd() * 28, v: Math.floor(rnd() * 4), layer: 0 });
        }
      }
      focusPoints.forEach(function (p) {
        for (var i = 0; i < 46; i++) {
          var a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * 22;
          clouds.push({ lat: p[0] + Math.sin(a) * d / KM_PER_DEG, lng: p[1] + Math.cos(a) * d / (KM_PER_DEG * Math.cos(p[0] * Math.PI / 180)), km: 2.2 + rnd() * 4.5, v: Math.floor(rnd() * 4), layer: 1 });
        }
        for (var j = 0; j < 40; j++) {
          var b = rnd() * Math.PI * 2, e = Math.sqrt(rnd()) * 5;
          clouds.push({ lat: p[0] + Math.sin(b) * e / KM_PER_DEG, lng: p[1] + Math.cos(b) * e / (KM_PER_DEG * Math.cos(p[0] * Math.PI / 180)), km: 0.35 + rnd() * 0.9, v: Math.floor(rnd() * 4), layer: 2 });
        }
      });
      this._clouds = clouds;
      this.redraw();
    },

    setHole: function (id, latlng, km, k) {
      this._holes[id] = { lat: latlng[0], lng: latlng[1], km: km, k: k == null ? 1 : k };
      this.redraw();
    },
    setHoleK: function (id, k) { if (this._holes[id]) { this._holes[id].k = k; this.redraw(); } },
    setCorridor: function (id, latlngs, km, k) {
      this._corridors[id] = { points: latlngs, km: km, k: k == null ? 1 : k };
      this.redraw();
    },
    setCorridorK: function (id, k) { if (this._corridors[id]) { this._corridors[id].k = k; this.redraw(); } },
    setRegion: function (id, latlngs, km, k) {
      this._regions[id] = { points: latlngs, km: km, k: k == null ? 1 : k };
      this.redraw();
    },
    setRegionK: function (id, k) { if (this._regions[id]) { this._regions[id].k = k; this.redraw(); } },
    clearAll: function () { this._holes = {}; this._corridors = {}; this._regions = {}; this._alpha = 1; this.redraw(); },
    setAlpha: function (a) { this._alpha = a; this.redraw(); },

    redraw: function () {
      if (!this._map) return;
      var self = this;
      if (this._raf) return;
      this._raf = requestAnimationFrame(function () { self._raf = null; self._update(); });
    },

    getEvents: function () {
      var ev = L.Renderer.prototype.getEvents.call(this);
      ev.move = this._onMove;
      ev.resize = this._onResize;
      return ev;
    },
    _onMove: function () { if (!this._map._animatingZoom) this.redraw(); },
    _onResize: function () { this._update(); },
    // во время полёта камеры (flyTo) перерисовываем каждый кадр, а не растягиваем старый кадр
    _onZoom: function () { this._update(); },

    _initContainer: function () {
      var c = this._container = document.createElement("canvas");
      c.className = "fog-canvas leaflet-zoom-animated";
      c.setAttribute("aria-hidden", "true");
      this._ctx = c.getContext("2d");
    },
    _destroyContainer: function () { L.DomUtil.remove(this._container); delete this._ctx; delete this._container; },
    _updatePaths: function () {},

    _update: function () {
      if (!this._map) return;
      if (this._map._animatingZoom && this._bounds) return;
      L.Renderer.prototype._update.call(this);
      // облака мягкие, поэтому холст рисуется в пониженном разрешении — это быстро
      var b = this._bounds, size = b.getSize(), m = 0.7;
      var c = this._container;
      L.DomUtil.setPosition(c, b.min);
      if (c.width !== Math.round(m * size.x) || c.height !== Math.round(m * size.y)) {
        c.width = Math.round(m * size.x); c.height = Math.round(m * size.y);
        c.style.width = size.x + "px"; c.style.height = size.y + "px";
      }
      var ctx = this._ctx;
      ctx.setTransform(m, 0, 0, m, 0, 0);
      ctx.translate(-b.min.x, -b.min.y);
      this._draw(ctx, b);
      this.fire("update");
    },

    _pxPerKm: function (lat) {
      var map = this._map, p1 = map.latLngToLayerPoint([lat, 0]), p2 = map.latLngToLayerPoint([lat + 1 / KM_PER_DEG, 0]);
      return Math.abs(p1.y - p2.y);
    },

    _draw: function (ctx, b) {
      var map = this._map, w = b.max.x - b.min.x, h = b.max.y - b.min.y;
      ctx.clearRect(b.min.x, b.min.y, w, h);
      if (this._alpha <= 0.001) return;
      var ppk = this._pxPerKm(map.getCenter().lat);
      ctx.save();
      ctx.globalAlpha = this._alpha;

      // Холодная полупрозрачная дымка оставляет читаемыми силуэты суши.
      var grd = ctx.createLinearGradient(b.min.x, b.min.y, b.min.x, b.max.y);
      grd.addColorStop(0, "rgba(18,22,27,0.88)");
      grd.addColorStop(1, "rgba(25,30,36,0.92)");
      ctx.fillStyle = grd;
      ctx.fillRect(b.min.x, b.min.y, w, h);

      // 2. Фактура облаков: тени, затем светлые клубы
      var sprites = this._sprites, clouds = this._clouds;
      var minPx = [160, 130, 110], maxPx = [7000, 3600, 1800];
      for (var pass = 0; pass < 2; pass++) {
        for (var i = 0; i < clouds.length; i++) {
          var cl = clouds[i], s = cl.km * ppk * 2.6;
          if (s < minPx[cl.layer] || s > maxPx[cl.layer]) continue;
          var p = map.latLngToLayerPoint([cl.lat, cl.lng]);
          if (p.x + s < b.min.x || p.x - s > b.max.x || p.y + s < b.min.y || p.y - s > b.max.y) continue;
          if (pass === 0) {
            ctx.globalAlpha = this._alpha * 0.45;
            ctx.drawImage(sprites.shade[cl.v], p.x - s / 2 + s * 0.05, p.y - s / 2 + s * 0.08, s, s);
          } else {
            ctx.globalAlpha = this._alpha * 0.32;
            ctx.drawImage(sprites.light[cl.v], p.x - s / 2, p.y - s / 2, s, s);
          }
        }
      }
      ctx.globalAlpha = 1;

      // 3. Окна в облаках над открытыми главами
      ctx.globalCompositeOperation = "destination-out";
      var self = this;
      Object.keys(this._holes).forEach(function (id) {
        var hInfo = self._holes[id];
        if (hInfo.k <= 0) return;
        // окно не меньше 70 px, чтобы и на общем плане было видно открытое место
        var r = Math.max(hInfo.km * ppk, 70) * hInfo.k;
        self._softHole(ctx, map.latLngToLayerPoint([hInfo.lat, hInfo.lng]), r, id.length * 7 + 3);
      });
      Object.keys(this._corridors).forEach(function (id) {
        var co = self._corridors[id];
        if (co.k <= 0) return;
        var pts = co.points.map(function (ll) { return map.latLngToLayerPoint(ll); });
        var lens = [0];
        for (var i = 1; i < pts.length; i++) lens.push(lens[i - 1] + pts[i].distanceTo(pts[i - 1]));
        var total = lens[lens.length - 1] * co.k;
        var r = Math.max(co.km * ppk, 34);
        var step = Math.max(6, r * 0.45), seg = 1, n = 0;
        for (var d = 0; d <= total; d += step) {
          while (seg < pts.length - 1 && lens[seg] < d) seg++;
          var a = pts[seg - 1], b = pts[seg], t = (d - lens[seg - 1]) / ((lens[seg] - lens[seg - 1]) || 1);
          var pp = L.point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
          self._softHole(ctx, pp, r * (0.85 + 0.15 * Math.sin(n * 1.3)), n * 5 + id.length, 0.5, 3);
          n++;
        }
      });
      // Между городами открывается и окружающая местность, а не только линия.
      // Размытые участки привязаны к тем же координатам и масштабируются с картой.
      Object.keys(this._regions).forEach(function (id) {
        var region = self._regions[id];
        if (region.k <= 0) return;
        var r = Math.max(region.km * ppk, 55) * (0.55 + 0.45 * region.k);
        region.points.forEach(function (ll) {
          var p = map.latLngToLayerPoint(ll);
          var g = ctx.createRadialGradient(p.x, p.y, r * 0.12, p.x, p.y, r);
          g.addColorStop(0, "rgba(0,0,0," + (0.86 * region.k) + ")");
          g.addColorStop(0.55, "rgba(0,0,0," + (0.58 * region.k) + ")");
          g.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
        });
      });
      ctx.restore();
      ctx.globalCompositeOperation = "source-over";
    },

    // Мягкое «окно» с неровным краем
    _softHole: function (ctx, p, r, seed, strength, count) {
      if (r < 1) return;
      strength = strength == null ? 1 : strength;
      var rnd = U.rng(seed);
      for (var i = 0; i < (count || 6); i++) {
        var a = rnd() * Math.PI * 2, d = r * 0.18 * rnd();
        var x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d, rr = r * (0.78 + rnd() * 0.3);
        var g = ctx.createRadialGradient(x, y, rr * 0.25, x, y, rr);
        g.addColorStop(0, "rgba(0,0,0," + (0.55 * strength) + ")");
        g.addColorStop(0.6, "rgba(0,0,0," + (0.32 * strength) + ")");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fill();
      }
    }
  });

  /* ===================================================================
     КАРТА
     =================================================================== */

  function JourneyMap(el, geo, chapters, handlers) {
    this.geo = geo;
    this.chapters = chapters;
    this.handlers = handlers || {};
    this.markers = {};
    this.routes = {};
    this.state = {};
    var ext = geo.extent;
    var bounds = L.latLngBounds([ext[1], ext[0]], [ext[3], ext[2]]);
    this.extentBounds = bounds;

    var map = this.map = L.map(el, {
      zoomControl: false,
      attributionControl: true,
      minZoom: 6.5,
      maxZoom: 17,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      scrollWheelZoom: false,
      touchZoom: true,
      inertia: true,
      maxBounds: bounds.pad(-0.02),
      maxBoundsViscosity: 1,
      keyboard: true,
      keyboardPanDelta: 120,
      worldCopyJump: false,
      fadeAnimation: true
    });
    map.setView(bounds.getCenter(), 8, { animate: false });
    // Не показываем пустоту за пределами загруженной географии при отдалении.
    function limitZoomOut() {
      map.setMinZoom(Math.max(6.5, map.getBoundsZoom(bounds.pad(-0.02), true)));
    }
    limitZoomOut();
    map.on("resize", limitZoomOut);
    // Свайп двумя пальцами на тачпаде двигает карту без нажатия.
    // Жест щипка (Ctrl+wheel в браузере) по-прежнему меняет масштаб.
    var wheelX = 0, wheelY = 0, wheelFrame = null;
    el.addEventListener("wheel", function (e) {
      e.preventDefault();
      if (e.ctrlKey) {
        map.setZoomAround(map.mouseEventToContainerPoint(e), map.getZoom() - Math.sign(e.deltaY) * 0.25);
        return;
      }
      var unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? map.getSize().y : 1;
      wheelX += e.deltaX * unit;
      wheelY += e.deltaY * unit;
      if (wheelFrame !== null) return;
      wheelFrame = requestAnimationFrame(function () {
        map.panBy([wheelX, wheelY], { animate: false });
        wheelX = wheelY = 0;
        wheelFrame = null;
      });
    }, { passive: false });
    map.attributionControl.setPrefix(false);
    map.attributionControl.addAttribution('Карта: <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>, © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">участники OpenStreetMap</a> · <a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    L.control.zoom({ position: "bottomright", zoomInTitle: "Приблизить", zoomOutTitle: "Отдалить" }).addTo(map);
    var scale = L.control.scale({ position: "bottomright", imperial: false, maxWidth: 110 });
    scale._updateMetric = function (maxMeters) {
      var meters = this._getRoundNum(maxMeters), label = meters < 1000 ? meters + " м" : (meters / 1000) + " км";
      this._updateScale(this._mScale, label, meters / maxMeters);
    };
    scale.addTo(map);

    [["base", 250], ["rivers", 300], ["labels", 350], ["fog", 450], ["cartography", 465], ["routes", 500], ["eventMarkers", 590]].forEach(function (p) {
      var pane = map.createPane(p[0]);
      pane.style.zIndex = p[1];
      if (p[0] === "labels" || p[0] === "fog" || p[0] === "cartography") pane.style.pointerEvents = "none";
    });

    this._drawBase();
    this.fog = new FogLayer({ pane: "fog" });
    map.addLayer(this.fog);
    var focus = [];
    chapters.forEach(function (c) { focus.push(c.place.coords); if (c.eventPlace) focus.push(c.eventPlace.coords); });
    this.fog.setCloudField([ext[0], ext[1], ext[2], ext[3]], focus);

    this.routeRenderer = L.svg({ pane: "routes", padding: 0.5 });
    var self = this;
    map.on("zoomend moveend resize", function () {
      self._spreadMarkers(); self._styleRivers();
      map.getContainer().classList.toggle("zoom-low", map.getZoom() < 9.5);
    });
  }

  /* ---------- подложка ---------- */

  JourneyMap.prototype._drawBase = function () {
    var map = this.map, geo = this.geo;
    var baseR = L.canvas({ pane: "base", padding: 0.3 });
    var riverR = L.canvas({ pane: "rivers", padding: 0.3 });
    var toLL = function (ring) { return ring.map(function (p) { return [p[1], p[0]]; }); };

    // соседние регионы и юг Тюменской области
    geo.regions.forEach(function (r) {
      r.rings.forEach(function (poly) {
        L.polygon(poly.map(toLL), {
          renderer: baseR, interactive: false,
          stroke: true, color: r.tyumen ? "#515B63" : "#343C44", weight: r.tyumen ? 1.4 : 1,
          dashArray: r.tyumen ? "1 0" : "4 5", opacity: r.tyumen ? 0.75 : 0.6,
          fill: true, fillColor: r.tyumen ? "#252B31" : "#171C21", fillOpacity: 1
        }).addTo(map);
      });
    });

    // сетка градусов — деликатная картографическая деталь
    var ext = geo.extent;
    for (var lon = Math.ceil(ext[0]); lon <= ext[2]; lon += 1) {
      L.polyline([[ext[1], lon], [ext[3], lon]], { renderer: baseR, interactive: false, color: "#485058", weight: 0.6, opacity: 0.3, dashArray: "2 6" }).addTo(map);
    }
    for (var lat = Math.ceil(ext[1] * 2) / 2; lat <= ext[3]; lat += 0.5) {
      L.polyline([[lat, ext[0]], [lat, ext[2]]], { renderer: baseR, interactive: false, color: "#485058", weight: 0.6, opacity: 0.3, dashArray: "2 6" }).addTo(map);
    }

    geo.urban.forEach(function (u) {
      L.polygon(u.rings.map(toLL), { renderer: baseR, interactive: false, stroke: true, color: "#67717B", weight: 0.8, opacity: 0.5, fillColor: "#67717B", fillOpacity: 0.12 }).addTo(map);
    });

    geo.lakes.forEach(function (l) {
      L.polygon(l.rings.map(toLL), { renderer: riverR, interactive: false, color: "#7893A3", weight: 1, fillColor: "#465E6C", fillOpacity: 0.9 }).addTo(map);
    });

    var rank = { "Иртыш": 3.2, "Тобол": 2.8, "Тура": 2.6, "Тавда": 1.8, "Исеть": 1.8, "Ишим": 1.8, "Пышма": 1.5, "Вагай": 1.5, "Тюменка": 1.1 };
    this._rivers = [];
    var self = this;
    Object.keys(geo.rivers).forEach(function (name) {
      geo.rivers[name].forEach(function (line) {
        var ll = toLL(line);
        var glow = L.polyline(ll, { renderer: riverR, interactive: false, color: "#546D7B", opacity: 0.18, lineCap: "round", lineJoin: "round" }).addTo(map);
        var core = L.polyline(ll, { renderer: riverR, interactive: false, color: "#7893A3", opacity: 0.78, lineCap: "round", lineJoin: "round" }).addTo(map);
        self._rivers.push({ name: name, glow: glow, core: core, w: rank[name] || 1.2 });
      });
    });
    this._styleRivers();
    this._labels();
  };

  JourneyMap.prototype._styleRivers = function () {
    var z = this.map.getZoom();
    var k = Math.max(0.7, Math.min(2.6, 0.55 + (z - 7) * 0.32));
    this._rivers.forEach(function (r) {
      r.core.setStyle({ weight: r.w * k });
      r.glow.setStyle({ weight: r.w * k * 3.4 });
    });
  };

  // Подписи рек (по направлению течения в этом месте) и городов
  JourneyMap.prototype._labels = function () {
    var map = this.map, geo = this.geo;
    var spots = { "Тура": 0.55, "Тобол": 0.42, "Иртыш": 0.5, "Исеть": 0.6, "Пышма": 0.5, "Тавда": 0.62, "Вагай": 0.45, "Ишим": 0.5 };
    Object.keys(spots).forEach(function (name) {
      var lines = geo.rivers[name];
      if (!lines || !lines.length) return;
      var line = lines.reduce(function (a, b) { return a.length > b.length ? a : b; });
      if (line.length < 4) return;
      var i = Math.floor(line.length * spots[name]);
      var a = line[Math.max(0, i - 3)], b = line[Math.min(line.length - 1, i + 3)];
      var pa = map.project([a[1], a[0]], 10), pb = map.project([b[1], b[0]], 10);
      var ang = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI;
      if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
      L.marker([line[i][1], line[i][0]], {
        pane: "labels", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "map-label map-label--river", html: '<span style="transform:rotate(' + ang.toFixed(1) + 'deg)">' + name + "</span>", iconSize: [0, 0] })
      }).addTo(map);
    });
    var cities = [["Тюмень", 57.152, 65.565, "big"], ["Тобольск", 58.226, 68.275, "big"], ["Ялуторовск", 56.66, 66.33, ""]];
    cities.forEach(function (c) {
      L.marker([c[1], c[2]], {
        pane: "cartography", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "map-label map-label--city " + (c[3] ? "map-label--big" : ""), html: "<span>" + c[0] + "</span>", iconSize: [0, 0] })
      }).addTo(map);
    });
    // Второстепенные населённые пункты служат ориентирами и не связаны с главами.
    // Координаты центров — OpenStreetMap (см. docs/MAP_DECOR.md).
    var towns = [
      ["Заводоуковск", 56.50929, 66.53926],
      ["Ишим", 56.10920, 69.45720],
      ["Ярково", 57.40559, 67.07177],
      ["Нижняя Тавда", 57.67390, 66.18274],
      ["Покровское", 57.23961, 66.78756],
      ["Вагай", 57.93522, 69.01259],
      ["Уват", 59.14288, 68.89617]
    ];
    towns.forEach(function (c) {
      L.marker([c[1], c[2]], {
        pane: "cartography", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "map-label map-label--town", html: '<span class="map-town__dot"></span><span class="map-town__name">' + U.escape(c[0]) + '</span>', iconSize: [0, 0] })
      }).addTo(map);
    });
    this._forestMarks(towns.concat(cities));
  };

  JourneyMap.prototype._forestMarks = function (settlements) {
    var map = this.map, geo = this.geo, rnd = U.rng(72619);
    var region = geo.regions.find(function (r) { return r.tyumen; });
    if (!region) return;
    function inRing(lon, lat, ring) {
      var inside = false;
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var a = ring[i], b = ring[j];
        if ((a[1] > lat) !== (b[1] > lat) && lon < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
      }
      return inside;
    }
    function inRegion(lon, lat) {
      return region.rings.some(function (poly) {
        return inRing(lon, lat, poly[0]) && !poly.slice(1).some(function (hole) { return inRing(lon, lat, hole); });
      });
    }
    var icon = L.divIcon({
      className: "forest-mark",
      html: '<svg viewBox="0 0 50 34" aria-hidden="true"><path d="M10 6 5 15h2L3 24h14l-4-9h2zM9 24h2v7H9zM26 2l-6 12h2l-5 11h18l-5-11h2zM25 25h2v7h-2zM41 7l-5 9h2l-4 8h14l-4-8h2zM40 24h2v7h-2z"/></svg>',
      iconSize: [50, 34], iconAnchor: [25, 17]
    });
    for (var count = 0, tries = 0; count < 28 && tries < 400; tries++) {
      var lat = 56.3 + rnd() * 2.95, lon = 64.05 + rnd() * 6.15;
      if (!inRegion(lon, lat) || (lat < 57.3 && rnd() < 0.65)) continue;
      if (settlements.some(function (s) { return map.distance([lat, lon], [s[1], s[2]]) < 28000; })) continue;
      var marker = L.marker([lat, lon], { pane: "cartography", interactive: false, keyboard: false, icon: icon }).addTo(map);
      if (marker.getElement()) marker.getElement().setAttribute("aria-hidden", "true");
      count++;
    }
  };

  /* ---------- линии связи между главами ---------- */

  // Дуга между двумя точками: это связь историй, а не дорога.
  JourneyMap.prototype.arc = function (a, b, side) {
    var map = this.map, Z = 12;
    var pa = map.project(a, Z), pb = map.project(b, Z);
    var mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
    var dx = pb.x - pa.x, dy = pb.y - pa.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
    var off = len * 0.2 * (side || 1);
    var cx = mx - dy / len * off, cy = my + dx / len * off;
    var pts = [];
    for (var i = 0; i <= 40; i++) {
      var t = i / 40, it = 1 - t;
      var x = it * it * pa.x + 2 * it * t * cx + t * t * pb.x, y = it * it * pa.y + 2 * it * t * cy + t * t * pb.y;
      var ll = map.unproject([x, y], Z);
      pts.push([ll.lat, ll.lng]);
    }
    return pts;
  };

  JourneyMap.prototype.addRoute = function (fromIdx, toIdx, animate, duration) {
    var id = fromIdx + "-" + toIdx;
    if (this.routes[id]) return Promise.resolve();
    var a = this.chapters[fromIdx].place.coords, b = this.chapters[toIdx].place.coords;
    var pts = this.arc(a, b, fromIdx % 2 ? -1 : 1);
    var line = L.polyline(pts, { renderer: this.routeRenderer, interactive: false, className: "route", color: "#D6A45B", weight: 1.6, opacity: 0.78, lineCap: "round" }).addTo(this.map);
    this.routes[id] = { line: line, pts: pts };
    var path = line.getElement();
    if (!animate || !path || !path.getTotalLength) {
      if (path) path.classList.add("route--done");
      return Promise.resolve();
    }
    var L0 = path.getTotalLength();
    path.style.strokeDasharray = L0 + " " + L0;
    path.style.strokeDashoffset = L0;
    return U.tween(duration, function (k) { path.style.strokeDashoffset = L0 * (1 - k); }).then(function () {
      path.style.strokeDasharray = ""; path.style.strokeDashoffset = "";
      path.classList.add("route--done");
    });
  };

  JourneyMap.prototype.clearRoutes = function () {
    var self = this;
    Object.keys(this.routes).forEach(function (id) { self.map.removeLayer(self.routes[id].line); });
    this.routes = {};
  };

  /* ---------- огоньки ---------- */

  JourneyMap.prototype.setMarker = function (idx, status, opts) {
    opts = opts || {};
    var ch = this.chapters[idx], self = this;
    var m = this.markers[idx];
    if (status === "locked") {
      if (m) { this.map.removeLayer(m); delete this.markers[idx]; }
      return null;
    }
    var label = status === "available"
      ? "Глава " + (idx + 1) + ": " + ch.title + ". Открыть главу"
      : "Глава " + (idx + 1) + ": " + ch.title + " (пройдена). Открыть снова";
    var html = '<span class="stop__anchor"></span><span class="stop__leader"></span>' +
      '<span class="stop__body"><span class="stop__halo"></span><span class="stop__core"></span>' +
      '<span class="stop__num">' + (idx + 1) + "</span></span>" +
      (status === "available" ? '<span class="stop__hint">Глава ' + (idx + 1) + "</span>" : "");
    var icon = L.divIcon({ className: "stop stop--" + status + (opts.appear ? " stop--appear" : ""), html: html, iconSize: [52, 52], iconAnchor: [26, 26] });
    if (!m) {
      m = L.marker(ch.place.coords, { icon: icon, keyboard: true, title: "", riseOnHover: true, zIndexOffset: status === "available" ? 1000 : 0 });
      m.on("click", function () { if (self.handlers.onStop) self.handlers.onStop(idx); });
      m.addTo(this.map);
      this.markers[idx] = m;
    } else {
      m.setIcon(icon);
      m.setZIndexOffset(status === "available" ? 1000 : 0);
    }
    var el = m.getElement();
    if (el) {
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", label);
      el.setAttribute("tabindex", "0");
      el.dataset.idx = idx;
      el.onkeydown = function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (self.handlers.onStop) self.handlers.onStop(idx); }
      };
    }
    this._spreadMarkers();
    return m;
  };

  JourneyMap.prototype.markerElement = function (idx) {
    var m = this.markers[idx];
    return m ? m.getElement() : null;
  };

  // Экранная точка «тела» огонька (с учётом разнесения близких огоньков)
  JourneyMap.prototype.markerScreenPoint = function (idx) {
    var el = this.markerElement(idx);
    if (el) {
      var body = el.querySelector(".stop__body"), r = (body || el).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    var p = this.map.latLngToContainerPoint(this.chapters[idx].place.coords), cr = this.map.getContainer().getBoundingClientRect();
    return { x: cr.left + p.x, y: cr.top + p.y };
  };

  // Несколько остановок в одном городе: если огоньки накладываются,
  // разносим их по кругу и рисуем тонкую линию к точному месту.
  JourneyMap.prototype._spreadMarkers = function () {
    var map = this.map, items = [], self = this;
    Object.keys(this.markers).forEach(function (k) {
      var idx = +k, m = self.markers[k];
      items.push({ idx: idx, p: map.latLngToContainerPoint(m.getLatLng()), el: m.getElement() });
    });
    var MIN = 46, used = {}, groups = [];
    items.forEach(function (a) {
      if (used[a.idx]) return;
      var g = [a]; used[a.idx] = true;
      var grew = true;
      while (grew) {
        grew = false;
        items.forEach(function (b) {
          if (used[b.idx]) return;
          if (g.some(function (c) { return c.p.distanceTo(b.p) < MIN; })) { g.push(b); used[b.idx] = true; grew = true; }
        });
      }
      groups.push(g);
    });
    groups.forEach(function (g) {
      if (g.length === 1) { self._offset(g[0].el, 0, 0); return; }
      var cx = 0, cy = 0;
      g.forEach(function (it) { cx += it.p.x; cy += it.p.y; });
      cx /= g.length; cy /= g.length;
      var R = 30 + g.length * 4;
      g.sort(function (a, b) { return a.idx - b.idx; });
      g.forEach(function (it, i) {
        var ang = -Math.PI / 2 + i * (2 * Math.PI / g.length);
        var tx = cx + Math.cos(ang) * R, ty = cy + Math.sin(ang) * R;
        self._offset(it.el, tx - it.p.x, ty - it.p.y);
      });
    });
  };

  JourneyMap.prototype._offset = function (el, dx, dy) {
    if (!el) return;
    var body = el.querySelector(".stop__body"), leader = el.querySelector(".stop__leader"), hint = el.querySelector(".stop__hint");
    var moved = Math.abs(dx) + Math.abs(dy) > 0.5;
    el.classList.toggle("stop--spread", moved);
    if (body) body.style.transform = "translate(" + dx.toFixed(1) + "px," + dy.toFixed(1) + "px)";
    if (hint) hint.style.transform = "translate(calc(-50% + " + dx.toFixed(1) + "px)," + dy.toFixed(1) + "px)";
    if (leader) {
      var len = Math.sqrt(dx * dx + dy * dy);
      leader.style.width = Math.max(0, len - 10).toFixed(1) + "px";
      leader.style.transform = "rotate(" + (Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1) + "deg)";
    }
  };

  /* ---------- место события (если отличается от смотровой точки) ---------- */

  JourneyMap.prototype.setEventPlace = function (idx, show) {
    this._events = this._events || {};
    var ch = this.chapters[idx];
    if (!ch.eventPlace) return;
    if (!show) { if (this._events[idx]) { this.map.removeLayer(this._events[idx]); delete this._events[idx]; } return; }
    if (this._events[idx]) return;
    var m = L.marker(ch.eventPlace.coords, {
      pane: "eventMarkers", interactive: false, keyboard: false,
      icon: L.divIcon({ className: "event-place", html: '<span class="event-place__mark"></span><span class="event-place__label">' + U.escape(ch.eventPlace.name) + "</span>", iconSize: [14, 14], iconAnchor: [7, 7] })
    }).addTo(this.map);
    this._events[idx] = m;
  };

  /* ---------- камера ---------- */

  JourneyMap.prototype._afterMove = function (timeout) {
    var map = this.map;
    return new Promise(function (resolve) {
      var done = false;
      function fin() { if (done) return; done = true; map.off("moveend", fin); resolve(); }
      map.on("moveend", fin);
      setTimeout(fin, timeout);
    });
  };

  JourneyMap.prototype.flyTo = function (latlng, zoom, ms) {
    var map = this.map;
    var target = L.latLng(latlng);
    if (U.reducedMotion() || ms <= 0) { map.setView(target, zoom, { animate: false }); return Promise.resolve(); }
    var same = map.getCenter().distanceTo(target) < 5 && Math.abs(map.getZoom() - zoom) < 0.05;
    if (same) return Promise.resolve();
    var p = this._afterMove(ms + 600);
    map.flyTo(target, zoom, { duration: ms / 1000, easeLinearity: 0.3 });
    return p;
  };

  JourneyMap.prototype.flyToBounds = function (bounds, opts, ms) {
    var map = this.map;
    opts = opts || {};
    if (U.reducedMotion() || ms <= 0) { map.fitBounds(bounds, L.extend({ animate: false }, opts)); return Promise.resolve(); }
    var p = this._afterMove(ms + 600);
    map.flyToBounds(bounds, L.extend({ duration: ms / 1000, easeLinearity: 0.3 }, opts));
    return p;
  };

  JourneyMap.prototype.viewPadding = function () {
    var w = this.map.getSize().x, h = this.map.getSize().y;
    var small = w < 720;
    return {
      paddingTopLeft: [small ? 40 : Math.min(460, w * 0.36), small ? 170 : 120],
      paddingBottomRight: [small ? 40 : 90, small ? 150 : 140]
    };
  };

  window.JourneyMap = JourneyMap;
})();
