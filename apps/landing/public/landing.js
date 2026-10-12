// The interactive panels (the merchant offer simulator, the vault volume calculator) and the live
// figures in the band under the hero. The page is complete without this file; the HTML ships with
// the default values.
(function () {
  "use strict";

  // Share of a ticket price that funds the payout once the vault margin (1%), the merchant's
  // share (2% in this example) and the protocol share (0.2%) are taken out.
  var KEEP = 0.968;

  var OFFERS = {
    free: { p: 0.01 },
    half: { p: 0.02 },
    tenth: { p: 0.1 },
  };

  function setPressed(buttons, isOn) {
    buttons.forEach(function (b) {
      b.setAttribute("aria-pressed", isOn(b) ? "true" : "false");
    });
  }

  function quote(order, offer) {
    var p = OFFERS[offer].p;
    var ticket, prize;
    if (offer === "free") {
      ticket = (p * order) / (KEEP - p);
      prize = order + ticket;
    } else if (offer === "half") {
      ticket = (p * order) / 2 / KEEP;
      prize = order / 2;
    } else {
      ticket = (p * order * 0.1) / KEEP;
      prize = order * 0.1;
    }
    return { p: p, ticket: ticket, prize: prize };
  }

  function initSimulator(root) {
    var state = { order: 100, offer: "free" };
    var orderButtons = Array.prototype.slice.call(root.querySelectorAll("[data-order]"));
    var offerButtons = Array.prototype.slice.call(root.querySelectorAll("[data-offer]"));
    var ticketEl = root.querySelector("[data-ticket]");
    var prizeEl = root.querySelector("[data-prize]");

    function render() {
      var q = quote(state.order, state.offer);
      ticketEl.textContent = q.ticket.toFixed(2);
      prizeEl.textContent = q.prize.toFixed(2);
      setPressed(orderButtons, function (b) {
        return Number(b.getAttribute("data-order")) === state.order;
      });
      setPressed(offerButtons, function (b) {
        return b.getAttribute("data-offer") === state.offer;
      });
    }

    orderButtons.forEach(function (b) {
      b.addEventListener("click", function () {
        state.order = Number(b.getAttribute("data-order"));
        render();
      });
    });
    offerButtons.forEach(function (b) {
      b.addEventListener("click", function () {
        state.offer = b.getAttribute("data-offer");
        render();
      });
    });

    render();
  }

  function initCalculator(root) {
    var buttons = Array.prototype.slice.call(root.querySelectorAll("[data-volume]"));
    var aprEl = root.querySelector("[data-apr]");

    function select(volume) {
      // Monthly volume in millions on a 1M bank, times 12 months, at the 1% vault margin floor.
      aprEl.textContent = String(Math.round(volume * 12));
      setPressed(buttons, function (b) {
        return Number(b.getAttribute("data-volume")) === volume;
      });
    }

    buttons.forEach(function (b) {
      b.addEventListener("click", function () {
        select(Number(b.getAttribute("data-volume")));
      });
    });
  }

  // The band under the hero: the example offers, alternating with live figures from the keeper
  // (wins, what winners were paid, the biggest win). Without an answer, the offers alone, as shipped.
  var STATS_URL = "https://api.fade.finance/v1/stats";
  var STATS_EVERY_MS = 30000;

  function wholeUsdc(micro) {
    if (typeof micro !== "string" || !/^\d+$/.test(micro)) return null;
    var whole = micro.length > 6 ? micro.slice(0, -6) : "0";
    whole = whole.replace(/^0+(?=\d)/, "");
    if (whole === "0") return null;
    return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function liveFigures(stats) {
    var s = stats && stats.all;
    if (!s || typeof s !== "object") return [];
    var out = [];
    var wins = s.wins;
    if (typeof wins === "number" && Number.isSafeInteger(wins) && wins > 0)
      out.push(wins.toLocaleString("en-US") + (wins === 1 ? " win so far" : " wins so far"));
    var paid = wholeUsdc(s.paid);
    if (paid) out.push(paid + " USDC paid to winners");
    var biggest = wholeUsdc(s.biggestWin && s.biggestWin.payout);
    if (biggest) out.push("Biggest win " + biggest + " USDC");
    return out;
  }

  function initLiveBand(band) {
    var groups = Array.prototype.slice.call(band.querySelectorAll(".marquee-group"));
    if (groups.length === 0) return;
    var shipped = groups.map(function (g) {
      return g.innerHTML;
    });
    var label = band.getAttribute("aria-label");
    var offers = Array.prototype.slice
      .call(groups[0].querySelectorAll("li:not(.mark)"))
      .map(function (li) {
        return li.textContent;
      });
    var mark = groups[0].querySelector("li.mark");
    var shown = "";

    function item(text, live) {
      var li = document.createElement("li");
      li.textContent = text;
      if (live) li.className = "live";
      return li;
    }

    function render(figures) {
      var key = figures.join("|");
      if (key === shown) return;
      shown = key;
      if (figures.length === 0) {
        groups.forEach(function (g, i) {
          g.innerHTML = shipped[i];
        });
        band.setAttribute("aria-label", label);
        return;
      }
      // offer, figure, offer, figure...; once the figures run out, the remaining offers
      var items = [];
      offers.forEach(function (o, i) {
        items.push(item(o, false));
        if (i < figures.length) items.push(item(figures[i], true));
      });
      groups.forEach(function (g, gi) {
        g.textContent = "";
        items.forEach(function (li) {
          g.appendChild(li.cloneNode(true));
          if (mark) {
            var m = mark.cloneNode(true);
            if (gi > 0) m.removeAttribute("aria-hidden");
            g.appendChild(m);
          }
        });
      });
      band.setAttribute("aria-label", "Example offers and live figures");
    }

    function load() {
      if (document.hidden || !window.fetch) return;
      var ctrl = window.AbortController ? new AbortController() : null;
      var timer = ctrl
        ? setTimeout(function () {
            ctrl.abort();
          }, 8000)
        : null;
      fetch(STATS_URL, ctrl ? { signal: ctrl.signal } : {})
        .then(function (r) {
          if (!r.ok) throw new Error("stats " + r.status);
          return r.json();
        })
        .then(function (stats) {
          render(liveFigures(stats));
        })
        .catch(function () {
          // keep whatever the band shows: the offers, or the last figures read
        })
        .then(function () {
          if (timer) clearTimeout(timer);
        });
    }

    load();
    setInterval(load, STATS_EVERY_MS);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) load();
    });
  }

  var band = document.querySelector(".marquee");
  if (band) initLiveBand(band);
  var sim = document.querySelector("[data-sim]");
  if (sim) initSimulator(sim);
  var calc = document.querySelector("[data-calc]");
  if (calc) initCalculator(calc);
})();
