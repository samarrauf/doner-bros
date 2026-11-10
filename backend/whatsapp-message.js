// Doner Bros — the kitchen's WhatsApp message to a customer when their order is READY: "on its
// way" for delivery, "ready for pickup" for pickup. Built only from that one saved order row (its
// own items, total and fee, in paisa, formatted with formatRupees); nothing is recalculated here.

const { formatRupees } = require("./orders");
const { deliveryFeeStatus } = require("./totals");
const { waNumber } = require("../admin/kitchen-whatsapp");

const SHOP_NAME = "Doner Bros";
// Used when delivery_eta_min_minutes / delivery_eta_max_minutes aren't set in menu_settings.
const DEFAULT_DELIVERY_ETA = Object.freeze({ minMinutes: 30, maxMinutes: 45 });

// The columns the message needs, and nothing more.
const WHATSAPP_COLUMNS =
  "order_id, status, order_type, customer_name, customer_phone, delivery_address, delivery_unit, items, total_paisa, delivery_fee_paisa";

const clean = (value) => (typeof value === "string" ? value.trim() : "");

function itemLine(line) {
  const choices = Array.isArray(line.options) ? line.options.map((o) => o && o.choice).filter(Boolean) : [];
  const options = choices.length ? ` (${choices.join(", ")})` : "";
  const price = Number.isInteger(line.lineTotalPaisa) ? `: ${formatRupees(line.lineTotalPaisa)}` : "";
  return `- ${line.quantity} x ${line.name}${options}${price}`;
}

function totalLine(row) {
  const total = `Total: ${formatRupees(row.total_paisa)}`;
  switch (deliveryFeeStatus(row.order_type, row.delivery_fee_paisa)) {
    case "set": return `${total} (includes delivery fee: ${formatRupees(row.delivery_fee_paisa)})`;
    case "free": return `${total} (free delivery)`;
    case "not_decided": return `${total}, delivery fee to be confirmed`;
    default: return total;
  }
}

// row: one orders row with WHATSAPP_COLUMNS. eta: { minMinutes, maxMinutes } from settings, or null.
function buildCustomerMessage(row, eta) {
  const time = eta && eta.minMinutes && eta.maxMinutes ? eta : DEFAULT_DELIVERY_ETA;
  const name = clean(row.customer_name);
  const hello = name ? `Assalam o Alaikum ${name}!` : "Assalam o Alaikum!";
  const items = (Array.isArray(row.items) ? row.items : []).map(itemLine);

  if (row.order_type === "delivery") {
    const address = [clean(row.delivery_address), clean(row.delivery_unit)].filter(Boolean).join(", ");
    return [
      `${hello} Your ${SHOP_NAME} order ${row.order_id} is on its way. The rider is coming to you and you will get your order in ${time.minMinutes} to ${time.maxMinutes} minutes.`,
      "",
      "Order details:",
      ...items,
      totalLine(row),
      ...(address ? [`Delivery address: ${address}`] : []),
      "",
      `Thank you for choosing ${SHOP_NAME}!`,
    ].join("\n");
  }
  return [
    `${hello} Your ${SHOP_NAME} order ${row.order_id} is ready for pickup.`,
    "",
    "Order details:",
    ...items,
    totalLine(row),
    "",
    "Thank you!",
  ].join("\n");
}

// What the kitchen pop-up needs for one order. waNumber is null when the phone can't be used.
function whatsappForOrder(row, eta) {
  return {
    orderId: row.order_id,
    orderType: row.order_type,
    customerName: clean(row.customer_name) || null,
    customerPhone: clean(row.customer_phone) || null,
    waNumber: waNumber(row.customer_phone),
    text: buildCustomerMessage(row, eta),
  };
}

module.exports = { SHOP_NAME, DEFAULT_DELIVERY_ETA, WHATSAPP_COLUMNS, buildCustomerMessage, whatsappForOrder };
