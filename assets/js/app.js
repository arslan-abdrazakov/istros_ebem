/*
  Логика путешествия: прогресс, главы, переходы «карта → глава → карта».
*/
(function () {
  "use strict";
  var U = window.JourneyUtil;
  var CFG = window.JOURNEY_CONFIG;
  var D = CFG.DURATION;

  var C, chapters, N, jmap, state;
  var busy = false, openIdx = null, finalCollapsed = false, closingViaUI = false;
  var $ = function (id) { return document.getElementById(id); };

  /* ================= запуск ================= */

  function fatal(msg) {
    var l = $("loader");
    if (l) {
      l.classList.add("loader--error");
      l.innerHTML = '<div class="loader__box"><p class="loader__title">Не удалось открыть путешествие</p><p>' + U.escape(msg) + "</p></div>";
    }
  }

  function init() {
    C = window.JOURNEY_CONTENT;
    if (!window.L) return fatal("Не загрузилась библиотека карты (assets/vendor/leaflet).");
    if (!C || !C.chapters || !C.chapters.length) return fatal("Не загрузилось содержание глав. Проверьте файл content/chapters.js — возможно, в нём ошибка JSON (лишняя запятая или кавычка).");
    if (!window.JOURNEY_GEO) return fatal("Не загрузились картографические данные (content/geo.js).");
    chapters = C.chapters;
    N = chapters.length;
    state = loadState();

    fillStaticTexts();
    jmap = new window.JourneyMap($("map"), window.JOURNEY_GEO, chapters, { onStop: onStop });
    window.__journey = { map: jmap };  // для отладки в консоли браузера
    applyStateToMap();
    initialCamera();
    renderTimeline();
    updateHud();
    bindUi();
    if (state.completed >= N) showFinal(false);

    var fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    Promise.race([fontsReady, U.wait(1500)]).then(function () {
      var l = $("loader");
      l.classList.add("loader--hidden");
      setTimeout(function () { l.hidden = true; }, 500);
      document.body.classList.add("is-ready");
    });
  }

  /* ================= прогресс ================= */

  function loadState() {
    var s = U.store.get(CFG.STORAGE_KEY) || {};
    var completed = parseInt(s.completed, 10);
    if (!(completed >= 0)) completed = 0;
    completed = Math.min(completed, N);
    // если порядок глав поменяли, проверяем по id последней пройденной
    if (s.ids && s.ids.length === completed) {
      for (var i = 0; i < completed; i++) if (!chapters[i] || chapters[i].id !== s.ids[i]) { completed = i; break; }
    }
    return { completed: completed };
  }
  function saveState() {
    U.store.set(CFG.STORAGE_KEY, { completed: state.completed, ids: chapters.slice(0, state.completed).map(function (c) { return c.id; }), savedAt: new Date().toISOString() });
  }
  function status(i) {
    if (i < state.completed) return "visited";
    if (i === state.completed && i < N) return "available";
    return "locked";
  }
  function isOpenable(i) { return status(i) !== "locked"; }

  /* ================= карта ================= */

  function corridorKm(i) { return Math.max(1.2, Math.min(5, (chapters[i].reveal.km || 4) * 0.45)); }

  function applyStateToMap() {
    for (var i = 0; i < N; i++) {
      var st = status(i), ch = chapters[i];
      jmap.setMarker(i, st);
      if (st !== "locked") jmap.fog.setHole(ch.id, ch.place.coords, ch.reveal.km || 5, 1);
      jmap.setEventPlace(i, st === "visited");
      if (i > 0 && st !== "locked") {
        jmap.addRoute(i - 1, i, false);
        jmap.fog.setCorridor("c" + i, jmap.routes[(i - 1) + "-" + i].pts, corridorKm(i), 1);
      }
    }
    if (state.completed >= N) jmap.fog.setAlpha(0);
  }

  function unlockedBounds() {
    var pts = [];
    for (var i = 0; i < N; i++) if (isOpenable(i)) pts.push(chapters[i].place.coords);
    return L.latLngBounds(pts);
  }

  function initialCamera() {
    var m = jmap.map;
    if (state.completed === 0) {
      var c = L.latLng(chapters[0].place.coords);
      m.fitBounds(c.toBounds(46000), L.extend({ animate: false }, jmap.viewPadding()));
    } else if (state.completed >= N) {
      m.fitBounds(unlockedBounds().pad(0.08), L.extend({ animate: false }, jmap.viewPadding()));
    } else {
      var b = L.latLngBounds([chapters[state.completed - 1].place.coords, chapters[state.completed].place.coords]);
      m.fitBounds(b.pad(0.3), L.extend({ animate: false, maxZoom: chapters[state.completed].camera.zoom - 1 }, jmap.viewPadding()));
    }
  }

  /* ================= интерфейс карты ================= */

  function fillStaticTexts() {
    document.title = C.meta.title;
    $("hudTitle").innerHTML = U.typo(C.meta.title).replace(". ", ".<br>");
    $("hudSubtitle").innerHTML = U.typo(C.meta.subtitle);
    $("hudScope").innerHTML = U.typo(C.meta.cloudsNote);
  }

  function updateHud() {
    var inv = $("invite"), ind = $("chapterIndicator");
    if (state.completed === 0) inv.innerHTML = U.typo(C.meta.invite);
    else if (state.completed < N) inv.innerHTML = U.typo("Облака расступились: огонёк главы " + (state.completed + 1) + " ждёт вас на карте");
    else inv.innerHTML = U.typo("Путешествие пройдено — откройте любую главу снова");
    ind.textContent = state.completed >= N ? "Пройдены все " + N + " " + U.plural(N, "глава", "главы", "глав")
      : "Глава " + (state.completed + 1) + " из " + N;
    $("btnFinal").hidden = !(state.completed >= N && finalCollapsed);
    $("btnReset").disabled = state.completed === 0;
  }

  function renderTimeline() {
    var ol = $("timelineList");
    ol.innerHTML = "";
    var pct = N > 1 ? Math.min(state.completed, N - 1) / (N - 1) : 0;
    $("timeline").style.setProperty("--progress", pct);
    chapters.forEach(function (ch, i) {
      var st = status(i), li = document.createElement("li"), b = document.createElement("button");
      b.type = "button";
      b.className = "tl tl--" + st;
      b.dataset.idx = i;
      if (st === "locked") {
        b.disabled = true;
        b.setAttribute("aria-label", "Глава " + (i + 1) + " ещё скрыта в тумане");
        b.innerHTML = '<span class="tl__dot" aria-hidden="true"></span><span class="tl__label" aria-hidden="true">?</span>';
      } else {
        b.setAttribute("aria-label", "Глава " + (i + 1) + ", " + ch.timelineLabel + ": " + ch.title + (st === "available" ? " — текущая" : ""));
        b.innerHTML = '<span class="tl__dot" aria-hidden="true"></span><span class="tl__label">' + U.escape(ch.timelineLabel) + "</span>";
        b.addEventListener("click", function () { onStop(i); });
      }
      if (st === "available") b.setAttribute("aria-current", "step");
      li.appendChild(b);
      ol.appendChild(li);
    });
    var cur = state.completed < N ? chapters[state.completed] : null;
    $("timelineNow").innerHTML = cur ? "Сейчас: <b>" + U.escape(cur.timelineLabel) + "</b>" : "Путь пройден";
  }

  function announce(text) {
    var a = $("announcer");
    a.textContent = "";
    setTimeout(function () { a.textContent = text; }, 60);
  }

  /* ================= открытие главы ================= */

  function onStop(i) {
    if (busy || !isOpenable(i)) return;
    if (openIdx !== null) return;
    openChapter(i);
  }

  function preload(photo) {
    return new Promise(function (resolve) {
      var img = new Image(), t = setTimeout(resolve, 1400);
      img.onload = img.onerror = function () { clearTimeout(t); resolve(); };
      var local = U.localPhoto(photo);
      img.src = local || U.commonsUrl(photo.file, 1280);
    });
  }

  function heroSrc(photo) { return U.localPhoto(photo) || U.commonsUrl(photo.file, 1280); }

  function openChapter(i) {
    busy = true;
    openIdx = i;
    var ch = chapters[i];
    hideFinal(true);
    var pre = preload(ch.photo);
    renderChapter(i);
    jmap.flyTo(ch.place.coords, ch.camera.zoom, D.fly)
      .then(function () {
        // облака вокруг точки расходятся
        if (!U.reducedMotion()) {
          U.tween(D.open * 0.8, function (k) { jmap.fog.setHoleK(ch.id, 1 + k * 0.8); });
        }
        return Promise.race([pre, U.wait(450)]);
      })
      .then(function () { return portalOpen(ch.photo, jmap.markerScreenPoint(i)); })
      .then(function () {
        var el = $("chapter");
        el.hidden = false;
        el.scrollTop = 0;
        requestAnimationFrame(function () { el.classList.add("chapter--shown"); });
        $("mapScreen").inert = true;
        $("portal").classList.remove("portal--active");
        try { history.pushState({ chapter: ch.id }, "", "#" + ch.id); } catch (e) { /* file:// */ }
        var h = $("chapterTitle");
        if (h) h.focus({ preventScroll: true });
        announce("Открыта глава " + (i + 1) + ": " + ch.title);
        busy = false;
      });
  }

  function portalOpen(photo, p) {
    var portal = $("portal"), img = $("portalImg");
    img.src = heroSrc(photo);
    img.alt = "";
    portal.classList.add("portal--active");
    var R = Math.hypot(Math.max(p.x, window.innerWidth - p.x), Math.max(p.y, window.innerHeight - p.y)) + 40;
    if (U.reducedMotion()) {
      portal.style.clipPath = "none";
      return portal.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, fill: "forwards" }).finished.catch(function () {});
    }
    portal.style.opacity = 1;
    var a1 = portal.animate([
      { clipPath: "circle(14px at " + p.x + "px " + p.y + "px)" },
      { clipPath: "circle(" + R + "px at " + p.x + "px " + p.y + "px)" }
    ], { duration: D.open, easing: "cubic-bezier(.65,.05,.25,1)", fill: "forwards" });
    img.animate([{ transform: "scale(1.22)" }, { transform: "scale(1)" }],
      { duration: D.open + 250, easing: "cubic-bezier(.2,.7,.2,1)", fill: "forwards" });
    return a1.finished.catch(function () {});
  }

  function portalClose(photo, p) {
    var portal = $("portal"), img = $("portalImg");
    img.src = heroSrc(photo);
    portal.classList.add("portal--active");
    if (U.reducedMotion()) {
      return portal.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" }).finished.catch(function () {}).then(function () {
        portal.classList.remove("portal--active"); portal.getAnimations().forEach(function (a) { a.cancel(); });
      });
    }
    var R = Math.hypot(Math.max(p.x, window.innerWidth - p.x), Math.max(p.y, window.innerHeight - p.y)) + 40;
    img.animate([{ transform: "scale(1)" }, { transform: "scale(1.15)" }], { duration: D.close, easing: "ease-in", fill: "forwards" });
    var a = portal.animate([
      { clipPath: "circle(" + R + "px at " + p.x + "px " + p.y + "px)", opacity: 1 },
      { clipPath: "circle(16px at " + p.x + "px " + p.y + "px)", opacity: 1, offset: 0.88 },
      { clipPath: "circle(6px at " + p.x + "px " + p.y + "px)", opacity: 0 }
    ], { duration: D.close, easing: "cubic-bezier(.55,0,.35,1)", fill: "forwards" });
    return a.finished.catch(function () {}).then(function () {
      portal.classList.remove("portal--active");
      portal.getAnimations().forEach(function (x) { x.cancel(); });
      img.getAnimations().forEach(function (x) { x.cancel(); });
    });
  }

  /* ================= закрытие главы ================= */

  function closeChapter(continueJourney, fromPopstate) {
    if (busy || openIdx === null) return;
    busy = true;
    var i = openIdx, ch = chapters[i];
    var el = $("chapter");
    if (!fromPopstate) {
      try { if (history.state && history.state.chapter) { closingViaUI = true; history.back(); } } catch (e) { /* ничего */ }
    }
    $("mapScreen").inert = false;
    // держим карту на месте главы, чтобы фото вернулось точно в огонёк
    jmap.map.setView(ch.place.coords, jmap.map.getZoom(), { animate: false });
    var p = jmap.markerScreenPoint(i);
    var closing = portalClose(ch.photo, p);
    el.classList.remove("chapter--shown");
    setTimeout(function () { el.hidden = true; el.innerHTML = ""; }, 260);
    jmap.fog.setHoleK(ch.id, 1.8);
    closing.then(function () {
      U.tween(400, function (k) { jmap.fog.setHoleK(ch.id, 1.8 - 0.8 * k); });
      openIdx = null;
      if (continueJourney && i === state.completed) {
        state.completed += 1;
        saveState();
        if (state.completed >= N) return finale();
        return advance(i);
      }
      // просто вернулись к карте: немного отдаляем камеру
      return jmap.flyTo(ch.place.coords, Math.max(8, jmap.map.getZoom() - 1.5), 600).then(function () {
        var m = jmap.markerElement(i); if (m) m.focus();
        if (state.completed >= N) { finalCollapsed = true; updateHud(); }
      });
    }).then(function () { busy = false; });
  }

  function advance(i) {
    var cur = chapters[i], next = chapters[i + 1], ni = i + 1;
    jmap.setMarker(i, "visited");
    jmap.setEventPlace(i, true);
    renderTimeline();
    updateHud();
    var b = L.latLngBounds([cur.place.coords, next.place.coords]);
    var maxZoom = Math.min(next.camera.zoom - 1, 13);
    return jmap.flyToBounds(b.pad(0.25), L.extend({ maxZoom: maxZoom }, jmap.viewPadding()), D.flyOut)
      .then(function () {
        var arcPts = jmap.arc(cur.place.coords, next.place.coords, i % 2 ? -1 : 1);
        jmap.fog.setCorridor("c" + ni, arcPts, corridorKm(ni), 0);
        jmap.fog.setHole(next.id, next.place.coords, next.reveal.km || 5, 0);
        var rm = U.reducedMotion();
        var t1 = U.tween(rm ? 0 : D.reveal, function (k) { jmap.fog.setCorridorK("c" + ni, k); });
        var t2 = U.wait(rm ? 0 : D.reveal * 0.35).then(function () {
          return U.tween(rm ? 0 : D.reveal, function (k) { jmap.fog.setHoleK(next.id, k); }, U.easeOut);
        });
        var t3 = U.wait(rm ? 0 : 150).then(function () { return jmap.addRoute(i, ni, !rm, D.route); });
        return Promise.all([t1, t2, t3]);
      })
      .then(function () {
        jmap.setMarker(ni, "available", { appear: true });
        renderTimeline();
        updateHud();
        announce("Облака рассеялись. Доступна глава " + (ni + 1) + ". Нажмите на огонёк на карте или на шкале времени.");
        var m = jmap.markerElement(ni);
        if (m) setTimeout(function () { m.focus({ preventScroll: true }); }, 300);
      });
  }

  function finale() {
    var last = N - 1;
    jmap.setMarker(last, "visited");
    jmap.setEventPlace(last, true);
    renderTimeline();
    updateHud();
    return jmap.flyToBounds(unlockedBounds().pad(0.08), jmap.viewPadding(), D.flyOut + 300)
      .then(function () {
        return U.tween(U.reducedMotion() ? 0 : 1600, function (k) { jmap.fog.setAlpha(1 - k); });
      })
      .then(function () { showFinal(true); announce("Путешествие завершено. Карта полностью открыта."); });
  }

  /* ================= рендер главы ================= */

  function renderChapter(i) {
    var ch = chapters[i], st = status(i), el = $("chapter");
    var links = U.routeLinks(ch.place.coords);
    var isCurrent = st === "available";
    var isLast = i === N - 1;
    var h = [];
    h.push('<div class="chapter__bar">' +
      '<button type="button" class="btn btn--bar" data-action="to-map"><span aria-hidden="true">←</span> К карте</button>' +
      '<span class="chapter__crumb">' + (ch.kicker === "Пролог" ? "Пролог · " : "") + "Глава " + (i + 1) + " из " + N + " · " + U.escape(ch.timelineLabel) + "</span>" +
      '<span class="chapter__readbar" aria-hidden="true"><i id="readProgress"></i></span></div>');

    h.push('<header class="hero">' +
      '<div class="hero__media" id="heroMedia"></div>' +
      '<div class="hero__shade" aria-hidden="true"></div>' +
      '<div class="hero__text">' +
      '<p class="hero__kicker">' + (ch.kicker === "Пролог" ? "Пролог" : "Глава " + (i + 1)) + "</p>" +
      '<p class="hero__date">' + U.typo(ch.dateLabel) + "</p>" +
      '<h2 class="hero__title" id="chapterTitle" tabindex="-1">' + U.typo(ch.title) + "</h2>" +
      '<p class="hero__lead">' + U.typo(ch.lead) + "</p>" +
      "</div>" +
      '<button type="button" class="hero__credit-toggle" aria-expanded="false" aria-controls="heroCredit">Подпись к фото</button>' +
      '<div class="hero__credit" id="heroCredit" hidden></div>' +
      '<a class="hero__down" href="#chapterStory"><span>Читать</span><span aria-hidden="true">↓</span></a>' +
      "</header>");

    h.push('<div class="paper"><div class="paper__inner">');

    if (ch.from) h.push('<p class="from"><span class="from__label">Откуда мы пришли</span>' + U.typo(ch.from) + "</p>");

    h.push('<dl class="facts">' + ch.facts.map(function (f) {
      return '<div class="facts__row"><dt>' + U.escape(f.label) + "</dt><dd>" + U.typo(f.value) + "</dd></div>";
    }).join("") + "</dl>");

    h.push('<section class="story" id="chapterStory" aria-label="Рассказ">');
    ch.story.forEach(function (b, k) {
      h.push('<div class="story__block"><h3>' + U.typo(b.heading) + "</h3><p>" + U.typo(b.text) + "</p></div>");
      if (k === 1) h.push('<div class="story__figure" data-gallery="0"></div>');
    });
    h.push("</section>");

    if (ch.people && ch.people.length) {
      h.push('<section class="people"><h3 class="section-title">' + (i === 0 ? "Люди этой истории" : "Люди этой главы") + '</h3><ul class="people__list">' +
        ch.people.map(function (p) {
          return '<li class="person"><p class="person__name">' + U.typo(p.name) + '</p><p class="person__role">' + U.typo(p.role) + '</p><p class="person__text">' + U.typo(p.text) + "</p></li>";
        }).join("") + "</ul></section>");
    }

    if (ch.thenNow) h.push('<section class="thennow" id="thenNow"><h3 class="section-title">Тогда и сейчас</h3><div class="thennow__pair"></div><p class="thennow__note">' + U.typo(ch.thenNow.note) + "</p></section>");

    for (var g = 1; g < (ch.gallery || []).length; g++) h.push('<div class="story__figure" data-gallery="' + g + '"></div>');

    h.push('<section class="today"><h3 class="section-title">Что можно увидеть сегодня</h3>' +
      "<p>" + U.typo(ch.today.text) + "</p>" +
      (ch.today.visit ? '<p class="today__visit">' + U.typo(ch.today.visit) + "</p>" : "") +
      '<p class="today__place"><b>' + U.typo(ch.place.official) + "</b><br>" + U.typo(ch.place.address) + "</p>" +
      (ch.eventPlace ? '<p class="today__event">' + U.typo(ch.eventPlace.note) + "</p>" : "") +
      '<div class="today__actions"><a class="btn btn--primary-ghost" href="' + links.yandex + '" target="_blank" rel="noopener">Как добраться <span class="sr-only">(Яндекс Карты, откроется в новой вкладке)</span><span aria-hidden="true">↗</span></a>' +
      '<a class="btn btn--link" href="' + links.osm + '" target="_blank" rel="noopener">Место на OpenStreetMap<span class="sr-only"> (в новой вкладке)</span></a></div>' +
      "</section>");

    h.push('<section class="why"><h3 class="section-title">Почему это важно</h3><p>' + U.typo(ch.why) + "</p></section>");

    if (ch.next && !isLast) h.push('<section class="next"><h3 class="section-title">Дальше в пути</h3><p>' + U.typo(ch.next) + "</p></section>");

    h.push('<details class="sources"><summary>Источники и подписи к изображениям</summary><div class="sources__body">' +
      "<h4>Источники</h4><ol>" + ch.sources.map(function (s) {
        var t = s.url ? '<a href="' + U.escape(s.url) + '" target="_blank" rel="noopener">' + U.typo(s.title) + "</a>" : U.typo(s.title);
        return "<li>" + t + (s.note ? '<span class="sources__note">' + U.typo(s.note) + "</span>" : "") + "</li>";
      }).join("") + "</ol>" +
      "<h4>Изображения</h4><ul>" + allPhotos(ch).map(function (p) {
        return "<li>" + U.typo(p.caption) + ". Автор: " + U.escape(p.author) + ". Лицензия: " + U.licenseLink(p) + '. <a href="' + U.commonsPage(p.file) + '" target="_blank" rel="noopener">Wikimedia Commons</a></li>';
      }).join("") + "</ul>" +
      '<p class="sources__coords">Координаты на карте: ' + U.escape(ch.place.coordSource) + "</p>" +
      "</div></details>");

    if (CFG.SHOW_REVIEW_NOTES && ch.review && ch.review.length) {
      h.push('<details class="review"><summary>Черновик: что проверить в этой главе</summary><ul>' +
        ch.review.map(function (r) { return "<li>" + U.typo(r) + "</li>"; }).join("") + "</ul></details>");
    }

    var primary;
    if (isCurrent) primary = isLast ? "Завершить путешествие" : "Продолжить путешествие";
    else primary = "Вернуться к карте";
    h.push('<div class="chapter__end">' +
      (isCurrent && !isLast ? '<p class="chapter__end-note">Облака над следующей точкой рассеются, когда вы нажмёте «Продолжить путешествие».</p>' : "") +
      '<button type="button" class="btn btn--primary" data-action="' + (isCurrent ? "continue" : "to-map") + '">' + primary + "</button>" +
      (isCurrent ? '<button type="button" class="btn btn--ghost" data-action="to-map">К карте</button>' : "") +
      "</div>");
    h.push("</div></div>");

    el.innerHTML = h.join("");

    // фото
    $("heroMedia").appendChild(U.photoFigure(ch.photo, { eager: true, caption: false, width: 1920, sizes: "100vw", className: "photo--hero" }));
    var credit = $("heroCredit");
    credit.innerHTML = U.typo(ch.photo.caption) + ". Фото: " + U.escape(ch.photo.author) + ", " + U.licenseLink(ch.photo) +
      ' · <a href="' + U.commonsPage(ch.photo.file) + '" target="_blank" rel="noopener">источник</a>';
    el.querySelectorAll("[data-gallery]").forEach(function (slot) {
      var p = (ch.gallery || [])[+slot.dataset.gallery];
      if (p) slot.appendChild(U.photoFigure(p, { sizes: "(max-width: 760px) 100vw, 720px" })); else slot.remove();
    });
    if (ch.thenNow) {
      var pair = el.querySelector(".thennow__pair");
      [["then", "Тогда"], ["now", "Сейчас"]].forEach(function (k) {
        var f = U.photoFigure(ch.thenNow[k[0]], { sizes: "(max-width: 760px) 100vw, 380px", className: "photo--pair" });
        var tag = document.createElement("span");
        tag.className = "thennow__tag"; tag.textContent = k[1];
        f.querySelector(".photo__frame").appendChild(tag);
        pair.appendChild(f);
      });
    }
  }

  function allPhotos(ch) {
    var a = [ch.photo].concat(ch.gallery || []);
    if (ch.thenNow) a.push(ch.thenNow.then, ch.thenNow.now);
    return a;
  }

  /* ================= финал ================= */

  function showFinal(animate) {
    var f = $("final");
    finalCollapsed = false;
    var m = C.meta;
    var authors = (m.authors && m.authors.length) ? m.authors.map(U.escape).join(", ") : "<i>имена авторов будут добавлены</i>";
    f.innerHTML =
      '<div class="final__card" role="region" aria-labelledby="finalTitle">' +
      '<button type="button" class="final__collapse" data-action="collapse-final" aria-label="Свернуть итоги и посмотреть карту">Смотреть карту</button>' +
      '<p class="final__eyebrow">Путешествие завершено</p>' +
      '<h2 id="finalTitle" class="final__title" tabindex="-1">' + U.typo(m.finalTitle) + "</h2>" +
      '<p class="final__text">' + U.typo(m.finalText) + "</p>" +
      '<h3 class="final__h">Вернуться к главе</h3><ol class="final__list">' +
      chapters.map(function (ch, i) {
        return '<li><button type="button" class="final__chapter" data-open="' + i + '"><span class="final__date">' + U.escape(ch.timelineLabel) + "</span>" + U.typo(ch.title) + "</button></li>";
      }).join("") + "</ol>" +
      '<h3 class="final__h">Побывать на месте</h3><p>' + U.typo(m.visitText) + "</p>" +
      '<h3 class="final__h">Об авторах</h3><p>Учебный проект по дисциплине «' + U.escape(m.course) + "». Авторы: " + authors +
      (m.institution ? ". " + U.escape(m.institution) : "") + '.</p><p><button type="button" class="btn btn--link" data-action="about">Источники и фотографии</button></p>' +
      '<div class="final__actions"><button type="button" class="btn btn--ghost" data-action="reset">Пройти заново</button></div>' +
      "</div>";
    f.hidden = false;
    requestAnimationFrame(function () { f.classList.add("final--shown"); });
    $("btnFinal").hidden = true;
    if (animate) { var t = $("finalTitle"); if (t) t.focus({ preventScroll: true }); }
  }

  function hideFinal(keepCollapsedFlag) {
    var f = $("final");
    if (f.hidden) return;
    f.classList.remove("final--shown");
    setTimeout(function () { f.hidden = true; }, 300);
    if (state.completed >= N) finalCollapsed = true;
    updateHud();
  }

  /* ================= «О проекте» и сброс ================= */

  function openAbout() {
    var m = C.meta, d = $("aboutDialog"), body = $("aboutBody");
    var opened = chapters.filter(function (c, i) { return isOpenable(i); });
    var authors = (m.authors && m.authors.length) ? m.authors.map(U.escape).join(", ") : "<i>будут указаны позднее</i>";
    var html = [];
    html.push("<p>" + U.typo(m.about) + "</p><p>" + U.typo(m.scope) + "</p><p>" + U.typo(m.cloudsNote) + "</p>");
    html.push('<h3>Авторы</h3><p>Учебный проект по дисциплине «' + U.escape(m.course) + "», " + U.escape(m.year) + ". Авторы: " + authors + (m.institution ? ". " + U.escape(m.institution) : "") + ".</p>");
    if (CFG.SHOW_REVIEW_NOTES) html.push('<p class="about__draft">Рабочая версия: тексты глав — черновики, они проходят проверку. В каждой главе есть список вопросов к проверке.</p>');
    html.push("<h3>Источники открытых глав</h3>");
    if (opened.length < N) html.push('<p class="about__muted">Источники остальных глав появятся здесь, когда над ними рассеются облака.</p>');
    opened.forEach(function (ch) {
      var idx = chapters.indexOf(ch);
      html.push("<h4>" + (idx + 1) + ". " + U.typo(ch.title) + "</h4><ul>" + ch.sources.map(function (s) {
        return "<li>" + (s.url ? '<a href="' + U.escape(s.url) + '" target="_blank" rel="noopener">' + U.typo(s.title) + "</a>" : U.typo(s.title)) + "</li>";
      }).join("") + "</ul>");
    });
    html.push("<h3>Фотографии</h3><ul>");
    opened.forEach(function (ch) {
      allPhotos(ch).forEach(function (p) {
        html.push("<li>" + U.typo(p.caption) + " — " + U.escape(p.author) + ", " + U.licenseLink(p) + ', <a href="' + U.commonsPage(p.file) + '" target="_blank" rel="noopener">Wikimedia Commons</a></li>');
      });
    });
    html.push("</ul>");
    html.push('<h3>Карта и программы</h3><ul>' +
      '<li>Реки, озёра, границы и города: <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a> (общественное достояние) и © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">участники OpenStreetMap</a> (ODbL).</li>' +
      '<li>Карта: <a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a> (BSD-2-Clause).</li>' +
      "<li>Шрифты Old Standard TT и Golos Text — SIL Open Font License 1.1.</li>" +
      "<li>Линии между главами показывают связь историй, а не дорогу.</li></ul>");
    body.innerHTML = html.join("");
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
  }

  function openReset() {
    var d = $("resetDialog");
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
  }

  function doReset() {
    U.store.remove(CFG.STORAGE_KEY);
    state = { completed: 0 };
    for (var i = 0; i < N; i++) { jmap.setMarker(i, "locked"); jmap.setEventPlace(i, false); }
    jmap.clearRoutes();
    jmap.fog.clearAll();
    hideFinal();
    finalCollapsed = false;
    applyStateToMap();
    initialCamera();
    renderTimeline();
    updateHud();
    announce("Путешествие начато заново.");
    var m = jmap.markerElement(0);
    if (m) setTimeout(function () { m.focus(); }, 100);
  }

  /* ================= события ================= */

  function bindUi() {
    $("btnAbout").addEventListener("click", openAbout);
    $("btnReset").addEventListener("click", openReset);
    $("btnFinal").addEventListener("click", function () { showFinal(true); });
    $("resetConfirm").addEventListener("click", function () { $("resetDialog").close(); doReset(); });
    $("resetCancel").addEventListener("click", function () { $("resetDialog").close(); });
    $("aboutClose").addEventListener("click", function () { $("aboutDialog").close(); });
    [$("aboutDialog"), $("resetDialog")].forEach(function (d) {
      d.addEventListener("click", function (e) { if (e.target === d) d.close(); });
    });

    document.addEventListener("click", function (e) {
      var t = e.target.closest("[data-action], [data-open]");
      if (!t) return;
      if (t.dataset.open != null) { onStop(+t.dataset.open); return; }
      var a = t.dataset.action;
      if (a === "to-map") closeChapter(false);
      else if (a === "continue") closeChapter(true);
      else if (a === "collapse-final") { hideFinal(); var b = $("btnFinal"); if (b) b.focus(); }
      else if (a === "reset") openReset();
      else if (a === "about") openAbout();
    });

    var chapterEl = $("chapter");
    chapterEl.addEventListener("click", function (e) {
      var tg = e.target.closest(".hero__credit-toggle");
      if (tg) {
        var c = $("heroCredit"), open = c.hidden;
        c.hidden = !open; tg.setAttribute("aria-expanded", String(open));
      }
    });
    chapterEl.addEventListener("scroll", function () {
      var bar = $("readProgress");
      if (!bar) return;
      var max = chapterEl.scrollHeight - chapterEl.clientHeight;
      bar.style.transform = "scaleX(" + (max > 0 ? chapterEl.scrollTop / max : 0) + ")";
      chapterEl.classList.toggle("chapter--scrolled", chapterEl.scrollTop > 40);
    }, { passive: true });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (openIdx !== null && !document.querySelector("dialog[open]")) { e.preventDefault(); closeChapter(false); }
        else if (!$("final").hidden && !document.querySelector("dialog[open]")) hideFinal();
      }
    });

    window.addEventListener("popstate", function () {
      if (closingViaUI) { closingViaUI = false; return; }
      if (openIdx !== null) closeChapter(false, true);
    });

    // если в адресе остался #глава от прошлого визита — убираем, чтобы не открыть закрытую главу
    if (location.hash) { try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* ничего */ } }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
