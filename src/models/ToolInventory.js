// src/models/ToolInventory.js

import { v4 as uuidv4 } from "uuid";

/**
 * ToolInventory
 * -----------------------------------------------------------------------------
 * A smart, skill-aware tool / equipment model that supports:
 *  - Skills & roles mapping for matching against task.requiredSkills
 *  - Reservations and check-outs with due dates (soft availability)
 *  - Maintenance & calibration cycles with next-due math
 *  - Condition lifecycle and repair tickets
 *  - Safety metadata (PPE, hazards, training required)
 *  - Utilization & last-used metrics for dashboards
 *
 * Backward compatibility: preserves original fields: id, name, category,
 * quantity, condition, location, notes, checkedOut, lastUsed, createdAt.
 */

export default class ToolInventory {
  constructor({
    // ----- original fields (kept) -----
    id = uuidv4(),
    name = "",
    category = "",
    quantity = 1,
    condition = "Good", // "Excellent" | "Good" | "Fair" | "Needs Repair" | "Broken"
    location = "",
    notes = "",
    checkedOut = false, // kept for back-compat (single-item tools). See status below.
    lastUsed = null,
    createdAt = Date.now(),

    // ----- new fields -----
    assetTag = "",                // QR/label text or barcode
    status = "available",         // "available" | "reserved" | "checked_out" | "maintenance" | "broken"
    skills = [],                  // e.g., ["pruning","cutting","measuring","sanitation","canning"]
    roles = [],                   // e.g., ["gardener","butcher","cook","cleaner","handyperson"]
    tags = [],                    // free-form, e.g., ["cordless","outdoor","PPE-required"]
    power = false,                // powered tool (electrical/fuel)
    attachments = [],             // e.g., blades/bits/etc. [{ id, name, qty }]

    // Safety & compliance
    safety = {
      ppe: [],                    // ["gloves","mask","eye-protection"]
      hazards: [],                // ["sharp","hot","chemical"]
      trainingRequired: false,
      manualUrl: ""
    },

    // Maintenance & calibration
    maintenancePlan = [
      // { type:"maintenance"|"calibration"|"inspection", intervalDays: number, lastPerformedAt: ISO string|null, notes?: string }
    ],
    repairTickets = [
      // { id, openedAt, description, severity:"low"|"med"|"high", status:"open"|"in_progress"|"closed", closedAt? }
    ],

    // Availability ops
    reservations = [
      // { id, workerId, startAt: ISO, endAt: ISO, status:"held"|"active"|"released"|"expired", createdAt }
    ],
    checkouts = [
      // { id, workerId, outAt: ISO, dueAt: ISO|null, inAt: ISO|null, conditionNotes?: string }
    ],

    // Utilization
    usageHistory = [
      // { at: ISO, workerId?: string, taskId?: string, minutes?: number, notes?: string }
    ],

    // Cost/identity
    sku = "",
    vendor = "",                  // vendor name/id
    purchaseDate = null,          // ISO
    purchasePrice = null          // number
  } = {}) {
    // original
    this.id = id;
    this.name = name;
    this.category = category;
    this.quantity = Number(quantity || 1);
    this.condition = condition;
    this.location = location;
    this.notes = notes;
    this.checkedOut = !!checkedOut;
    this.lastUsed = lastUsed;
    this.createdAt = createdAt;

    // new
    this.assetTag = assetTag;
    this.status = status;
    this.skills = Array.isArray(skills) ? skills : [];
    this.roles = Array.isArray(roles) ? roles : [];
    this.tags = Array.isArray(tags) ? tags : [];
    this.power = !!power;
    this.attachments = Array.isArray(attachments) ? attachments : [];

    this.safety = {
      ppe: Array.isArray(safety?.ppe) ? safety.ppe : [],
      hazards: Array.isArray(safety?.hazards) ? safety.hazards : [],
      trainingRequired: !!(safety?.trainingRequired),
      manualUrl: safety?.manualUrl || ""
    };

    this.maintenancePlan = Array.isArray(maintenancePlan) ? maintenancePlan.map((m) => this._normMaintain(m)) : [];
    this.repairTickets = Array.isArray(repairTickets) ? repairTickets.map((r) => this._normTicket(r)) : [];

    this.reservations = Array.isArray(reservations) ? reservations.map((r) => this._normReservation(r)) : [];
    this.checkouts = Array.isArray(checkouts) ? checkouts.map((c) => this._normCheckout(c)) : [];
    this.usageHistory = Array.isArray(usageHistory) ? usageHistory.map((u) => this._normUsage(u)) : [];

    this.sku = sku;
    this.vendor = vendor;
    this.purchaseDate = purchaseDate ? new Date(purchaseDate).toISOString() : null;
    this.purchasePrice = purchasePrice != null ? Number(purchasePrice) : null;

    // sync legacy checkedOut to status (best effort)
    if (this.checkedOut && this.status === "available") this.status = "checked_out";
    if (!this.checkedOut && this.status === "checked_out") this.checkedOut = true; // keep truthy for old UIs
  }

