(function () {
  'use strict';

  var DATA = window.CURVE_DATA || { meta: {}, prior: [], series: [] };
  var CITIES = window.CITY_DATA || { fx: 0.085, level: 2, pairs: [] };
  var PRIORS = DATA.priors || { Economy: DATA.prior || [], Business: DATA.prior || [] };
  var ZMAPS = {};
  Object.keys(PRIORS).forEach(function (k) {
    ZMAPS[k] = {};
    PRIORS[k].forEach(function (p) { ZMAPS[k][p[0]] = p[1]; });
  });

  // 相对平台价高出 10% 以内，就算"到底了"。
  // 阈值设得太紧（比如 5%）会被 1-2 个百分点的噪声推后好几天。
  var KNEE_THRESHOLD = 1.10;

  var state = {
    series: null,
    china: {
      base: 1180,
      alpha: 1,
      depart: '',
      from: '北京',
      to: '上海',
      manualBase: false,
      obs: [],
      fitted: false,
      fittedAlpha: null,
      mape: null,
      fitN: 0
    }
  };

  // ------------------------------------------------------------ helpers
  function $(id) { return document.getElementById(id); }

  function fmtMoney(v, cur) {
    var n = Math.round(v);
    return (cur === 'INR' ? '₹' : '¥') + n.toLocaleString('zh-CN');
  }

  function pct(v) {
    var s = v >= 0 ? '+' : '';
    return s + Math.round(v * 100) + '%';
  }

  function parseDate(s) {
    var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }

  function fmtCN(d) {
    return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }

  function addDays(d, n) {
    var c = new Date(d.getTime());
    c.setDate(c.getDate() + n);
    return c;
  }

  function diffDays(a, b) {
    return Math.round((a.getTime() - b.getTime()) / 86400000);
  }

  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function zOf(d, cls) {
    var key = PRIORS[cls] ? cls : 'Economy';
    var arr = PRIORS[key] || [];
    var map = ZMAPS[key] || {};
    if (!arr.length) return 1;
    if (d > arr[arr.length - 1][0]) return 1;
    if (map[d] != null) return map[d];
    var best = 1, bestDiff = Infinity;
    for (var i = 0; i < arr.length; i++) {
      var diff = Math.abs(arr[i][0] - d);
      if (diff < bestDiff) { bestDiff = diff; best = arr[i][1]; }
    }
    return best;
  }

  /** 对序列做中位平滑，压掉单个日期的噪声。 */
  function smoothSeries(pairs, radius) {
    var r = radius || 2;
    return pairs.map(function (p, i) {
      var win = [];
      for (var j = Math.max(0, i - r); j <= Math.min(pairs.length - 1, i + r); j++) {
        win.push(pairs[j][1]);
      }
      return [p[0], median(win)];
    });
  }

  /**
   * 找出"平台期"的起点：从某天起，之后每一天的相对价都不超过平台价的 110%。
   */
  function findKnee(pairs, threshold) {
    var t = threshold || KNEE_THRESHOLD;
    // 先做 5 点中位平滑，再用「未来 7 天均值」判断。
    // 逐点判断太脆：某一天高 2 个百分点，就能把拐点推后十几天。
    pairs = smoothSeries(pairs, 2);
    for (var i = 0; i < pairs.length; i++) {
      var end = Math.min(pairs.length, i + 7);
      var sum = 0, n = 0;
      for (var j = i; j < end; j++) { sum += pairs[j][1]; n++; }
      if (n && sum / n <= t) {
        return pairs[i][0];
      }
    }
    return pairs.length ? pairs[pairs.length - 1][0] : null;
  }

  // ------------------------------------------------------------ selects

  function cityList() {
    var seen = {};
    DATA.series.forEach(function (s) { seen[s.from] = true; });
    return Object.keys(seen).sort();
  }

  function destList(from, cls) {
    var seen = {};
    DATA.series.forEach(function (s) {
      if (s.from === from && s.cls === cls) seen[s.to] = true;
    });
    return Object.keys(seen).sort();
  }

  function fillSelect(sel, values, keep) {
    sel.innerHTML = '';
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
    });
    if (keep && values.indexOf(keep) !== -1) sel.value = keep;
  }

  function refreshDest() {
    var cls = $('selCls').value;
    fillSelect($('selTo'), destList($('selFrom').value, cls), $('selTo').value);
  }

  // ------------------------------------------------------------ 中国城市对标

  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad;
    var dLon = (lon2 - lon1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function pairByCn(name) {
    for (var i = 0; i < CITIES.pairs.length; i++) {
      if (CITIES.pairs[i].cn === name) return CITIES.pairs[i];
    }
    return null;
  }

  function estimateRoute() {
    var from = $('cnFrom').value;
    var to = $('cnTo').value;
    if (!from || !to || from === to) return null;

    var pf = pairByCn(from);
    var pt = pairByCn(to);
    if (!pf || !pt) return null;

    var s = DATA.series.find(function (x) {
      return x.from === pf.in && x.to === pt.in && x.cls === 'Economy';
    });
    if (!s) return null;

    var dIn = haversine(pf.inLat, pf.inLon, pt.inLat, pt.inLon);
    var dCn = haversine(pf.cnLat, pf.cnLon, pt.cnLat, pt.cnLon);
    var beta = CITIES.beta != null ? CITIES.beta : 0.06;
    var ratio = dCn / dIn;
    var raw = CITIES.level * CITIES.fx * s.base * Math.pow(ratio, beta);

    return {
      from: from, to: to,
      inFrom: pf.in, inTo: pt.in,
      baseINR: s.base, dIn: dIn, dCn: dCn, raw: raw, beta: beta, ratio: ratio,
      value: Math.round(raw / 10) * 10
    };
  }

  function updateEstimateBox(est) {
    var box = $('estimateBox');

    if (!est) {
      box.innerHTML = '<div class="est-line est-empty">选两个不同的城市</div>';
      return;
    }

    var manual = state.china.manualBase;
    box.innerHTML =
      '<div class="est-title">' + (manual ? '已手动覆盖常态价' : '自动估算常态价') + '</div>' +
      '<div class="est-line">对标 <b>' + est.inFrom + ' → ' + est.inTo + '</b>' +
        '（' + fmtMoney(est.baseINR, 'INR') + ' / ' + Math.round(est.dIn) + ' km）</div>' +
      '<div class="est-line">' + est.from + ' → ' + est.to +
        ' · <b>' + Math.round(est.dCn) + ' km</b></div>' +
      '<div class="est-formula">' +
        CITIES.level.toFixed(1) + ' × ' + CITIES.fx + ' × ' + Math.round(est.baseINR) +
        ' × (' + Math.round(est.dCn) + ' ÷ ' + Math.round(est.dIn) + ')^' + est.beta +
        ' = <b>¥' + Math.round(est.raw) + '</b></div>' +
      (est.dCn < 300 ? '<div class="est-warn">短途航线受高铁冲击大，这个估算会明显偏高</div>' : '') +
      (manual ? '<button class="btn-link" type="button" id="btnRestoreBase">恢复估算值</button>' : '');

    var btn = $('btnRestoreBase');
    if (btn) {
      btn.addEventListener('click', function () {
        state.china.manualBase = false;
        var e = estimateRoute();
        if (e) $('inBase').value = e.value;
        updateEstimateBox(e);
        renderB();
      });
    }
  }

  function syncRoute() {
    var est = estimateRoute();
    state.china.manualBase = false;
    if (est) $('inBase').value = est.value;
    updateEstimateBox(est);
    renderB();
  }

  function renderCityTable() {
    var head = '<thead><tr class="group-row">' +
      '<th></th><th></th>' +
      '<th colspan="3">印度</th><th colspan="3">中国</th><th></th>' +
      '</tr><tr>' +
      '<th>印度城市</th><th>中国对标</th>' +
      '<th class="num">人口(万)</th><th class="num">人均GDP</th><th class="num">吞吐(万)</th>' +
      '<th class="num">人口(万)</th><th class="num">人均GDP</th><th class="num">吞吐(万)</th>' +
      '<th>对标理由</th></tr></thead>';

    var body = CITIES.pairs.map(function (p) {
      return '<tr>' +
        '<td>' + p.in + '</td>' +
        '<td><b>' + p.cn + '</b></td>' +
        '<td class="num">' + p.inPop.toLocaleString('zh-CN') + '</td>' +
        '<td class="num">$' + (p.inGdp / 1000).toFixed(1) + 'k</td>' +
        '<td class="num">' + p.inPax.toLocaleString('zh-CN') + '</td>' +
        '<td class="num">' + p.cnPop.toLocaleString('zh-CN') + '</td>' +
        '<td class="num">' + (p.cnGdp / 10000).toFixed(1) + '万</td>' +
        '<td class="num">' + p.cnPax.toLocaleString('zh-CN') + '</td>' +
        '<td class="why">' + p.why + '</td>' +
      '</tr>';
    }).join('');

    $('cityTable').innerHTML = head + '<tbody>' + body + '</tbody>';
  }

  // ------------------------------------------------------------ render A

  function currentSeries() {
    var f = $('selFrom').value, t = $('selTo').value, c = $('selCls').value;
    return DATA.series.find(function (s) {
      return s.from === f && s.to === t && s.cls === c;
    }) || null;
  }

  function renderA() {
    var s = currentSeries();
    state.series = s;

    if (!s) {
      $('verdictA').innerHTML = '<p class="eyebrow">暂无数据</p><p class="headline" style="font-size:18px">这条航线没有足够样本</p>';
      $('chartA').innerHTML = '';
      $('sampleCount').textContent = '—';
      return;
    }

    $('sampleCount').textContent = s.n.toLocaleString('zh-CN') + ' 条';

    // 相对平台价的序列
    var pairs = s.pts.map(function (p) { return [p[0], p[1] / s.base]; });
    var knee = findKnee(pairs);

    var at = function (d) {
      var best = null, bestDiff = Infinity;
      s.pts.forEach(function (p) {
        var diff = Math.abs(p[0] - d);
        if (diff < bestDiff) { bestDiff = diff; best = p[1]; }
      });
      return best;
    };
    var z7 = (at(7) || s.base) / s.base;
    var z1 = (at(1) || s.base) / s.base;
    var clsLabel = s.cls === 'Business' ? '商务舱' : '经济舱';

    // 商务舱这类几乎不随提前天数变化的曲线，不要硬给一个"最佳窗口"
    if (z7 < 1.10) {
      $('verdictA').innerHTML =
        '<p class="eyebrow">实测结论</p>' +
        '<p class="headline">' + clsLabel + '几乎不随提前天数变化</p>' +
        '<p class="sub">1–49 天内价格基本持平，只有最后一天略有上浮。这条航线提前买的意义不大。</p>' +
        '<div class="facts">' +
          '<span>常态价 <b>' + fmtMoney(s.base, 'INR') + '</b></span>' +
          '<span>最后 7 天 <b>' + pct(z7 - 1) + '</b></span>' +
          '<span>最后 1 天 <b>' + pct(z1 - 1) + '</b></span>' +
          '<span><b>' + s.n.toLocaleString('zh-CN') + '</b> 条报价</span>' +
        '</div>';

      drawChart($('chartA'), {
        points: s.pts.map(function (p) {
          return { d: p[0], y: p[1], lo: p[2], hi: p[3], n: p[4] };
        }),
        dMax: 49,
        knee: null,
        tone: 'real',
        currency: 'INR',
        height: 340
      });
      return;
    }

    $('verdictA').innerHTML =
      '<p class="eyebrow">实测结论</p>' +
      '<p class="headline">' + clsLabel + '：提前 <em>' + knee + ' 天以上</em> 买，价格基本到底</p>' +
      '<p class="sub">这条航线在 ' + knee + ' 天之前价格几乎没有变化，进入最后两周才开始明显抬头。</p>' +
      '<div class="facts">' +
        '<span>常态价 <b>' + fmtMoney(s.base, 'INR') + '</b></span>' +
        '<span>最后 7 天 <b>' + pct(z7 - 1) + '</b></span>' +
        '<span>最后 1 天 <b>' + pct(z1 - 1) + '</b></span>' +
        '<span><b>' + s.n.toLocaleString('zh-CN') + '</b> 条报价</span>' +
      '</div>';

    var pts = s.pts.map(function (p) {
      return { d: p[0], y: p[1], lo: p[2], hi: p[3], n: p[4] };
    });

    drawChart($('chartA'), {
      points: pts,
      dMax: 49,
      knee: knee,
      tone: 'real',
      currency: 'INR',
      height: 340
    });
  }

  // ------------------------------------------------------------ render B

  function projectedPoint(d, base, alpha) {
    return base * (1 + alpha * (zOf(d, 'Economy') - 1));
  }

  function renderB() {
    if ($('cnFrom').value === $('cnTo').value) {
      $('verdictB').innerHTML =
        '<p class="eyebrow">推算结论</p>' +
        '<p class="headline" style="font-size:19px">请选择两个不同的城市</p>';
      $('chartB').innerHTML = '';
      return;
    }

    var base = Math.max(1, Number($('inBase').value) || 0);
    var alpha = Number($('inAlpha').value);
    var departStr = $('inDepart').value;

    state.china.base = base;
    state.china.alpha = alpha;
    state.china.depart = departStr;
    state.china.from = $('cnFrom').value;
    state.china.to = $('cnTo').value;

    $('alphaVal').textContent = alpha.toFixed(2);

    var priorPairs = (PRIORS.Economy || []).map(function (p) { return [p[0], p[1]]; });
    var knee = findKnee(priorPairs);

    var d7 = projectedPoint(7, base, alpha);
    var d1 = projectedPoint(1, base, alpha);
    var plateau = base;

    var sub;
    if (departStr) {
      var dep = parseDate(departStr);
      if (dep) {
        var latest = addDays(dep, -knee);
        sub = '若 ' + fmtCN(dep) + ' 出发，建议在 <strong>' + fmtCN(latest) + '</strong> 之前完成下单。';
      }
    }
    if (!sub) {
      sub = '以常态价 ' + fmtMoney(plateau, 'CNY') + ' 计算，这个窗口内价格基本稳定。';
    }

    var sourceLine;
    if (state.china.fitted && Math.abs(alpha - state.china.fittedAlpha) < 0.001) {
      sourceLine = '<span>已用你的数据校准 <b>α = ' + alpha.toFixed(2) + '</b></span>' +
                   '<span>拟合误差 <b>' + (state.china.mape * 100).toFixed(1) + '%</b></span>';
    } else if (state.china.fitted) {
      sourceLine = '<span>手动调整 <b>α = ' + alpha.toFixed(2) + '</b></span>' +
                   '<span>原拟合值 ' + state.china.fittedAlpha.toFixed(2) + '</span>';
    } else {
      sourceLine = '<span>未校准 <b>α = ' + alpha.toFixed(2) + '</b></span>';
    }

    $('verdictB').innerHTML =
      '<p class="eyebrow">推算结论 · 非实测</p>' +
      '<p class="headline">提前 <em>' + knee + ' 天以上</em> 下单</p>' +
      '<p class="sub">' + sub + '</p>' +
      '<div class="facts">' +
        '<span>常态价 <b>' + fmtMoney(plateau, 'CNY') + '</b></span>' +
        '<span>最后 7 天 <b>' + fmtMoney(d7, 'CNY') + '</b>（' + pct(d7 / plateau - 1) + '）</span>' +
        '<span>最后 1 天 <b>' + fmtMoney(d1, 'CNY') + '</b></span>' +
        sourceLine +
      '</div>';

    // 1..90 天的推算曲线
    var pts = [];
    for (var d = 90; d >= 1; d--) {
      pts.push({ d: d, y: projectedPoint(d, base, alpha) });
    }
    pts.reverse();

    drawChart($('chartB'), {
      points: pts,
      dMax: 90,
      knee: knee,
      tone: 'est',
      currency: 'CNY',
      height: 300,
      obs: state.china.obs
    });
  }

  // ------------------------------------------------------------ chart

  function drawChart(svg, opt) {
    var W = 860, H = opt.height || 340;
    var pad = { l: 66, r: 20, t: 16, b: 46 };
    var plotW = W - pad.l - pad.r;
    var plotH = H - pad.t - pad.b;
    var dMax = opt.dMax;

    var pts = opt.points;
    if (!pts.length) { svg.innerHTML = ''; return; }

    var yMin = Infinity, yMax = -Infinity;
    pts.forEach(function (p) {
      yMin = Math.min(yMin, p.lo != null ? p.lo : p.y);
      yMax = Math.max(yMax, p.hi != null ? p.hi : p.y);
    });
    (opt.obs || []).forEach(function (o) {
      yMin = Math.min(yMin, o.y);
      yMax = Math.max(yMax, o.y);
    });
    if (!isFinite(yMin) || !isFinite(yMax)) { svg.innerHTML = ''; return; }
    var span = (yMax - yMin) || 1;
    yMin = Math.max(0, yMin - span * 0.12);
    yMax = yMax + span * 0.12;

    function xOf(d) { return pad.l + plotW * (dMax - d) / (dMax - 1); }
    function yOf(v) { return pad.t + plotH * (1 - (v - yMin) / (yMax - yMin)); }

    var parts = [];

    // 平台区 / 最后一周
    if (opt.knee) {
      var kx = xOf(opt.knee);
      parts.push('<rect class="knee-zone" x="' + pad.l + '" y="' + pad.t +
                 '" width="' + (kx - pad.l).toFixed(1) + '" height="' + plotH + '" rx="6"></rect>');
      if (kx - pad.l > 90) {
        parts.push('<text class="zone-label" x="' + (pad.l + 10) + '" y="' + (pad.t + 15) + '">平台期</text>');
      }
    }
    var dx = xOf(7);
    parts.push('<rect class="danger-zone" x="' + dx.toFixed(1) + '" y="' + pad.t +
               '" width="' + (xOf(1) - dx).toFixed(1) + '" height="' + plotH + '" rx="6"></rect>');
    if (xOf(1) - dx > 62) {
      parts.push('<text class="danger-label" x="' + (dx + 6) + '" y="' + (pad.t + plotH - 8) + '">最后一周</text>');
    }

    // 网格与 Y 轴
    var ticks = 4;
    for (var t = 0; t <= ticks; t++) {
      var v = yMin + (yMax - yMin) * (t / ticks);
      var y = yOf(v);
      parts.push('<line class="grid-line" x1="' + pad.l + '" y1="' + y.toFixed(1) +
                 '" x2="' + (W - pad.r) + '" y2="' + y.toFixed(1) + '"></line>');
      parts.push('<text class="axis-text" x="' + (pad.l - 10) + '" y="' + (y + 4).toFixed(1) +
                 '" text-anchor="end">' + fmtMoney(v, opt.currency) + '</text>');
    }

    // 分位带
    var hasBand = pts.some(function (p) { return p.lo != null; });
    if (hasBand) {
      var up = pts.map(function (p, i) {
        return (i === 0 ? 'M' : 'L') + xOf(p.d).toFixed(1) + ' ' + yOf(p.hi).toFixed(1);
      }).join(' ');
      var down = pts.slice().reverse().map(function (p) {
        return 'L' + xOf(p.d).toFixed(1) + ' ' + yOf(p.lo).toFixed(1);
      }).join(' ');
      parts.push('<path class="' + (opt.tone === 'est' ? 'band-est' : 'band') + '" d="' + up + ' ' + down + ' Z"></path>');
    }

    // 中位线
    var line = pts.map(function (p, i) {
      return (i === 0 ? 'M' : 'L') + xOf(p.d).toFixed(1) + ' ' + yOf(p.y).toFixed(1);
    }).join(' ');
    parts.push('<path class="median-line' + (opt.tone === 'est' ? ' est' : '') + '" d="' + line + '"></path>');

    // 关键点
    [1, 3, 7, 14, 21, 30, 45].forEach(function (d) {
      var p = pts.find(function (q) { return q.d === d; });
      if (p) {
        parts.push('<circle class="dot" cx="' + xOf(d).toFixed(1) + '" cy="' + yOf(p.y).toFixed(1) + '" r="3.2"></circle>');
      }
    });

    // 用户实测点
    (opt.obs || []).forEach(function (o) {
      if (o.d > dMax) return;
      parts.push('<circle class="obs-dot" cx="' + xOf(o.d).toFixed(1) + '" cy="' + yOf(o.y).toFixed(1) +
                 '" r="3.6"><title>' + o.d + ' 天 · ' + fmtMoney(o.y, opt.currency) + '（实测）</title></circle>');
    });

    // X 轴
    var wantTicks = [90, 60, 45, 30, 21, 14, 7, 1];
    wantTicks.forEach(function (d) {
      if (d > dMax) return;
      var strong = d === opt.knee;
      parts.push('<text class="axis-text' + (strong ? ' strong' : '') + '" x="' + xOf(d).toFixed(1) +
                 '" y="' + (H - pad.b + 20) + '" text-anchor="middle">' + d + '</text>');
    });
    parts.push('<text class="axis-text" x="' + (W - pad.r) + '" y="' + (H - 10) +
               '" text-anchor="end">提前天数（天）</text>');

    // 悬停热区
    pts.forEach(function (p, i) {
      var prev = pts[i - 1] ? pts[i - 1].d : dMax + 1;
      var next = pts[i + 1] ? pts[i + 1].d : 0;
      var left = xOf((prev + p.d) / 2);
      var right = xOf((p.d + next) / 2);
      var tip = '提前 ' + p.d + ' 天\n' + fmtMoney(p.y, opt.currency);
      if (p.lo != null) tip += '\n25%–75%: ' + fmtMoney(p.lo, opt.currency) + ' – ' + fmtMoney(p.hi, opt.currency);
      if (p.n) tip += '\n样本 ' + p.n + ' 条';
      parts.push('<rect class="hover-cell" x="' + left.toFixed(1) + '" y="' + pad.t +
                 '" width="' + Math.max(1, right - left).toFixed(1) + '" height="' + plotH + '">' +
                 '<title>' + tip + '</title></rect>');
    });

    svg.innerHTML = parts.join('');
  }

  // ------------------------------------------------------------ import

  function decodeText(buffer) {
    var bytes = new Uint8Array(buffer);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      try { return new TextDecoder('gbk').decode(bytes); }
      catch (e2) { return new TextDecoder('utf-8').decode(bytes); }
    }
  }

  function handleFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { fitFromCSV(decodeText(reader.result), file.name); };
    reader.readAsArrayBuffer(file);
  }

  function fitFromCSV(text, filename) {
    var parsed = window.FlightCSV.rowsToRecords(text);
    if (!parsed.records.length) {
      setFitNote('没有读到有效记录。' + (parsed.errors[0] || ''), true);
      toast('导入失败');
      return;
    }

    // 取记录最多的那条航线
    var groups = {};
    parsed.records.forEach(function (r) {
      var k = r.from + ' → ' + r.to;
      (groups[k] = groups[k] || []).push(r);
    });
    var bestKey = Object.keys(groups).sort(function (a, b) {
      return groups[b].length - groups[a].length;
    })[0];
    var rows = groups[bestKey];

    var obs = [];
    rows.forEach(function (r) {
      var dep = parseDate(r.departDate);
      var chk = parseDate(r.checkedDate);
      if (!dep || !chk) return;
      var lead = diffDays(dep, chk);
      if (lead >= 1 && lead <= 120) obs.push({ d: lead, y: r.price });
    });

    if (obs.length < 6) {
      setFitNote('这条航线只有 ' + obs.length + ' 条可用记录，至少要 6 条不同提前天数的观测才能拟合。', true);
      toast('样本太少');
      return;
    }

    var plateauRows = obs.filter(function (o) { return o.d >= 21; });
    var base = Math.round(plateauRows.length >= 5
      ? median(plateauRows.map(function (o) { return o.y; }))
      : median(obs.map(function (o) { return o.y; })));

    var num = 0, den = 0;
    obs.forEach(function (o) {
      var w = o.y / base - 1;
      var z = zOf(o.d, 'Economy') - 1;
      num += w * z;
      den += z * z;
    });
    var alpha = den > 0 ? num / den : 1;
    var clipped = Math.min(2.5, Math.max(0.5, alpha));

    // 误差
    var ape = obs.map(function (o) {
      var pred = base * (1 + clipped * (zOf(o.d, 'Economy') - 1));
      return Math.abs(pred - o.y) / o.y;
    });
    var mape = ape.reduce(function (a, b) { return a + b; }, 0) / ape.length;

    state.china.obs = obs;
    state.china.fitted = true;
    state.china.fittedAlpha = clipped;
    state.china.mape = mape;
    state.china.fitN = obs.length;

    $('inBase').value = base;
    $('inAlpha').value = clipped.toFixed(2);

    // 如果导入的航线和页面上选的中国航线对不上，提醒一下
    var curFrom = $('cnFrom').value;
    var curTo = $('cnTo').value;
    if (bestKey.indexOf(curFrom) === -1 || bestKey.indexOf(curTo) === -1) {
      state.china.routeMismatch = bestKey;
    } else {
      state.china.routeMismatch = null;
    }

    var msg = '已识别 <b>' + bestKey + '</b>，' + obs.length + ' 条观测（' + Math.min.apply(null, obs.map(function (o) { return o.d; })) +
      '–' + Math.max.apply(null, obs.map(function (o) { return o.d; })) + ' 天）。拟合得到 <b>α = ' + clipped.toFixed(2) +
      '</b>，平均误差 <b>' + (mape * 100).toFixed(1) + '%</b>。';
    if (alpha !== clipped) msg += '（原始估计 ' + alpha.toFixed(2) + ' 超出合理范围，已截断）';
    if (state.china.routeMismatch) {
      msg += '<div class="warn">注意：导入的是「' + bestKey + '」，页面当前选的是「' +
        curFrom + ' → ' + curTo + '」，α 仍会套用，但两者可能不是同一条线。</div>';
    }
    if (obs.length < 20) msg += '<div class="warn">观测偏少，建议至少 20 条、覆盖 14–90 天。</div>';

    setFitNote(msg, false, true);
    renderB();
    toast('已用 ' + obs.length + ' 条实测数据校准');
  }

  function setFitNote(html, bad, fitted) {
    var box = $('fitBox');
    var note = $('fitNote');
    note.innerHTML = html;
    box.classList.toggle('fitted', !!fitted);
    note.className = bad ? 'warn' : '';
  }

  // ------------------------------------------------------------ misc

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  function boot() {
    var meta = DATA.meta || {};
    if (meta.rows) $('metaRows').textContent = meta.rows.toLocaleString('zh-CN');
    if (meta.series) $('metaSeries').textContent = meta.series;
    if (meta.builtAt) $('metaBuilt').textContent = '聚合于 ' + meta.builtAt;

    var cities = cityList();
    fillSelect($('selFrom'), cities, 'Delhi');
    refreshDest();
    if (!destList($('selFrom').value, $('selCls').value).length) {
      $('selCls').value = 'Business';
      refreshDest();
    }
    // 默认展示最典型的一条干线
    if (destList($('selFrom').value, $('selCls').value).indexOf('Mumbai') !== -1) {
      $('selTo').value = 'Mumbai';
    }

    var cnCities = CITIES.pairs.map(function (p) { return p.cn; });
    fillSelect($('cnFrom'), cnCities, '北京');
    fillSelect($('cnTo'), cnCities, '上海');
    renderCityTable();

    $('selFrom').addEventListener('change', function () { refreshDest(); renderA(); });
    $('selTo').addEventListener('change', renderA);
    $('selCls').addEventListener('change', function () {
      refreshDest();
      renderA();
    });

    $('cnFrom').addEventListener('change', syncRoute);
    $('cnTo').addEventListener('change', syncRoute);

    $('inBase').addEventListener('input', function () {
      state.china.manualBase = true;
      updateEstimateBox(estimateRoute());
      renderB();
    });

    ['inAlpha', 'inDepart'].forEach(function (id) {
      $(id).addEventListener('input', renderB);
      $(id).addEventListener('change', renderB);
    });

    $('btnImport').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (e) {
      handleFile(e.target.files && e.target.files[0]);
    });

    renderA();
    syncRoute();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
