"use client";

// Blue Bank orders + invoices — localStorage-backed payment requests settled in
// B20 USDC via transferWithMemo (Memo.memo === stringToHex(orderId) flips a
// request pending → paid).
//
// Gated behind NEXT_PUBLIC_B20_ENABLED. This comment used to say "until B20
// mainnet (June 25)", which read as "the gate opens on that date". It does not:
// the gate is an env var, and it is NOT SET in production (measured 2026-09-06
// against all 42 production vars). B20 itself has been active on Base mainnet
// since well before then — the ActivationRegistry says so on-chain — so the two
// facts are independent and the date explained neither.
//
// While the flag is off, `markPaid` is unreachable: its only two call sites (the
// Memo watcher in OrdersPanel and the Pay button on /pay/[address]) both return
// early on !B20_ENABLED. Orders can be created and shared; nothing can move one
// out of Pending. Say that in any copy you write about this — do not describe it
// as settlement that is merely "coming".

export const B20_ENABLED = process.env.NEXT_PUBLIC_B20_ENABLED === "true";

// The canonical B20 USDC token on Base. Intentionally NOT hardcoded — it is read
// from env (NEXT_PUBLIC_B20_USDC) and stays empty until a verified address is set,
// so a guessed/placeholder address can never be paid. The Pay button checks this
// is a real address before sending; the Memo watcher reads logs from it.
export const B20_USDC = (process.env.NEXT_PUBLIC_B20_USDC ?? "").trim();

export type OrderKind = "order" | "invoice";
export type OrderStatus = "pending" | "paid";

export interface Order {
  id: string;            // order-<ts> | INV-<ts>
  kind: OrderKind;
  amount: number;        // USDC
  description?: string;
  client?: string;       // invoice only
  dueDate?: string;      // invoice only — yyyy-mm-dd
  payTo?: string;        // merchant wallet — where B20 USDC settles
  status: OrderStatus;
  txHash?: string;
  createdAt: number;
  paidAt?: number;
}

const KEY = "blueagent:orders";
const isClient = typeof window !== "undefined";

export function loadOrders(): Order[] {
  if (!isClient) return [];
  try { const r = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(r) ? r : []; }
  catch { return []; }
}
export function saveOrders(list: Order[]): void {
  if (!isClient) return;
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 200))); } catch { /* blocked */ }
}
export function createOrder(input: {
  kind?: OrderKind; amount: number; description?: string; client?: string; dueDate?: string; payTo?: string;
}): Order {
  const kind = input.kind ?? "order";
  const order: Order = {
    id: `${kind === "invoice" ? "INV" : "order"}-${Date.now()}`,
    kind,
    amount: input.amount,
    description: input.description?.trim() || undefined,
    client: input.client?.trim() || undefined,
    dueDate: input.dueDate || undefined,
    payTo: input.payTo?.trim() || undefined,
    status: "pending",
    createdAt: Date.now(),
  };
  saveOrders([order, ...loadOrders()]);
  return order;
}
export function findOrder(id: string): Order | null {
  return loadOrders().find((o) => o.id === id) ?? null;
}
export function removeOrder(id: string): void {
  saveOrders(loadOrders().filter((o) => o.id !== id));
}
export function markPaid(id: string, txHash?: string): void {
  saveOrders(loadOrders().map((o) => (o.id === id ? { ...o, status: "paid", txHash, paidAt: Date.now() } : o)));
}

/** Shareable public payment link, e.g. blueagent.dev/pay/order-1719…
 *  Carries recipient + amount + label in the query so a payer on a different
 *  device (no localStorage copy of the order) can still settle it. */
export function payLink(id: string, order?: Order): string {
  const origin = isClient ? window.location.origin : "https://blueagent.dev";
  const o = order ?? findOrder(id) ?? undefined;
  const qs = new URLSearchParams();
  if (o?.payTo) qs.set("to", o.payTo);
  if (o?.amount) qs.set("amount", String(o.amount));
  if (o?.description) qs.set("for", o.description);
  const q = qs.toString();
  return `${origin}/pay/${id}${q ? `?${q}` : ""}`;
}

/** Order/invoice ids are slugs; addresses are 0x… — lets /pay/[address] branch. */
export function isOrderId(s: string): boolean {
  return /^(order|INV)-\d+$/i.test(s);
}

export function ordersToCsv(list: Order[]): string {
  const head = "id,kind,amount_usdc,status,description,client,due_date,created,tx";
  const rows = list.map((o) =>
    [o.id, o.kind, o.amount, o.status, o.description ?? "", o.client ?? "", o.dueDate ?? "",
     new Date(o.createdAt).toISOString(), o.txHash ?? ""]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","),
  );
  return [head, ...rows].join("\n");
}