  // ----------------------------- Normalizers -----------------------------
  _normMaintain(m) {
    return {
      type: (m?.type || "maintenance").toLowerCase(),
      intervalDays: Math.max(0, Number(m?.intervalDays || 0)),
      lastPerformedAt: m?.lastPerformedAt ? new Date(m.lastPerformedAt).toISOString() : null,
      notes: m?.notes || ""
    };
  }
  _normTicket(r) {
    return {
      id: r?.id || `rt-${uuidv4()}`,
      openedAt: r?.openedAt ? new Date(r.openedAt).toISOString() : new Date().toISOString(),
      description: r?.description || "",
      severity: (r?.severity || "low").toLowerCase(), // low | med | high
      status: (r?.status || "open").toLowerCase(),    // open | in_progress | closed
      closedAt: r?.closedAt ? new Date(r.closedAt).toISOString() : null
    };
  }
  _normReservation(r) {
    return {
      id: r?.id || `res-${uuidv4()}`,
      workerId: r?.workerId || null,
      startAt: r?.startAt ? new Date(r.startAt).toISOString() : new Date().toISOString(),
      endAt: r?.endAt ? new Date(r.endAt).toISOString() : null,
      status: (r?.status || "held").toLowerCase(), // held | active | released | expired
      createdAt: r?.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString()
    };
  }
  _normCheckout(c) {
    return {
      id: c?.id || `co-${uuidv4()}`,
      workerId: c?.workerId || null,
      outAt: c?.outAt ? new Date(c.outAt).toISOString() : new Date().toISOString(),
      dueAt: c?.dueAt ? new Date(c.dueAt).toISOString() : null,
      inAt: c?.inAt ? new Date(c.inAt).toISOString() : null,
      conditionNotes: c?.conditionNotes || ""
    };
  }
  _normUsage(u) {
    return {
      at: u?.at ? new Date(u.at).toISOString() : new Date().toISOString(),
      workerId: u?.workerId || null,
      taskId: u?.taskId || null,
      minutes: u?.minutes != null ? Math.max(0, Number(u.minutes)) : null,
      notes: u?.notes || ""
    };
  }

  // ----------------------------- Availability -----------------------------

  /**
   * Reserve a tool for a time window. For single-quantity tools reserves 1; for multi-quantity
   * this method is still “binary” (reserved or not) at the object level — if you need per-unit,
   * represent each unit as its own ToolInventory row (recommended).
   */
  reserve({ workerId = null, startAt = new Date(), endAt = null } = {}) {
    // conflict check: any active/held reservation overlapping?
    const start = new Date(startAt).getTime();
    const end = endAt ? new Date(endAt).getTime() : null;
    const conflict = this.reservations.some((r) => {
      if (["released", "expired"].includes(r.status)) return false;
      const rs = new Date(r.startAt).getTime();
      const re = r.endAt ? new Date(r.endAt).getTime() : null;
      // overlap if windows intersect (null end means open)
      if (end == null || re == null) return !(re != null && re <= start) && !(end != null && end <= rs);
      return rs < end && start < re;
    });
    if (conflict) return null;

    const res = this._normReservation({ workerId, startAt, endAt, status: "held" });
    this.reservations.push(res);
    if (this.status === "available") this.status = "reserved";
    return res;
  }

  activateReservation(resId) {
    const res = this.reservations.find((r) => r.id === resId && r.status === "held");
    if (!res) return false;
    res.status = "active";
    this.status = "reserved";
    return true;
  }

  releaseReservation(resId) {
    const res = this.reservations.find((r) => r.id === resId && (r.status === "held" || r.status === "active"));
    if (!res) return false;
    res.status = "released";
    // if nothing else blocks it, free it
    if (!this.isCheckedOut() && !this.hasActiveReservation()) this.status = "available";
    return true;
  }

  hasActiveReservation(at = new Date()) {
    const t = new Date(at).getTime();
    return this.reservations.some((r) => {
      if (!["held", "active"].includes(r.status)) return false;
      const rs = new Date(r.startAt).getTime();
      const re = r.endAt ? new Date(r.endAt).getTime() : null;
      return rs <= t && (re == null || t <= re);
    });
  }

  // ----------------------------- Check-out / in -----------------------------

  checkout({ workerId = null, dueAt = null, conditionNotes = "" } = {}) {
    if (this.status === "broken" || this.status === "maintenance") return null;
    const co = this._normCheckout({ workerId, dueAt, conditionNotes });
    this.checkouts.push(co);
    this.status = "checked_out";
    this.checkedOut = true; // back-compat
    this.lastUsed = new Date().toISOString();
    return co;
  }

