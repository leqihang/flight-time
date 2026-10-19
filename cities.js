/*
 * 印度 6 城 → 中国 6 城的对标表。
 *
 * 用途：把 Kaggle 印度数据里的航线，映射成一条可查询的中国航线。
 *
 * 注意：
 *   1. 人口 / 人均 GDP / 机场吞吐量只用来"解释为什么这样对标"，
 *      不参与票价计算 —— 6 个点做不出有统计意义的回归。
 *   2. 票价换算只用三样东西：印度该航线的常态价、两地距离比、汇率。
 *   3. level 是"中国市场整体价格水平相对印度"的假设系数，可自行调整。
 *
 * 数值为量级参考：人口与人均 GDP 约 2023 年，机场吞吐量为 2019 年（疫情前）。
 */

window.CITY_DATA = {
  fx: 0.085,     // 1 INR ≈ 0.085 CNY（2022 年前后量级）
  level: 2.4,    // 中国国内票价整体约为印度的 2.4 倍（人工校准，不是回归结果）
  beta: 0.06,    // 距离修正指数：用印度 30 条航线拟合出来的，R² 只有 0.06

  pairs: [
    {
      in: 'Delhi', cn: '北京',
      inLat: 28.6139, inLon: 77.2090,
      cnLat: 39.9042, cnLon: 116.4074,
      inPop: 3200, inGdp: 4000, inPax: 7000,
      cnPop: 2186, cnGdp: 200000, cnPax: 10000,
      why: '首都 · 北方航空门户'
    },
    {
      in: 'Mumbai', cn: '上海',
      inLat: 19.0760, inLon: 72.8777,
      cnLat: 31.2304, cnLon: 121.4737,
      inPop: 2100, inGdp: 5000, inPax: 4500,
      cnPop: 2487, cnGdp: 190000, cnPax: 12000,
      why: '金融中心 · 沿海经济首位城市'
    },
    {
      in: 'Bangalore', cn: '深圳',
      inLat: 12.9716, inLon: 77.5946,
      cnLat: 22.5431, cnLon: 114.0579,
      inPop: 1300, inGdp: 5500, inPax: 3300,
      cnPop: 1779, cnGdp: 196000, cnPax: 5300,
      why: '科技产业中心 · 年轻人口流入'
    },
    {
      in: 'Hyderabad', cn: '成都',
      inLat: 17.3850, inLon: 78.4867,
      cnLat: 30.5728, cnLon: 104.0668,
      inPop: 1000, inGdp: 4500, inPax: 2100,
      cnPop: 2140, cnGdp: 104000, cnPax: 5500,
      why: '内陆枢纽 · 科技与制药并重'
    },
    {
      in: 'Chennai', cn: '广州',
      inLat: 13.0827, inLon: 80.2707,
      cnLat: 23.1291, cnLon: 113.2644,
      inPop: 1100, inGdp: 4000, inPax: 2200,
      cnPop: 1882, cnGdp: 160000, cnPax: 7300,
      why: '制造业 + 港口 · 南方门户'
    },
    {
      in: 'Kolkata', cn: '武汉',
      inLat: 22.5726, inLon: 88.3639,
      cnLat: 30.5928, cnLon: 114.3055,
      inPop: 1500, inGdp: 3000, inPax: 2200,
      cnPop: 1377, cnGdp: 145000, cnPax: 2700,
      why: '老工业基地 · 中部交通枢纽'
    }
  ]
};
