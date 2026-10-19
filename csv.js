/*
 * 极简 CSV 解析 / 导出。
 * 目标：不依赖任何第三方库，双击 index.html 也能用。
 */
(function (global) {
  'use strict';

  /** 把 CSV 文本切成二维数组，支持引号包裹、逗号转义、CRLF。 */
  function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var i = 0;

    // 去掉 BOM（Excel 导出的 UTF-8 CSV 经常带）
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    while (i < text.length) {
      var ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i += 1; continue;
        }
        field += ch; i += 1; continue;
      }

      if (ch === '"') { inQuotes = true; i += 1; continue; }
      if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
      if (ch === '\r') { i += 1; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }

      field += ch; i += 1;
    }

    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

    // 丢掉完全空白的行
    return rows.filter(function (r) {
      return r.some(function (c) { return String(c).trim() !== ''; });
    });
  }

  var ALIASES = {
    from: ['出发城市', '出发地', '出发', 'from', 'origin', 'departure', 'departure_city'],
    to: ['到达城市', '目的地', '到达', 'to', 'destination', 'arrival', 'arrival_city'],
    departDate: ['去程日期', '出发日期', '去程', 'departdate', 'depart_date', 'departure_date', 'date'],
    returnDate: ['返程日期', '回程日期', '返程', 'returndate', 'return_date', 'return'],
    checkedDate: ['查询日期', '购买日期', '查询日', '下单日期', 'checkeddate', 'checked_date',
                  'purchase_date', 'query_date', 'check_date'],
    price: ['价格', '票价', '含税价', '含税价格', 'price', 'fare', 'amount'],
    airline: ['航司', '航空公司', '承运人', 'airline', 'carrier'],
    flightNo: ['航班号', '航班', 'flightno', 'flight_no', 'flight'],
    cabin: ['舱位', '舱位等级', 'cabin', 'class'],
    channel: ['渠道', '数据来源', '来源', 'channel', 'source'],
    note: ['备注', '说明', 'notes', 'note', 'comment']
  };

  function normalizeHeader(h) {
    return String(h == null ? '' : h)
      .replace(/^\uFEFF/, '')
      .trim()
      .toLowerCase()
      .replace(/[\s_\-（）()]/g, '');
  }

  function buildHeaderMap(headerRow) {
    var map = {};
    var normalized = headerRow.map(normalizeHeader);

    Object.keys(ALIASES).forEach(function (key) {
      var names = ALIASES[key].map(normalizeHeader);
      for (var i = 0; i < normalized.length; i++) {
        if (names.indexOf(normalized[i]) !== -1) { map[key] = i; return; }
      }
    });
    return map;
  }

  /** 把各种常见写法统一成 YYYY-MM-DD；失败返回 null。 */
  function normalizeDate(raw) {
    if (raw == null) return null;
    var s = String(raw).trim();
    if (!s) return null;

    var m = s.match(/^(\d{4})[\/\.\-年](\d{1,2})[\/\.\-月](\d{1,2})日?$/);
    if (m) {
      var y = +m[1], mo = +m[2], d = +m[3];
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
      return pad4(y) + '-' + pad2(mo) + '-' + pad2(d);
    }
    return null;
  }

  function normalizePrice(raw) {
    if (raw == null) return null;
    var s = String(raw).replace(/[¥￥,\s元]/g, '');
    if (!s) return null;
    var n = Number(s);
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(n);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function pad4(n) { return String(n).padStart(4, '0'); }

  /**
   * CSV 文本 -> { records, errors, total }
   * 只保留结构正确的行；错误行带行号返回，交给界面展示。
   */
  function rowsToRecords(text) {
    var rows = parseCSV(text);
    if (rows.length < 2) {
      return { records: [], errors: ['文件里只有表头，没有数据行。'], total: 0 };
    }

    var header = buildHeaderMap(rows[0]);
    var errors = [];

    var required = ['from', 'to', 'departDate', 'checkedDate', 'price'];
    var missing = required.filter(function (k) { return header[k] === undefined; });
    if (missing.length) {
      var cn = { from: '出发城市', to: '到达城市', departDate: '去程日期',
                 checkedDate: '查询日期', price: '价格' };
      return {
        records: [],
        errors: ['缺少必要的列：' + missing.map(function (k) { return cn[k]; }).join('、') +
                 '。请参照《下载 CSV 模板》的表头。'],
        total: 0
      };
    }

    function cell(row, key) {
      var idx = header[key];
      return idx === undefined ? '' : String(row[idx] == null ? '' : row[idx]).trim();
    }

    var records = [];
    for (var r = 1; r < rows.length; r++) {
      var rowNo = r + 1; // 给人看的行号：表头是第 1 行
      var from = cell(rows[r], 'from');
      var to = cell(rows[r], 'to');
      var departDate = normalizeDate(cell(rows[r], 'departDate'));
      var checkedDate = normalizeDate(cell(rows[r], 'checkedDate'));
      var price = normalizePrice(cell(rows[r], 'price'));

      if (!from || !to) { errors.push('第 ' + rowNo + ' 行：出发/到达城市为空。'); continue; }
      if (!departDate) { errors.push('第 ' + rowNo + ' 行：去程日期无法识别（建议 2027-07-08）。'); continue; }
      if (!checkedDate) { errors.push('第 ' + rowNo + ' 行：查询日期无法识别（建议 2027-05-20）。'); continue; }
      if (price === null) { errors.push('第 ' + rowNo + ' 行：价格不是有效数字。'); continue; }
      if (checkedDate > departDate) { errors.push('第 ' + rowNo + ' 行：查询日期晚于出发日期。'); continue; }

      records.push({
        from: from,
        to: to,
        departDate: departDate,
        returnDate: normalizeDate(cell(rows[r], 'returnDate')) || '',
        checkedDate: checkedDate,
        price: price,
        airline: cell(rows[r], 'airline'),
        flightNo: cell(rows[r], 'flightNo'),
        cabin: cell(rows[r], 'cabin') || '经济舱',
        channel: cell(rows[r], 'channel'),
        note: cell(rows[r], 'note')
      });
    }

    return { records: records, errors: errors, total: rows.length - 1 };
  }

  var CSV_HEADER = ['出发城市', '到达城市', '去程日期', '返程日期', '查询日期',
                    '价格', '航司', '航班号', '舱位', '渠道', '备注'];

  function escapeCell(v) {
    var s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function recordsToCSV(records) {
    var lines = [CSV_HEADER.join(',')];
    records.forEach(function (r) {
      lines.push([r.from, r.to, r.departDate, r.returnDate || '', r.checkedDate,
                  r.price, r.airline || '', r.flightNo || '', r.cabin || '',
                  r.channel || '', r.note || ''].map(escapeCell).join(','));
    });
    return '\uFEFF' + lines.join('\r\n');
  }

  function downloadText(filename, text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  global.FlightCSV = {
    parseCSV: parseCSV,
    rowsToRecords: rowsToRecords,
    recordsToCSV: recordsToCSV,
    downloadText: downloadText,
    normalizeDate: normalizeDate
  };
})(window);
