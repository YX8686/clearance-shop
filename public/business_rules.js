/**
 * 不初限时狂欢商城 · 后台业务规则脚本
 * 本文件为规则落地脚本，禁止擅自修改。
 * 详细说明见项目根目录 business_rules.md。
 */

// eslint-disable-next-line no-unused-vars
const BUSINESS_RULES = {
  // 自动合并规则：待发货列表中，同一客户必须同时满足以下 4 个字段完全一致才合并
  merge: {
    fields: ['name', 'phone', 'address', 'wechat'],
    description: '姓名 + 电话 + 地址 + 微信号 四要素全部一致时才允许自动合并',
    makeKey(order) {
      return this.fields.map(f => String(order[f] || '')).join('|');
    }
  },

  // 金额核对机制：涉及金额的环节必须先展示明细并经人工确认
  amountCheck: {
    description: '凡涉及客户金额的环节，必须展示金额明细并经人工核对确认后再执行',
    requiredSteps: ['confirmPaid', 'ship', 'shipGroup'],
    currencySymbol: '¥'
  },

  // 发货文本格式规则
  shipText: {
    description: '发货文本仅包含姓名、电话、地址、商品及数量，不显示字段名、订单号、付款时间、金额',
    include: ['name', 'phone', 'address', 'items_qty'],
    exclude: ['field_labels', 'order_id', 'paid_time', 'amount'],
    bundleFormat: {
      description: '设置了 bundleItems 的组合产品，按明细展开并乘以购买份数',
      example: '经典面膜 · 5盒线雕囤货装\n• 线雕面膜   5 盒\n• 液   10 瓶'
    }
  },

  // 产品明细规则：价格链接可配置包含哪些实际发货产品
  productBundle: {
    description: '每个产品可配置 bundleItems（名称、数量、单位），用于生成发货文本时展开明细',
    inputFormat: '每行一个产品，格式：产品名 数量 单位，例如：\n线雕面膜 5 盒\n液 10 瓶',
    maxItems: 20
  },

  // ★★★ 发货回填铁律（禁止违反；违反会导致货物被重复寄出）★★★
  // 场景：同一收件人的多笔订单装在同一个包裹里，共用同一个快递单号；
  //       但每笔订单各自持有不同编号（A1/A2/A3…）。
  // 规则：发货员回传单号时（无论按编号匹配还是按手机号匹配），
  //       只要命中了该收件人的任意一笔，就必须把「同一收件人全部未发货订单」一起回填同一单号。
  // 判定"同一收件人"用 姓名 + 电话 + 地址（**不含微信号**：微信号常被事后手填/修改，
  //       各笔可能不一致，例如实测 A1/A2=「小5」而 A3=「wuyunpeng_test」，若算入会拆组导致漏发）。
  // 另需保证幂等：同一次回传里同一订单只回填一次；同一订单在多次「全部导出」的 session 中重复出现时先去重。
  shipBackfill: {
    description: '一个客户多笔订单共用一个包裹/单号，回传时必须整组一起回填，绝不能只回填其中一笔',
    groupFields: ['name', 'phone', 'address'],
    excludeFields: ['wechat'],
    mustNotHappen: '只把合并订单中的一笔标记为已发货，其余仍留在等待回传区（会被重复寄出）',
    idempotent: true,
    scaleRequirement: '需支持一次回传 500+ 单：使用 Map 预建索引，避免 O(n²) 遍历'
  }
};

/**
 * 按合并规则对订单列表进行分组。
 * @param {Array} orders 订单数组
 * @returns {Object} 分组对象，key 为合并规则字段组合，value 为订单数组
 */
// eslint-disable-next-line no-unused-vars
function groupOrdersByMergeRule(orders) {
  const groups = {};
  orders.forEach(o => {
    const key = BUSINESS_RULES.merge.makeKey(o);
    (groups[key] = groups[key] || []).push(o);
  });
  return groups;
}

/**
 * 校验订单金额：商品小计之和必须等于订单 total。
 * @param {Object} order 订单对象
 * @returns {Object} { ok: boolean, expected: number, actual: number }
 */
// eslint-disable-next-line no-unused-vars
function validateOrderAmount(order) {
  const expected = order.items.reduce((sum, i) => sum + (Number(i.price) * Number(i.qty)), 0);
  const actual = Number(order.total);
  return { ok: Math.abs(expected - actual) < 0.01, expected, actual };
}
