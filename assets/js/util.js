/* Вспомогательные функции: типографика, фото, хранилище, анимации. */
(function () {
  "use strict";

  var U = {};

  /* ---------- текст ---------- */

  U.escape = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };

  // Неразрывные пробелы после коротких слов и перед тире — чтобы строки не
  // заканчивались на «в», «и», «с» и не начинались с тире.
  var SHORT = /(^|[\s(«„"])((?:[ВвИиКкСсУуОоАаЯя]|[Нн]а|[Пп]о|[Зз]а|[Ии]з|[Оо]т|[Дд]о|[Нн]е|[Нн]о|[Тт]о|[Жж]е|[Вв]о|[Сс]о|[Кк]о|[Оо]б|[Бб]ы|[Лл]и|[Ии]м|[Ее]го|[Ее]ё|[Ии]х|[Пп]ри|[Дд]ля|[Пп]од|[Нн]ад|[Бб]ез|[Пп]ро|[Тт]ри|[Дд]ва|г\.|гг\.|вв?\.|ул\.|пл\.|им\.|тыс\.|№))\s/g;
  U.typo = function (s) {
    if (!s) return "";
    var out = U.escape(s);
    out = out.replace(SHORT, "$1$2 ").replace(SHORT, "$1$2 ");
    out = out.replace(/\s—\s/g, " — ");
    out = out.replace(/(\d)\s(год|года|году|годах|годы|тонн|км|м|тыс|млрд|рублей|век|века|веке|веков)(?=[\s.,;:)]|$)/g, "$1 $2");
    return out;
  };

  U.plural = function (n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  };

  /* ---------- фотографии ---------- */

  U.commonsPage = function (file) {
    return "https://commons.wikimedia.org/wiki/File:" + encodeURIComponent(file.replace(/ /g, "_"));
  };
  U.commonsUrl = function (file, width) {
    return "https://commons.wikimedia.org/wiki/Special:FilePath/" +
      encodeURIComponent(file.replace(/ /g, "_")) + "?width=" + width;
  };
  U.localPhoto = function (photo) {
    if (photo.local) return photo.local;
    var m = window.JOURNEY_LOCAL_PHOTOS || {};
    return m[photo.file] || "";
  };

  // Создаёт <figure> с фото, подписью и запасным вариантом, если фото не загрузится.
  U.photoFigure = function (photo, opts) {
    opts = opts || {};
    var cfg = window.JOURNEY_CONFIG;
    var fig = document.createElement("figure");
    fig.className = "photo " + (opts.className || "");
    var frame = document.createElement("div");
    frame.className = "photo__frame is-loading";
    var img = document.createElement("img");
    img.alt = photo.alt || "";
    img.decoding = "async";
    if (opts.eager) { img.loading = "eager"; img.fetchPriority = "high"; } else { img.loading = "lazy"; }
    var local = U.localPhoto(photo);
    var remote = U.commonsUrl(photo.file, opts.width || 1280);
    var remoteSet = cfg.PHOTO_WIDTHS.map(function (w) { return U.commonsUrl(photo.file, w) + " " + w + "w"; }).join(", ");
    var triedRemote = !local;
    if (local) { img.src = local; }
    else { img.src = remote; img.srcset = remoteSet; img.sizes = opts.sizes || "100vw"; }
    img.addEventListener("load", function () { frame.classList.remove("is-loading"); });
    img.addEventListener("error", function () {
      if (!triedRemote) {
        triedRemote = true; img.src = remote; img.srcset = remoteSet; img.sizes = opts.sizes || "100vw";
        return;
      }
      frame.classList.remove("is-loading");
      frame.classList.add("is-missing");
      img.remove();
      var miss = document.createElement("div");
      miss.className = "photo__missing";
      miss.innerHTML = '<span class="photo__missing-icon" aria-hidden="true"></span>' +
        "<span>Фотография не загрузилась.</span>" +
        '<span class="photo__missing-alt">' + U.escape(photo.alt) + "</span>" +
        '<a href="' + U.commonsPage(photo.file) + '" target="_blank" rel="noopener">Открыть на Wikimedia Commons</a>';
      frame.appendChild(miss);
    });
    frame.appendChild(img);
    fig.appendChild(frame);
    if (opts.caption !== false) {
      var cap = document.createElement("figcaption");
      cap.className = "photo__caption";
      cap.innerHTML = U.typo(photo.caption) + ' <span class="photo__credit">Фото: ' + U.escape(photo.author) +
        ", " + U.licenseLink(photo) + ' · <a href="' + U.commonsPage(photo.file) +
        '" target="_blank" rel="noopener">источник</a></span>';
      fig.appendChild(cap);
    }
    return fig;
  };

  U.licenseLink = function (photo) {
    if (photo.licenseUrl) {
      return '<a href="' + U.escape(photo.licenseUrl) + '" target="_blank" rel="noopener license">' + U.escape(photo.license) + "</a>";
    }
    return U.escape(photo.license);
  };

  /* ---------- карты для поездки ---------- */

  U.routeLinks = function (coords) {
    var lat = coords[0], lon = coords[1];
    return {
      yandex: "https://yandex.ru/maps/?rtext=~" + lat + "%2C" + lon + "&rtt=auto",
      osm: "https://www.openstreetmap.org/?mlat=" + lat + "&mlon=" + lon + "#map=17/" + lat + "/" + lon
    };
  };

  /* ---------- хранилище ---------- */

  U.store = {
    get: function (key) {
      try { var v = window.localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
    },
    set: function (key, value) {
      try { window.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    remove: function (key) {
      try { window.localStorage.removeItem(key); } catch (e) { /* ничего */ }
    }
  };

  /* ---------- движение ---------- */

  U.reducedMotion = function () {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  };

  U.wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  U.easeInOut = function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  U.easeOut = function (t) { return 1 - Math.pow(1 - t, 3); };

  // Анимация числового значения с колбэком на каждом кадре.
  U.tween = function (duration, onFrame, ease) {
    ease = ease || U.easeInOut;
    return new Promise(function (resolve) {
      if (duration <= 0) { onFrame(1); resolve(); return; }
      var start = null;
      function step(ts) {
        if (start === null) start = ts;
        var t = Math.min(1, (ts - start) / duration);
        onFrame(ease(t));
        if (t < 1) requestAnimationFrame(step); else resolve();
      }
      requestAnimationFrame(step);
    });
  };

  // Детерминированный генератор случайных чисел (облака всегда одинаковые).
  U.rng = function (seed) {
    var s = seed >>> 0;
    return function () {
      s += 0x6D2B79F5;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  window.JourneyUtil = U;
})();
