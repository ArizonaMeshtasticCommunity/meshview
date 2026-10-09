/* Meshview "tuck": compact or hide the site header and footer bars, plus the
   Toggles sheet that sets how they behave.

   A page opts in with `set tuckable = true` in its template; base.html then
   loads tuck.css, sheet.css and this file. The header (#site-top) and footer
   (#site-bottom) each get a small stud on the edge facing the page content.
   A click toggles that bar between its full form and its tucked form:

     header  partial:  smaller title, no message line, menu links stay
             complete: hidden; a thin strip keeps the stud
     footer  partial:  page controls as icons, credits and version on one line
             complete: only the credits line

   Which tucked form a stud uses is the bar's "tuck behaviour". Any element with
   data-tuck-settings-open opens the Toggles sheet: view presets (Default view,
   Partial tucked, Completely tucked), the tuck behaviour of each bar, and Hide
   filters. Everything is kept in localStorage (per browser, never sent
   anywhere) and defaults to the bars as Meshview ships them.

   State lives on <html> as classes (see tuck.css). Pages restyle their own
   controls against them and listen for "meshview:tuck" on document
   (detail: {top, bottom, hideFilters, reason, animating}) to refit anything
   sized to the space the bars leave, such as the map. A listener that sizes the
   page may set detail.fits (true when the final page fits the window), which
   keeps a scrollbar from flashing mid-animation. The event also fires when
   a bar changes height for other reasons (header text arriving, filters being
   added, wrapping). */