  checkin(checkoutId) {
    const co = this.checkouts.find((c) => c.id === checkoutId && !c.inAt);
    if (!co) return false;
    co.inAt = new Date().toISOString();
    this.checkedOut = false; // back-compat
    // return to reserved if a reservation blocks, else available
    this.status = this.hasActiveReservation() ? "reserved" : "available";
    return true;
  }

  isCheckedOut() {
    return this.status === "checked_out" || !!this.checkouts.find((c) => !c.inAt);
  }

  // ----------------------------- Maintenance -------------------------------

  /** Mark maintenance action performed by type; auto-sets next due via getNextMaintenanceDue(). */
  recordMaintenance({ type = "maintenance", when = new Date() } = {}) {
    const idx = this.maintenancePlan.findIndex((m) => m.type === type);
    if (idx === -1) {
      this.maintenancePlan.push(this._normMaintain({ type, intervalDays: 0, lastPerformedAt: when }));
    } else {
      this.maintenancePlan[idx].lastPerformedAt = new Date(when).toISOString();
    }
    // If tool was blocked in maintenance status, you may free it:
    if (this.status === "maintenance") this.status = "available";
  }

  /** Schedule/enter maintenance mode (not available until recordMaintenance). */
  sendToMaintenance() {
    this.status = "maintenance";
  }

  /** Open/close repair ticket */
  openRepair({ description = "", severity = "med" } = {}) {
    const t = this._normTicket({ description, severity, status: "open" });
    this.repairTickets.push(t);
    this.condition = "Needs Repair";
    this.status = "maintenance";
    return t;
  }
  closeRepair(ticketId) {
    const t = this.repairTickets.find((x) => x.id === ticketId && x.status !== "closed");
    if (!t) return false;
    t.status = "closed";
    t.closedAt = new Date().toISOString();
    // condition may be improved by caller
    return true;
  }

  /** Compute the next due maintenance/calibration date across plan items. */
  getNextMaintenanceDue() {
    if (!this.maintenancePlan.length) return null;
    const candidates = this.maintenancePlan
      .map((m) => {
        const last = m.lastPerformedAt ? new Date(m.lastPerformedAt) : null;
        const next = last ? new Date(last.getTime() + m.intervalDays * 86400000) : null;
        return next;
      })
      .filter(Boolean)
      .sort((a, b) => a - b);
    return candidates[0] || null;
  }

  // ------------------------------- Usage ------------------------------------

  /** Record a usage event and update lastUsed. */
  recordUse({ workerId = null, taskId = null, minutes = null, notes = "" } = {}) {
    const row = this._normUsage({ workerId, taskId, minutes, notes, at: new Date() });
    this.usageHistory.push(row);
    this.lastUsed = row.at;
    return row;
  }

  /** Utilization minutes in the last N days. */
  utilizationMinutes(windowDays = 30) {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - windowDays);
    return this.usageHistory
      .filter((u) => new Date(u.at) >= cutoff)
      .reduce((acc, u) => acc + (Number(u.minutes || 0)), 0);
  }

  // --------------------------- Matching (skills) ----------------------------

  /**
   * Score this tool against a list of required skills.
   * Returns { score:0..1, matched:string[], missing:string[] }.
   */
  scoreAgainstSkills(requiredSkills = []) {
    const req = (requiredSkills || []).map((s) => String(s).toLowerCase());
    const have = (this.skills || []).map((s) => String(s).toLowerCase());
    if (!req.length) return { score: 0, matched: [], missing: [] };

    const matched = req.filter((r) => have.includes(r));
    const missing = req.filter((r) => !have.includes(r));
    const score = matched.length / req.length;
    return { score, matched, missing };
  }

  /** Convenience: true if tool can satisfy all required skills. */
  canCoverSkills(requiredSkills = []) {
    const { missing } = this.scoreAgainstSkills(requiredSkills);
    return missing.length === 0;
  }

  // ------------------------------ Condition ---------------------------------

  markCondition(newCondition) {
    this.condition = newCondition;
    if (newCondition === "Broken") this.status = "broken";
  }

  // ------------------------------- Serialization ----------------------------

  toJSON() {
    return {
      // original
      id: this.id,
      name: this.name,
      category: this.category,
      quantity: this.quantity,
      condition: this.condition,
      location: this.location,
      notes: this.notes,
      checkedOut: this.checkedOut,
      lastUsed: this.lastUsed,
      createdAt: this.createdAt,

      // new
      assetTag: this.assetTag,
      status: this.status,
      skills: this.skills,
      roles: this.roles,
      tags: this.tags,
      power: this.power,
      attachments: this.attachments,

      safety: this.safety,
      maintenancePlan: this.maintenancePlan,
      repairTickets: this.repairTickets,

      reservations: this.reservations,
      checkouts: this.checkouts,
      usageHistory: this.usageHistory,

      sku: this.sku,
      vendor: this.vendor,
      purchaseDate: this.purchaseDate,
      purchasePrice: this.purchasePrice
    };
  }

  static fromJSON(json = {}) {
    return new ToolInventory(json);
  }
}
