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
