/* Meshview colour filters ("Visual Accessibility").

   A page opts in with `set color_filters = true` in its template; base.html
   then loads sheet.css, colorfilter.css and this file. Any element with a
   data-colorfilter-open attribute opens the dialog (map.html puts it on an eye
   button). On wide screens the dialog lays the preview beside the controls; on
   narrow ones it stacks them, as a phone settings screen does.

   The dialog follows the phone-OS "Color Filters" screen people already know:
   a preview with three slides, an on/off switch, five filters and sliders:

     Grayscale
     Red/Green Filter   (protanopia)    } corrective filters (daltonisation):
     Green/Red Filter   (deuteranopia)  } colour differences a viewer cannot see
     Blue/Yellow Filter (tritanopia)    } are moved into ones they can
     Color Tint         + Hue           a coloured overlay, for light sensitivity
     Intensity                          for every filter except Grayscale

   The filter is one SVG feColorMatrix applied to the whole page (<html>), so
   map tiles, node colours, charts and text are all filtered alike. It works in
   linear light (the SVG default), where the simulation matrices are defined.
   Everything happens in the browser; the choice is kept in localStorage and
   never sent anywhere. */
(function () {
    "use strict";

    if (window.meshviewColorFilter) return;

    var ROOT = document.documentElement;
    var KEY = "meshview.colorFilter";
    var FILTER_ID = "mv-cf-matrix";
    var DIALOG_ID = "mv-cf-dialog";
    var MODES = ["grayscale", "protanopia", "deuteranopia", "tritanopia", "tint"];
    var DEFAULTS = { on: false, mode: "grayscale", intensity: 50, hue: 30, glass: false, glassLevel: 50, glassTheme: "dark" };

    var FALLBACK = {
        cf_title: "Visual Accessibility",
        cf_color_filters: "Color Filters",
        cf_grayscale: "Grayscale",
        cf_protanopia_name: "Red/Green Filter",
        cf_protanopia: "Protanopia",
        cf_deuteranopia_name: "Green/Red Filter",
        cf_deuteranopia: "Deuteranopia",
        cf_tritanopia_name: "Blue/Yellow Filter",
        cf_tritanopia: "Tritanopia",
        cf_tint: "Color Tint",
        cf_intensity: "Intensity",
        cf_hue: "Hue",
        cf_transparent: "Transparent",
        cf_transparency: "Transparency",
        cf_glass: "Glass",
        cf_glass_dark: "Dark",
        cf_glass_light: "Light",
        sheet_close: "Close",
        cf_preview: "Preview",
        cf_preview_pencils: "Color pencils",
        cf_preview_map: "Map colors",
        cf_preview_chart: "Color chart",
        sheet_local_note: "Saved in this browser only."
    };

    /* ---- colour science -------------------------------------------------- */

    /* Dichromat simulation, full severity, linear RGB: Machado, Oliveira and
       Fernandes (2009), "A Physiologically-based Model for Simulation of Color
       Vision Deficiency". */
    var SIM = {
        protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
        deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
        tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]]
    };
    /* Daltonisation (Fidaner, Lin and Ozguven): the part of the image a
       dichromat loses (original minus simulation) is shifted into channels they
       still see. Red/green losses go to green and blue; blue/yellow losses go
       to red and green. */
    var SHIFT = {
        protanopia: [[0, 0, 0], [0.7, 1, 0], [0.7, 0, 1]],
        deuteranopia: [[0, 0, 0], [0.7, 1, 0], [0.7, 0, 1]],
        tritanopia: [[1, 0, 0.7], [0, 1, 0.7], [0, 0, 0]]
    };
    var LUMA = [0.2126, 0.7152, 0.0722];          /* Rec. 709, linear light */
    var I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

    function mul(a, b) {
        var out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (var r = 0; r < 3; r++)
            for (var c = 0; c < 3; c++)
                out[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
        return out;
    }
    function lerp(a, b, t) {
        return a.map(function (row, r) { return row.map(function (v, c) { return v + (b[r][c] - v) * t; }); });
    }
    function srgbToLinear(v) {
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    function hueToLinearRgb(h) {
        /* fully saturated colour of hue h (HSL lightness 50%), in linear light */
        var k = function (n) { return (n + h / 30) % 12; };
        var f = function (n) { return 0.5 - 0.5 * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)); };
        return [srgbToLinear(f(0)), srgbToLinear(f(8)), srgbToLinear(f(4))];
    }

    function matrixFor(s) {
        var t = Math.max(0, Math.min(100, s.intensity)) / 100;
        if (s.mode === "grayscale") {
            return [LUMA.slice(), LUMA.slice(), LUMA.slice()];
        }
        if (s.mode === "tint") {
            var c = hueToLinearRgb(((s.hue % 360) + 360) % 360);
            return [[1 - t + t * c[0], 0, 0], [0, 1 - t + t * c[1], 0], [0, 0, 1 - t + t * c[2]]];
        }
        var sim = SIM[s.mode];
        var err = I3.map(function (row, r) { return row.map(function (v, c) { return v - sim[r][c]; }); });
        var corrected = mul(SHIFT[s.mode], err).map(function (row, r) {
            return row.map(function (v, c) { return I3[r][c] + v; });
        });
        return lerp(I3, corrected, t);
    }

    function matrixValues(m) {
        var f = function (v) { return (Math.round(v * 1e6) / 1e6).toString(); };
        return [
            f(m[0][0]), f(m[0][1]), f(m[0][2]), "0", "0",
            f(m[1][0]), f(m[1][1]), f(m[1][2]), "0", "0",
            f(m[2][0]), f(m[2][1]), f(m[2][2]), "0", "0",
            "0", "0", "0", "1", "0"
        ].join(" ");
    }

    /* ---- state ------------------------------------------------------------- */

    function load() {
        var s = {};
        try { s = JSON.parse(window.localStorage.getItem(KEY) || "{}") || {}; }
        catch (_e) { s = {}; }
        var out = {
            on: s.on === true,
            mode: MODES.indexOf(s.mode) >= 0 ? s.mode : DEFAULTS.mode,
            intensity: isFinite(s.intensity) ? Math.max(0, Math.min(100, +s.intensity)) : DEFAULTS.intensity,
            hue: isFinite(s.hue) ? ((+s.hue % 360) + 360) % 360 : DEFAULTS.hue,
            glass: s.glass === true,
            glassLevel: isFinite(s.glassLevel) ? Math.max(0, Math.min(100, +s.glassLevel)) : DEFAULTS.glassLevel,
            glassTheme: s.glassTheme === "light" ? "light" : "dark"
        };
        return out;
    }
    function save(s) {
        try { window.localStorage.setItem(KEY, JSON.stringify(s)); }
        catch (_e) { /* not remembered */ }
    }

    var state = load();
    var strings = FALLBACK;
    var dialog = null;
    var feMatrix = null;

    function text(key) { return (strings && strings[key]) || FALLBACK[key]; }

    /* ---- applying the filter --------------------------------------------- */

    function ensureFilterNode() {
        if (feMatrix) return;
        var NS = "http://www.w3.org/2000/svg";
        var svg = document.createElementNS(NS, "svg");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        svg.setAttribute("class", "mv-cf-defs");
        var filter = document.createElementNS(NS, "filter");
        filter.setAttribute("id", FILTER_ID);
        filter.setAttribute("color-interpolation-filters", "linearRGB");
        feMatrix = document.createElementNS(NS, "feColorMatrix");
        feMatrix.setAttribute("type", "matrix");
        filter.appendChild(feMatrix);
        svg.appendChild(filter);
        document.body.appendChild(svg);
    }

    function isIdentity(m) {
        for (var r = 0; r < 3; r++)
            for (var c = 0; c < 3; c++)
                if (Math.abs(m[r][c] - (r === c ? 1 : 0)) > 1e-6) return false;
        return true;
    }

    function apply() {
        var active = false;
        if (state.on) {
            var m = matrixFor(state);
            /* A matrix that changes nothing (Intensity 0) is not applied at all:
               any CSS filter costs the page its subpixel text rendering. */
            active = !isIdentity(m);
            if (active) {
                ensureFilterNode();
                feMatrix.setAttribute("values", matrixValues(m));
            }
        }
        /* The page is filtered through <html>; an open sheet lives in the top
           layer, painted outside <html>, so colorfilter.css filters it too. */
        ROOT.classList.toggle("mv-cf-on", active);
        applyGlass();
    }

    /* Transparent bars. The slider is how see-through the bar is at the edge
       facing the map; the far edge is 20 points less. The bars' backgrounds are
       gradients between those two (colorfilter.css); the page is told so the
       map can run under them. */
    function applyGlass() {
        var was = ROOT.classList.contains("mv-glass-on");
        if (state.glass) {
            var near = Math.max(0, Math.min(100, state.glassLevel));
            var far = Math.max(0, near - 20);
            ROOT.style.setProperty("--mv-glass-near", (1 - near / 100).toFixed(3));
            ROOT.style.setProperty("--mv-glass-far", (1 - far / 100).toFixed(3));
        }
        ROOT.classList.toggle("mv-glass-on", state.glass);
        ROOT.classList.toggle("mv-glass-light", state.glass && state.glassTheme === "light");
        if (was !== state.glass || state.glass) {
            document.dispatchEvent(new CustomEvent("meshview:glass", { detail: { on: state.glass, level: state.glassLevel } }));
        }
    }

    function update(patch) {
        Object.keys(patch).forEach(function (k) { state[k] = patch[k]; });
        save(state);
        apply();
        syncDialog();
    }

    /* ---- the dialog ------------------------------------------------------- */

    var PENCILS = ["#e23b33", "#f07a32", "#fbe34a", "#62e34a", "#2f8f2b", "#2f7f7a", "#7cc6f2",
                   "#1631e8", "#6a24e8", "#b46ef0", "#e23be8", "#6e1a78", "#8e1840", "#7a4a1c"];

    function pencilsSvg() {
        var parts = [];
        PENCILS.forEach(function (col, i) {
            var x = i * 100;
            parts.push(
                '<rect x="' + (x + 2) + '" y="150" width="96" height="460" fill="' + col + '"/>' +
                '<rect x="' + (x + 14) + '" y="150" width="14" height="460" fill="#fff" opacity=".18"/>' +
                '<rect x="' + (x + 72) + '" y="150" width="20" height="460" fill="#000" opacity=".16"/>' +
                '<polygon points="' + (x + 2) + ',150 ' + (x + 98) + ',150 ' + (x + 66) + ',56 ' + (x + 34) + ',56" fill="#e9cfa6"/>' +
                '<polygon points="' + (x + 34) + ',56 ' + (x + 66) + ',56 ' + (x + 50) + ',14" fill="' + col + '"/>'
            );
        });
        return '<svg viewBox="0 0 1400 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">' +
            '<rect width="1400" height="600" fill="#1c1c1e"/>' + parts.join("") + "</svg>";
    }

    function mapColorsHtml() {
        /* The page's own channel colours (map.html colours its filter labels
           with the same hash it uses for the node markers). */
        var labels = [].slice.call(document.querySelectorAll("#filter-container label"));
        var items = labels.map(function (l) {
            return { name: l.textContent.trim(), color: window.getComputedStyle(l).color };
        }).filter(function (x) { return x.name; });
        if (!items.length) {
            items = PENCILS.slice(0, 8).map(function (c, i) { return { name: "", color: c, i: i }; });
        }
        var out = '<ul class="mv-cf-mapcolors">';
        items.forEach(function (it) {
            out += '<li><span class="mv-cf-dot" style="background:' + it.color + '"></span>' +
                   '<span class="mv-cf-chan"></span></li>';
        });
        out += '<li><span class="mv-cf-line" style="background:orange"></span><span class="mv-cf-chan" data-cf-legend="traceroute"></span></li>';
        out += '<li><span class="mv-cf-line" style="background:gray"></span><span class="mv-cf-chan" data-cf-legend="neighbor"></span></li>';
        out += "</ul>";
        var wrap = document.createElement("div");
        wrap.innerHTML = out;
        /* names go in as text, never as HTML: channel names come from the mesh */
        var spans = wrap.querySelectorAll(".mv-cf-chan");
        items.forEach(function (it, i) { spans[i].textContent = it.name; });
        var legendT = document.querySelector('[data-translate-lang="legend_traceroute"]');
        var legendN = document.querySelector('[data-translate-lang="legend_neighbor"]');
        spans[items.length].textContent = legendT ? legendT.textContent.trim() : "Traceroute";
        spans[items.length + 1].textContent = legendN ? legendN.textContent.trim() : "Neighbor";
        return wrap.innerHTML;
    }

    function chartHtml() {
        var sw = ["#ff0000", "#ff8000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#8000ff", "#ff00ff"];
        var out = '<div class="mv-cf-chart"><div class="mv-cf-hues"></div><div class="mv-cf-swatches">';
        sw.forEach(function (c) { out += '<span style="background:' + c + '"></span>'; });
        out += '</div><div class="mv-cf-grays"></div></div>';
        return out;
    }

    var CHECK = '<svg class="mv-sheet-check" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.5 12.5l5 5L19.5 6.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    function modeRow(mode, nameKey, subKey) {
        return '<label class="mv-sheet-row">' +
            '<input type="radio" name="mv-cf-mode" value="' + mode + '">' +
            '<span class="mv-sheet-text"><span class="mv-sheet-name" data-cf-text="' + nameKey + '"></span>' +
            (subKey ? '<span class="mv-sheet-sub" data-cf-text="' + subKey + '"></span>' : "") +
            "</span>" + CHECK + "</label>";
    }

    function buildDialog() {
        if (dialog) return dialog;
        dialog = document.createElement("dialog");
        dialog.id = DIALOG_ID;
        dialog.className = "mv-sheet mv-cf";
        dialog.setAttribute("aria-labelledby", "mv-cf-title");
        dialog.innerHTML =
            '<div class="mv-sheet-head">' +
              '<h2 id="mv-cf-title" data-cf-text="cf_title"></h2>' +
              '<button type="button" class="mv-sheet-close" data-cf-label="sheet_close">' +
                '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>' +
              "</button>" +
            "</div>" +
            '<div class="mv-cf-body">' +
              '<section class="mv-cf-preview" aria-roledescription="carousel" aria-labelledby="mv-cf-preview-label">' +
                '<div class="mv-cf-viewport"><div class="mv-cf-track">' +
                  '<div class="mv-cf-slide" data-slide="0" role="group" aria-roledescription="slide" data-cf-label="cf_preview_pencils">' + pencilsSvg() + "</div>" +
                  '<div class="mv-cf-slide" data-slide="1" role="group" aria-roledescription="slide" data-cf-label="cf_preview_map"></div>' +
                  '<div class="mv-cf-slide" data-slide="2" role="group" aria-roledescription="slide" data-cf-label="cf_preview_chart">' + chartHtml() + "</div>" +
                "</div></div>" +
                '<div class="mv-cf-dotsrow">' +
                  '<span class="mv-cf-preview-label" id="mv-cf-preview-label" data-cf-text="cf_preview"></span>' +
                  '<div class="mv-cf-dots">' +
                    '<button type="button" data-goto="0" data-cf-label="cf_preview_pencils"></button>' +
                    '<button type="button" data-goto="1" data-cf-label="cf_preview_map"></button>' +
                    '<button type="button" data-goto="2" data-cf-label="cf_preview_chart"></button>' +
                  "</div>" +
                "</div>" +
              "</section>" +
              '<div class="mv-cf-controls">' +
                '<div class="mv-sheet-card">' +
                  '<label class="mv-sheet-row" for="mv-cf-on">' +
                    '<span class="mv-sheet-name" data-cf-text="cf_color_filters"></span>' +
                    '<span class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="mv-cf-on"></span>' +
                  "</label>" +
                "</div>" +
                '<div class="mv-cf-options mv-sheet-block">' +
                  '<fieldset class="mv-sheet-card"><legend class="visually-hidden" data-cf-text="cf_color_filters"></legend>' +
                    modeRow("grayscale", "cf_grayscale") +
                    modeRow("protanopia", "cf_protanopia_name", "cf_protanopia") +
                    modeRow("deuteranopia", "cf_deuteranopia_name", "cf_deuteranopia") +
                    modeRow("tritanopia", "cf_tritanopia_name", "cf_tritanopia") +
                    modeRow("tint", "cf_tint") +
                  "</fieldset>" +
                  '<div class="mv-sheet-slider" data-for="intensity">' +
                    '<label for="mv-cf-intensity" data-cf-text="cf_intensity"></label>' +
                    '<input type="range" id="mv-cf-intensity" min="0" max="100" step="1">' +
                  "</div>" +
                  '<div class="mv-sheet-slider" data-for="hue">' +
                    '<label for="mv-cf-hue" data-cf-text="cf_hue"></label>' +
                    '<input type="range" id="mv-cf-hue" class="mv-cf-hue" min="0" max="359" step="1">' +
                  "</div>" +
                "</div>" +
                '<div class="mv-sheet-card">' +
                  '<label class="mv-sheet-row" for="mv-cf-glass">' +
                    '<span class="mv-sheet-name" data-cf-text="cf_transparent"></span>' +
                    '<span class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="mv-cf-glass"></span>' +
                  "</label>" +
                "</div>" +
                '<div class="mv-cf-glass-options mv-sheet-block">' +
                  '<div class="mv-sheet-card">' +
                    '<div class="mv-sheet-row" role="radiogroup" aria-labelledby="mv-cf-glass-theme-label">' +
                      '<span class="mv-sheet-name" id="mv-cf-glass-theme-label" data-cf-text="cf_glass"></span>' +
                      '<span class="mv-sheet-seg">' +
                        '<label><input type="radio" name="mv-cf-glass-theme" value="dark"><span data-cf-text="cf_glass_dark"></span></label>' +
                        '<label><input type="radio" name="mv-cf-glass-theme" value="light"><span data-cf-text="cf_glass_light"></span></label>' +
                      "</span>" +
                    "</div>" +
                  "</div>" +
                  '<div class="mv-sheet-slider" data-for="glass">' +
                    '<label for="mv-cf-glass-level" data-cf-text="cf_transparency"></label>' +
                    '<input type="range" id="mv-cf-glass-level" min="0" max="100" step="1">' +
                  "</div>" +
                "</div>" +
                '<p class="mv-sheet-note" data-cf-text="sheet_local_note"></p>' +
              "</div>" +
            "</div>";

        document.body.appendChild(dialog);

        dialog.querySelector(".mv-sheet-close").addEventListener("click", function () { dialog.close(); });
        /* Back to the button that opened it (browsers differ on doing this). */
        dialog.addEventListener("close", function () {
            var opener = dialog.__opener;
            if (opener && document.contains(opener)) opener.focus();
        });
        /* A click on the backdrop closes, like a sheet. The backdrop has no
           element of its own: such clicks land on the dialog, outside its box. */
        dialog.addEventListener("click", function (ev) {
            if (ev.target !== dialog) return;
            var r = dialog.getBoundingClientRect();
            if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) dialog.close();
        });

        dialog.querySelector("#mv-cf-on").addEventListener("change", function (ev) {
            update({ on: ev.target.checked });
        });
        [].forEach.call(dialog.querySelectorAll('input[name="mv-cf-mode"]'), function (r) {
            r.addEventListener("change", function () { if (r.checked) update({ mode: r.value }); });
        });
        dialog.querySelector("#mv-cf-intensity").addEventListener("input", function (ev) {
            update({ intensity: +ev.target.value });
        });
        dialog.querySelector("#mv-cf-hue").addEventListener("input", function (ev) {
            update({ hue: +ev.target.value });
        });
        dialog.querySelector("#mv-cf-glass").addEventListener("change", function (ev) {
            update({ glass: ev.target.checked });
        });
        dialog.querySelector("#mv-cf-glass-level").addEventListener("input", function (ev) {
            update({ glassLevel: +ev.target.value });
        });
        [].forEach.call(dialog.querySelectorAll('input[name="mv-cf-glass-theme"]'), function (r) {
            r.addEventListener("change", function () { if (r.checked) update({ glassTheme: r.value }); });
        });

        [].forEach.call(dialog.querySelectorAll(".mv-cf-dots button"), function (b) {
            b.addEventListener("click", function () { showSlide(+b.getAttribute("data-goto")); });
        });
        var dots = dialog.querySelector(".mv-cf-dots");
        dots.addEventListener("keydown", function (ev) {
            if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
            ev.preventDefault();
            var next = (currentSlide + (ev.key === "ArrowRight" ? 1 : 2)) % 3;
            showSlide(next);
            dots.querySelectorAll("button")[next].focus();
        });
        /* swipe on touch screens */
        var startX = null;
        var vp = dialog.querySelector(".mv-cf-viewport");
        vp.addEventListener("pointerdown", function (ev) { startX = ev.clientX; });
        vp.addEventListener("pointerup", function (ev) {
            if (startX === null) return;
            var dx = ev.clientX - startX;
            startX = null;
            if (Math.abs(dx) > 40) showSlide((currentSlide + (dx < 0 ? 1 : 2)) % 3);
        });

        paintStrings();
        showSlide(0);
        return dialog;
    }

    var currentSlide = 0;
    function showSlide(n) {
        currentSlide = n;
        if (!dialog) return;
        dialog.querySelector(".mv-cf-track").style.transform = "translateX(" + (-100 * n) + "%)";
        [].forEach.call(dialog.querySelectorAll(".mv-cf-slide"), function (s, i) {
            s.setAttribute("aria-hidden", i === n ? "false" : "true");
        });
        [].forEach.call(dialog.querySelectorAll(".mv-cf-dots button"), function (b, i) {
            if (i === n) b.setAttribute("aria-current", "true");
            else b.removeAttribute("aria-current");
        });
    }

    function paintStrings() {
        if (!dialog) return;
        [].forEach.call(dialog.querySelectorAll("[data-cf-text]"), function (el) {
            el.textContent = text(el.getAttribute("data-cf-text"));
        });
        [].forEach.call(dialog.querySelectorAll("[data-cf-label]"), function (el) {
            el.setAttribute("aria-label", text(el.getAttribute("data-cf-label")));
        });
    }

    function syncDialog() {
        if (!dialog) return;
        dialog.querySelector("#mv-cf-on").checked = state.on;
        dialog.querySelector(".mv-cf-options").hidden = !state.on;
        [].forEach.call(dialog.querySelectorAll('input[name="mv-cf-mode"]'), function (r) {
            r.checked = r.value === state.mode;
        });
        var intensity = dialog.querySelector("#mv-cf-intensity");
        var hue = dialog.querySelector("#mv-cf-hue");
        intensity.value = state.intensity;
        intensity.setAttribute("aria-valuetext", state.intensity + " %");
        hue.value = state.hue;
        hue.setAttribute("aria-valuetext", state.hue + "°");
        /* Grayscale has no strength; only Color Tint has a hue. */
        dialog.querySelector('.mv-sheet-slider[data-for="intensity"]').hidden = state.mode === "grayscale";
        dialog.querySelector('.mv-sheet-slider[data-for="hue"]').hidden = state.mode !== "tint";
        dialog.querySelector("#mv-cf-glass").checked = state.glass;
        var glass = dialog.querySelector("#mv-cf-glass-level");
        glass.value = state.glassLevel;
        glass.setAttribute("aria-valuetext", state.glassLevel + " %");
        dialog.querySelector(".mv-cf-glass-options").hidden = !state.glass;
        [].forEach.call(dialog.querySelectorAll('input[name="mv-cf-glass-theme"]'), function (r) {
            r.checked = r.value === state.glassTheme;
        });
    }

    function open(opener) {
        buildDialog();
        dialog.querySelector('.mv-cf-slide[data-slide="1"]').innerHTML = mapColorsHtml();
        syncDialog();
        showSlide(currentSlide);
        if (!dialog.open) {
            if (typeof dialog.showModal === "function") dialog.showModal();
            else dialog.setAttribute("open", "");
        }
        if (opener) dialog.__opener = opener;
    }

    function wireOpeners(root) {
        [].forEach.call((root || document).querySelectorAll("[data-colorfilter-open]"), function (el) {
            if (el.__mvCfWired) return;
            el.__mvCfWired = true;
            el.setAttribute("aria-haspopup", "dialog");
            el.addEventListener("click", function () { open(el); });
        });
    }

    function init() {
        apply();
        wireOpeners(document);
        if (window._langPromise && typeof window._langPromise.then === "function") {
            window._langPromise.then(function (dict) {
                strings = dict || FALLBACK;
                paintStrings();
            }).catch(function () { /* English fallbacks */ });
        }
        /* Same choice in another tab of this browser. */
        window.addEventListener("storage", function (ev) {
            if (ev.key !== KEY) return;
            state = load();
            apply();
            syncDialog();
        });
    }

    window.meshviewColorFilter = {
        open: function () { open(null); },
        get: function () { return JSON.parse(JSON.stringify(state)); },
        set: function (patch) { update(patch || {}); },
        matrix: function (s) { return matrixFor(s || state); }
    };

    if (state.glass) applyGlass();                        /* before the first paint */

    /* Deferred script: this runs after parsing and before the page is revealed,
       so a remembered filter is on before the first visible paint. */
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})();