(function () {
    "use strict";

    if (window.meshviewTuck) return;

    var ROOT = document.documentElement;
    var KEY = "meshview.view";
    var LEGACY = { top: "meshview.tuck.top", bottom: "meshview.tuck.bottom" };
    var LEVELS = ["expanded", "partial", "complete"];
    var DURATION = 320;                                   /* keep in step with tuck.css */

    var BARS = {
        top: {
            host: "site-top", at: "end", cls: "mv-tuck-top",
            name: "tuck_header", compact: "tuck_compact_header", expand: "tuck_expand_header"
        },
        bottom: {
            host: "site-bottom", at: "start", cls: "mv-tuck-bottom",
            name: "tuck_footer", compact: "tuck_compact_footer", expand: "tuck_expand_footer"
        }
    };

    var FALLBACK = {
        tuck_header: "Header details",
        tuck_footer: "Footer details",
        tuck_compact_header: "Compact the header",
        tuck_expand_header: "Expand the header",
        tuck_compact_footer: "Compact the footer",
        tuck_expand_footer: "Expand the footer",
        tg_title: "Toggles",
        tg_view: "View",
        tg_default: "Default view",
        tg_default_sub: "Meshview as it ships",
        tg_partial: "Partial tucked",
        tg_partial_sub: "Smaller header and footer, links and controls stay",
        tg_complete: "Completely tucked",
        tg_complete_sub: "Header hidden, footer shows only the credits",
        tg_behavior: "Tuck behavior",
        tg_header: "Header",
        tg_footer: "Footer",
        tg_level_partial: "Partial",
        tg_level_complete: "Complete",
        tg_filters: "Filters",
        tg_hide_filters: "Hide filters",
        tg_hide_filters_sub: "Routers, MQTT gateways and channel boxes",
        sheet_close: "Close",
        sheet_local_note: "Saved in this browser only."
    };

    /* Glyphs: four corner arrows pointing in (compact) or out (expand). */
    var GLYPH = {
        compact: "m16.1 8.6h2.8v1.4h-4.1v-4.2h1.4v2.8zm-6.9 1.3h-4.1v-1.3h2.8v-2.8h1.4v4.1zm6.9 5.5v2.8h-1.4v-4.1h4.1v1.4h-2.7zm-6.9-1.3v4.1h-1.3v-2.8h-2.8v-1.4z",
        expand: "m14.8 5.6h4.3v4.3h-1.4v-2.9h-2.8v-1.4zm-9.9 0h4.3v1.4h-2.9v2.8h-1.4zm12.8 11.4v-2.8h1.4v4.3h-4.3v-1.5zm-11.4 0h2.8v1.4h-4.2v-4.3h1.4z"
    };
    var CHECK = '<svg class="mv-sheet-check" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.5 12.5l5 5L19.5 6.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

    /* ---- state -------------------------------------------------------------- */

    var DEFAULTS = { top: "expanded", bottom: "expanded", topMode: "partial", bottomMode: "partial", hideFilters: false };

    function clean(s) {
        var out = {};
        out.top = LEVELS.indexOf(s.top) >= 0 ? s.top : DEFAULTS.top;
        out.bottom = LEVELS.indexOf(s.bottom) >= 0 ? s.bottom : DEFAULTS.bottom;
        out.topMode = s.topMode === "complete" ? "complete" : "partial";
        out.bottomMode = s.bottomMode === "complete" ? "complete" : "partial";
        out.hideFilters = s.hideFilters === true;
        return out;
    }

    /* localStorage can throw (private mode, blocked storage): the feature still
       works for the visit, it just is not remembered. */
    var migrated = false;
    function load() {
        var s = null;
        try {
            var raw = window.localStorage.getItem(KEY);
            if (raw) s = JSON.parse(raw);
            else {
                /* first version kept two flags */
                var t = window.localStorage.getItem(LEGACY.top), b = window.localStorage.getItem(LEGACY.bottom);
                if (t !== null || b !== null) {
                    s = { top: t === "1" ? "partial" : "expanded", bottom: b === "1" ? "partial" : "expanded" };
                    migrated = true;
                }
            }
        } catch (_e) { s = null; }
        return clean(s && typeof s === "object" ? s : {});
    }
    function save() {
        try {
            window.localStorage.setItem(KEY, JSON.stringify(state));
            window.localStorage.removeItem(LEGACY.top);
            window.localStorage.removeItem(LEGACY.bottom);
        } catch (_e) { /* not remembered */ }
    }

    var state = load();
    if (migrated) save();                                 /* old keys gone, new one written */
    var studs = {};
    var strings = FALLBACK;
    var sheet = null;
    var animating = false;
    var settleTimer = 0;
    var notifyQueued = false;

    function text(key) { return (strings && strings[key]) || FALLBACK[key]; }

    function reducedMotion() {
        return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    }

    /* ---- classes and studs -------------------------------------------------- */

    function paintClassesFor(s) {
        Object.keys(BARS).forEach(function (bar) {
            ROOT.classList.toggle(BARS[bar].cls, s[bar] !== "expanded");
            ROOT.classList.toggle(BARS[bar].cls + "-complete", s[bar] === "complete");
        });
        ROOT.classList.toggle("mv-hide-filters", s.hideFilters);
    }
    function paintClasses() { paintClassesFor(state); }

    function paintStud(bar) {
        var cfg = BARS[bar], stud = studs[bar];
        if (!stud) return;
        var tucked = state[bar] !== "expanded";
        /* The accessible name stays put and aria-expanded carries the state, so a
           screen reader says "Header details, button, expanded" rather than a
           label that flips at the same moment as the state. The tooltip (also
           the accessible description) says what a click will do. */
        stud.setAttribute("aria-label", text(cfg.name));
        stud.setAttribute("aria-expanded", tucked ? "false" : "true");
        stud.setAttribute("title", text(tucked ? cfg.expand : cfg.compact));
        stud.querySelector("path").setAttribute("d", tucked ? GLYPH.expand : GLYPH.compact);
    }

    function detail(reason) {
        return { top: state.top, bottom: state.bottom, hideFilters: state.hideFilters, reason: reason, animating: animating };
    }
    function emit(reason) {
        var d = detail(reason);
        document.dispatchEvent(new CustomEvent("meshview:tuck", { detail: d }));
        return d;
    }
    /* Size changes that are not ours (text arriving, wrapping) come in batches:
       one refit per frame is enough, and none while an animation is running. */
    function notify(reason) {
        if (notifyQueued || animating) return;
        notifyQueued = true;
        window.requestAnimationFrame(function () {
            notifyQueued = false;
            if (!animating) emit(reason);
        });
    }

    /* ---- changing state, animated ------------------------------------------- */

    function hosts() {
        return Object.keys(BARS).map(function (bar) { return document.getElementById(BARS[bar].host); })
            .filter(Boolean);
    }

    var overflowBefore = null;                             /* <html> overflow-y to restore */

    function measure(el) {
        var cs = window.getComputedStyle(el);
        return { h: el.getBoundingClientRect().height, pt: cs.paddingTop, pb: cs.paddingBottom };
    }
    function unpin(bars) {
        bars.forEach(function (el) {
            el.style.height = "";
            el.style.paddingTop = "";
            el.style.paddingBottom = "";
            el.style.transition = "";
        });
    }

    function finishAnimation() {
        clearTimeout(settleTimer);
        unpin(hosts());
        ROOT.classList.remove("mv-tuck-animating");
        if (overflowBefore !== null) {
            ROOT.style.overflowY = overflowBefore;
            overflowBefore = null;
        }
        if (animating) {
            animating = false;
            emit("settle");
        }
    }

    /* Apply a state change. Each bar runs from its current height and padding to
       its new ones (padding too: a bar's padding is its minimum height, so pinning
       only the height would make it jump). Listeners are told first, with
       animating: true, so they can give the map its final height and run
       alongside on the same curve. A change that arrives mid-animation starts
       from wherever the bars are, without snapping to the end first. */
    function change(patch, remember) {
        var next = clean(Object.assign({}, state, patch));
        var same = Object.keys(next).every(function (k) { return next[k] === state[k]; });
        if (same) return;

        var bars = hosts();
        var animate = bars.length > 0 && !reducedMotion() && !document.hidden;

        function commit() {
            state = next;
            if (remember) save();
            paintClasses();
            Object.keys(BARS).forEach(paintStud);
            syncSheet();
        }

        if (!animate) {
            if (animating) finishAnimation();
            commit();
            emit("toggle");
            return;
        }

        var from = bars.map(measure);
        /* While the end state is laid out and measured the document may be
           shorter than now; holding its height stops a scrolled page (phones)
           from snapping before anything has moved. */
        var heldMin = ROOT.style.minHeight;
        ROOT.style.minHeight = ROOT.scrollHeight + "px";
        if (animating) {
            clearTimeout(settleTimer);                     /* replaced, not finished */
            unpin(bars);
        }

        var prev = state;
        commit();
        animating = true;
        ROOT.classList.add("mv-tuck-animating");
        /* Lay the end state out with the bars' content transitions paused (the
           page's buttons fold, for one, and can change how many rows they
           take), so the map is fitted to, and the bars run to, the real end
           heights rather than ones taken mid-fold. */
        ROOT.classList.add("mv-tuck-measuring");
        var told = emit("toggle");                          /* map: final height */
        var to = bars.map(measure);

        /* Between two states that both fit the window, the half-grown content
           must not flash a scrollbar (it would shift everything sideways).
           Whoever sizes the page knows its final height; the document's current
           height still includes content that is only now starting to move. */
        var endFits = typeof told.fits === "boolean" ? told.fits
            : document.body.offsetHeight <= window.innerHeight;
        if (endFits && overflowBefore === null) {
            overflowBefore = ROOT.style.overflowY;
            ROOT.style.overflowY = "hidden";
        } else if (!endFits && overflowBefore !== null) {
            ROOT.style.overflowY = overflowBefore;
            overflowBefore = null;
        }

        /* Back to the start for one layout, so those content transitions run
           from where they were rather than starting at the end. */
        paintClassesFor(prev);
        bars.forEach(function (el, i) {
            el.style.height = from[i].h + "px";
            el.style.paddingTop = from[i].pt;
            el.style.paddingBottom = from[i].pb;
        });
        ROOT.style.minHeight = heldMin;
        void ROOT.offsetHeight;                             /* commit the start */
        ROOT.classList.remove("mv-tuck-measuring");
        paintClasses();
        var curve = DURATION + "ms var(--mv-tuck-ease)";
        bars.forEach(function (el, i) {
            el.style.transition = "height " + curve + ", padding-top " + curve + ", padding-bottom " + curve;
            el.style.height = to[i].h + "px";
            el.style.paddingTop = to[i].pt;
            el.style.paddingBottom = to[i].pb;
        });
        settleTimer = setTimeout(finishAnimation, DURATION + 40);
    }

    /* A toggle moves the stud, so the second click of a double click lands on
       whatever slid under the pointer (the map would zoom). Drop it. */
    var swallowUntil = 0;
    function swallow(ev) {
        if (ev.detail > 1 && Date.now() < swallowUntil) {
            ev.preventDefault();
            ev.stopPropagation();
        }
    }
    ["mousedown", "mouseup", "click", "dblclick"].forEach(function (type) {
        window.addEventListener(type, swallow, true);
    });

    function toggle(bar) {
        var patch = {};
        patch[bar] = state[bar] === "expanded" ? state[bar + "Mode"] : "expanded";
        change(patch, true);
    }

    function makeStud(bar) {
        var cfg = BARS[bar];
        var host = document.getElementById(cfg.host);
        if (!host) return null;

        var button = document.createElement("button");
        button.type = "button";
        button.className = "mv-tuck mv-tuck-" + bar + "-stud";
        button.setAttribute("aria-controls", cfg.host);

        var NS = "http://www.w3.org/2000/svg";
        var svg = document.createElementNS(NS, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        svg.appendChild(document.createElementNS(NS, "path"));
        button.appendChild(svg);

        button.addEventListener("click", function () {
            swallowUntil = Date.now() + 700;
            toggle(bar);
        });

        if (cfg.at === "start") host.insertBefore(button, host.firstChild);
        else host.appendChild(button);
        return button;
    }

    /* ---- the Toggles sheet --------------------------------------------------- */

    var PRESETS = {
        "default": { top: "expanded", bottom: "expanded", hideFilters: false },
        partial: { top: "partial", bottom: "partial", topMode: "partial", bottomMode: "partial" },
        complete: { top: "complete", bottom: "complete", topMode: "complete", bottomMode: "complete" }
    };
    function currentPreset() {
        if (state.top === "expanded" && state.bottom === "expanded" && !state.hideFilters) return "default";
        if (state.top === "partial" && state.bottom === "partial") return "partial";
        if (state.top === "complete" && state.bottom === "complete") return "complete";
        return "";
    }

    function row(value, nameKey, subKey) {
        return '<label class="mv-sheet-row">' +
            '<input type="radio" name="mv-tg-view" value="' + value + '">' +
            '<span class="mv-sheet-text"><span class="mv-sheet-name" data-tg-text="' + nameKey + '"></span>' +
            '<span class="mv-sheet-sub" data-tg-text="' + subKey + '"></span></span>' + CHECK + "</label>";
    }
    function seg(bar, labelKey) {
        var name = "mv-tg-" + bar + "-mode";
        return '<div class="mv-sheet-row" role="radiogroup" aria-labelledby="' + name + '-label">' +
            '<span class="mv-sheet-name" id="' + name + '-label" data-tg-text="' + labelKey + '"></span>' +
            '<span class="mv-sheet-seg">' +
              '<label><input type="radio" name="' + name + '" value="partial"><span data-tg-text="tg_level_partial"></span></label>' +
              '<label><input type="radio" name="' + name + '" value="complete"><span data-tg-text="tg_level_complete"></span></label>' +
            "</span></div>";
    }

    function buildSheet() {
        if (sheet) return sheet;
        sheet = document.createElement("dialog");
        sheet.id = "mv-tg-dialog";
        sheet.className = "mv-sheet mv-tg";
        sheet.setAttribute("aria-labelledby", "mv-tg-title");
        sheet.innerHTML =
            '<div class="mv-sheet-head"><h2 id="mv-tg-title" data-tg-text="tg_title"></h2>' +
              '<button type="button" class="mv-sheet-close" data-tg-label="sheet_close">' + CLOSE + "</button></div>" +
            '<h3 class="mv-sheet-section" id="mv-tg-view-label" data-tg-text="tg_view"></h3>' +
            '<div class="mv-sheet-card" role="radiogroup" aria-labelledby="mv-tg-view-label">' +
              row("default", "tg_default", "tg_default_sub") +
              row("partial", "tg_partial", "tg_partial_sub") +
              row("complete", "tg_complete", "tg_complete_sub") +
            "</div>" +
            '<h3 class="mv-sheet-section" data-tg-text="tg_behavior"></h3>' +
            '<div class="mv-sheet-card">' + seg("top", "tg_header") + seg("bottom", "tg_footer") + "</div>" +
            '<h3 class="mv-sheet-section" data-tg-text="tg_filters"></h3>' +
            '<div class="mv-sheet-card">' +
              '<label class="mv-sheet-row" for="mv-tg-hide-filters">' +
                '<span class="mv-sheet-text"><span class="mv-sheet-name" data-tg-text="tg_hide_filters"></span>' +
                '<span class="mv-sheet-sub" data-tg-text="tg_hide_filters_sub"></span></span>' +
                '<span class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="mv-tg-hide-filters"></span>' +
              "</label>" +
            "</div>" +
            '<p class="mv-sheet-note" data-tg-text="sheet_local_note"></p>';
        document.body.appendChild(sheet);

        sheet.querySelector(".mv-sheet-close").addEventListener("click", function () { sheet.close(); });
        /* A click on the backdrop lands on the dialog itself, outside its box. */
        sheet.addEventListener("click", function (ev) {
            if (ev.target !== sheet) return;
            var r = sheet.getBoundingClientRect();
            if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) sheet.close();
        });
        sheet.addEventListener("close", function () {
            var opener = sheet.__opener;
            if (opener && document.contains(opener)) opener.focus();
        });

        [].forEach.call(sheet.querySelectorAll('input[name="mv-tg-view"]'), function (r) {
            r.addEventListener("change", function () { if (r.checked) change(PRESETS[r.value], true); });
        });
        ["top", "bottom"].forEach(function (bar) {
            [].forEach.call(sheet.querySelectorAll('input[name="mv-tg-' + bar + '-mode"]'), function (r) {
                r.addEventListener("change", function () {
                    if (!r.checked) return;
                    var patch = {};
                    patch[bar + "Mode"] = r.value;
                    /* a tucked bar switches to the new form right away, so the choice shows */
                    if (state[bar] !== "expanded") patch[bar] = r.value;
                    change(patch, true);
                });
            });
        });
        sheet.querySelector("#mv-tg-hide-filters").addEventListener("change", function (ev) {
            change({ hideFilters: ev.target.checked }, true);
        });

        paintSheetStrings();
        return sheet;
    }

    function paintSheetStrings() {
        if (!sheet) return;
        [].forEach.call(sheet.querySelectorAll("[data-tg-text]"), function (el) {
            el.textContent = text(el.getAttribute("data-tg-text"));
        });
        [].forEach.call(sheet.querySelectorAll("[data-tg-label]"), function (el) {
            el.setAttribute("aria-label", text(el.getAttribute("data-tg-label")));
        });
    }

    function syncSheet() {
        if (!sheet) return;
        var preset = currentPreset();
        [].forEach.call(sheet.querySelectorAll('input[name="mv-tg-view"]'), function (r) { r.checked = r.value === preset; });
        ["top", "bottom"].forEach(function (bar) {
            [].forEach.call(sheet.querySelectorAll('input[name="mv-tg-' + bar + '-mode"]'), function (r) {
                r.checked = r.value === state[bar + "Mode"];
            });
        });
        sheet.querySelector("#mv-tg-hide-filters").checked = state.hideFilters;
    }

    function openSheet(opener) {
        buildSheet();
        syncSheet();
        sheet.__opener = opener || null;
        if (!sheet.open) {
            if (typeof sheet.showModal === "function") sheet.showModal();
            else sheet.setAttribute("open", "");
        }
    }

    function wireOpeners() {
        [].forEach.call(document.querySelectorAll("[data-tuck-settings-open]"), function (el) {
            if (el.__mvTgWired) return;
            el.__mvTgWired = true;
            el.setAttribute("aria-haspopup", "dialog");
            el.addEventListener("click", function () { openSheet(el); });
        });
    }

    /* ---- start -------------------------------------------------------------- */

    function init() {
        Object.keys(BARS).forEach(function (bar) {
            studs[bar] = makeStud(bar);
            paintStud(bar);
        });
        wireOpeners();

        /* Strings arrive with the page's language dictionary. */
        if (window._langPromise && typeof window._langPromise.then === "function") {
            window._langPromise.then(function (dict) {
                strings = dict || FALLBACK;
                Object.keys(BARS).forEach(paintStud);
                paintSheetStrings();
            }).catch(function () { /* keep the English fallbacks */ });
        }

        /* A bar's height also changes without a click: the header text arrives
           after /api/config, filters are added after the node list loads, a
           narrow window wraps the menu. Tell anything sized to the leftover space. */
        if (typeof window.ResizeObserver === "function") {
            var ro = new window.ResizeObserver(function () { notify("resize"); });
            hosts().forEach(function (host) { ro.observe(host); });
        }

        /* Same choice in another tab of this browser. */
        window.addEventListener("storage", function (ev) {
            if (ev.key !== KEY) return;
            change(load(), false);
        });

        notify("init");
    }

    /* Deferred script: runs after parsing and before the page is revealed, so
       the remembered view is in place before the first visible paint. */
    paintClasses();

    window.meshviewTuck = {
        get: function () { return JSON.parse(JSON.stringify(state)); },
        isTucked: function (bar) { return state[bar] !== "expanded"; },
        set: function (patch) { change(patch || {}, true); },
        toggle: toggle,
        preset: function (name) { if (PRESETS[name]) change(PRESETS[name], true); },
        openSettings: function () { openSheet(null); }
    };

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})();
