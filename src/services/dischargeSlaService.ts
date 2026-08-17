// Discharge SLA / ETA engine.
//
// The backend is the source of truth for phase status, deadlines and ETA — the
// frontend renders what this computes and never derives it itself.
//
// Phases keep the existing parallel-group model: groups 1-3 run concurrently,
// System Checkout (g4) waits on all of them, Physical Checkout (g5) runs
// alongside g4 (a patient can move to the lounge before system checkout).
// Within a group, phases unlock one at a time.

import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import type { StepKey } from "./dischargeService.js";

export interface PhaseConfig {
  id: number;
  phase_key: StepKey;
  label: string;
  department: string | null;
  expected_minutes: number;
  sort_order: number;
}

/** Parallel groups — mirrors DischargeTab.jsx GROUP_LABELS. */
export const STEP_GROUP: Record<StepKey, number> = {
  DISCHARGE_INITIATION: 1,
  DISCHARGE_DOC: 1,
  DRUG_RETURN: 2,
  PHARMACY_CLEARANCE: 2,
  PROCEDURE_RECONCILIATION: 2,
  BILLING_STARTED: 3,
  AUDIT: 3,
  BILL_READY: 3,
  PAYMENT: 3,
  SYSTEM_CHECKOUT: 4,
  PHYSICAL_CHECKOUT: 5,
};

/** Phases in group order — the sequence a phase unlocks within its own group. */
export const GROUP_STEPS: Record<number, StepKey[]> = {
  1: ["DISCHARGE_INITIATION", "DISCHARGE_DOC"],
  2: ["DRUG_RETURN", "PHARMACY_CLEARANCE", "PROCEDURE_RECONCILIATION"],
  3: ["BILLING_STARTED", "AUDIT", "BILL_READY", "PAYMENT"],
  4: ["SYSTEM_CHECKOUT"],
  5: ["PHYSICAL_CHECKOUT"],
};

export const ALL_STEPS = Object.keys(STEP_GROUP) as StepKey[];

/** Steps that complete automatically at initiation — excluded from delayed warnings and progress counts. */
const AUTO_STEPS = new Set<StepKey>(["DISCHARGE_INITIATION"]);

const snake = (k: StepKey) => k.toLowerCase();
export const startedCol   = (k: StepKey) => `${snake(k)}_started_at`;
export const completedCol = (k: StepKey) => `${snake(k)}_completed_at`;
export const statusCol    = (k: StepKey) => `${snake(k)}_status`;

// ── Config (COO-editable SLAs) ───────────────────────────────────────────────
// Cached because list endpoints decorate many rows per request. Invalidated on
// every write, so a COO change takes effect on the next request.

let cache: { rows: PhaseConfig[]; at: number } | null = null;
const CACHE_MS = 30_000;

// ── Payer TAT config ─────────────────────────────────────────────────────────

export interface PayerTatRow {
  id: number;
  payer_type: string;
  phase_key: string | null;
  target_minutes: number;
}

let payerCache: { rows: PayerTatRow[]; at: number } | null = null;

export function invalidatePayerTatCache() { payerCache = null; }

export async function listPayerTatConfig(): Promise<PayerTatRow[]> {
  if (payerCache && Date.now() - payerCache.at < CACHE_MS) return payerCache.rows;
  const rows = await db.prepare(
    `SELECT id, payer_type, phase_key, target_minutes FROM payer_tat_config ORDER BY payer_type, phase_key NULLS FIRST`
  ).all<PayerTatRow>();
  payerCache = { rows, at: Date.now() };
  return rows;
}

/** Splits a flat payer_tat_config list into two lookup maps. */
export function buildPayerMaps(rows: PayerTatRow[]): {
  stepOverrides: Map<string, Map<string, number>>;
  overallTargets: Map<string, number>;
} {
  const stepOverrides = new Map<string, Map<string, number>>();
  const overallTargets = new Map<string, number>();
  for (const r of rows) {
    if (r.phase_key === null) {
      overallTargets.set(r.payer_type, r.target_minutes);
    } else {
      if (!stepOverrides.has(r.payer_type)) stepOverrides.set(r.payer_type, new Map());
      stepOverrides.get(r.payer_type)!.set(r.phase_key, r.target_minutes);
    }
  }
  return { stepOverrides, overallTargets };
}

/** Returns a new config array with payer-specific step SLA overrides applied. */
export function applyPayerConfig(
  config: PhaseConfig[],
  payerType: string | null,
  stepOverrides: Map<string, Map<string, number>>,
): PhaseConfig[] {
  if (!payerType) return config;
  const overrides = stepOverrides.get(payerType);
  if (!overrides || overrides.size === 0) return config;
  return config.map(c => {
    const ov = overrides.get(c.phase_key);
    return ov !== undefined ? { ...c, expected_minutes: ov } : c;
  });
}

export function invalidatePhaseConfigCache() { cache = null; }

export async function listPhaseConfig(): Promise<PhaseConfig[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows = await db.prepare(
    `SELECT id, phase_key, label, department, expected_minutes, sort_order
     FROM discharge_phase_config ORDER BY sort_order, id`
  ).all<PhaseConfig>();
  cache = { rows, at: Date.now() };
  return rows;
}

export async function updatePhaseConfig(opts: {
  id: number; label?: string; department?: string | null;
  expectedMinutes?: number; userId: number;
}) {
  const row = await db.prepare("SELECT * FROM discharge_phase_config WHERE id=?")
    .get<PhaseConfig>(opts.id);
  if (!row) throw new HttpError(404, "Discharge phase not found");

  const sets: string[] = [];
  const params: unknown[] = [];
  if (opts.label !== undefined)      { sets.push("label=?");            params.push(opts.label); }
  if (opts.department !== undefined) { sets.push("department=?");       params.push(opts.department); }
  if (opts.expectedMinutes !== undefined) {
    if (opts.expectedMinutes < 0) throw new HttpError(400, "Expected duration cannot be negative");
    sets.push("expected_minutes=?"); params.push(opts.expectedMinutes);
  }
  if (sets.length === 0) return { ok: true };

  sets.push("updated_at=?"); params.push(Date.now());
  params.push(opts.id);
  await db.prepare(`UPDATE discharge_phase_config SET ${sets.join(", ")} WHERE id=?`).run(...params);
  invalidatePhaseConfigCache();
  await audit(opts.userId, "discharge_phase_config_update", "discharge_phase_config", {
    id: opts.id, phase: row.phase_key,
    label: opts.label, department: opts.department, expectedMinutes: opts.expectedMinutes,
  });
  return { ok: true };
}

export async function reorderPhaseConfig(opts: { id: number; direction: "up" | "down"; userId: number }) {
  const row = await db.prepare("SELECT id, sort_order FROM discharge_phase_config WHERE id=?")
    .get<{ id: number; sort_order: number }>(opts.id);
  if (!row) throw new HttpError(404, "Discharge phase not found");

  const neighbour = opts.direction === "up"
    ? await db.prepare("SELECT id, sort_order FROM discharge_phase_config WHERE sort_order < ? ORDER BY sort_order DESC LIMIT 1").get<{ id: number; sort_order: number }>(row.sort_order)
    : await db.prepare("SELECT id, sort_order FROM discharge_phase_config WHERE sort_order > ? ORDER BY sort_order ASC LIMIT 1").get<{ id: number; sort_order: number }>(row.sort_order);
  if (!neighbour) return { ok: true };

  await db.transaction(async () => {
    await db.prepare("UPDATE discharge_phase_config SET sort_order=? WHERE id=?").run(neighbour.sort_order, opts.id);
    await db.prepare("UPDATE discharge_phase_config SET sort_order=? WHERE id=?").run(row.sort_order, neighbour.id);
  });
  invalidatePhaseConfigCache();
  return { ok: true };
}

// ── Workflow computation ─────────────────────────────────────────────────────

export type PhaseState = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "NOT_APPLICABLE" | "DELAYED";

export interface PhaseView {
  key: StepKey;
  label: string;
  department: string | null;
  group: number;
  expectedMinutes: number;
  state: PhaseState;
  startedAt: number | null;
  completedAt: number | null;
  deadline: number | null;
  /** Minutes past deadline; 0 when on time. */
  overdueMinutes: number;
  /** Minutes the phase actually took, once completed. */
  actualMinutes: number | null;
}

export interface WorkflowView {
  phases: PhaseView[];
  /** Phases currently open and started — the ones being worked right now. */
  current: StepKey[];
  delayed: StepKey[];
  /** Overall: ON_TIME while nothing is past its deadline. */
  state: "ON_TIME" | "DELAYED" | "COMPLETED";
  /** Estimated discharge time (epoch ms), null once complete. */
  eta: number | null;
  etaMinutes: number | null;
  /** Fixed expected discharge time (epoch ms) = initiated_at + critical-path TAT sum. */
  expectedTime: number | null;
  done: number;
  total: number;
  pct: number;
  /** Payer type of this admission (from bed_details). Set by decorateMany. */
  payerType?: string | null;
  /** Overall TAT benchmark for this payer (minutes). Reporting use only — colours the TAT Leaderboard. */
  payerTargetMinutes?: number | null;
}

type TrackingRow = Record<string, unknown> & { status?: string };

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/**
 * Compute the full workflow view for one tracking row.
 * `now` is injectable so the scheduler and tests can evaluate at a fixed instant.
 */
export function computeWorkflow(
  tracking: TrackingRow | null | undefined,
  config: PhaseConfig[],
  now = Date.now(),
): WorkflowView | null {
  if (!tracking) return null;
  const live = ["DISCHARGE_INITIATED", "IN_PROGRESS"].includes(String(tracking.status));
  const finished = tracking.status === "COMPLETED";
  if (!live && !finished) return null;   // PLANNED / CANCELLED have no running workflow

  const byKey = new Map(config.map(c => [c.phase_key, c]));

  const phases: PhaseView[] = ALL_STEPS.map((key) => {
    const cfg = byKey.get(key);
    const expectedMinutes = cfg?.expected_minutes ?? 15;
    const rawStatus = String(tracking[statusCol(key)] ?? "PENDING");
    const startedAt = num(tracking[startedCol(key)]);
    const completedAt = num(tracking[completedCol(key)]);
    const deadline = startedAt !== null ? startedAt + expectedMinutes * 60_000 : null;

    let state: PhaseState;
    if (rawStatus === "NOT_APPLICABLE") state = "NOT_APPLICABLE";
    else if (rawStatus === "COMPLETED") state = "COMPLETED";
    else if (startedAt === null) state = "NOT_STARTED";
    else if (deadline !== null && now > deadline) state = "DELAYED";
    else state = "IN_PROGRESS";

    const overdueMinutes = state === "DELAYED" && deadline !== null
      ? Math.floor((now - deadline) / 60_000) : 0;
    const actualMinutes = completedAt !== null && startedAt !== null
      ? Math.max(0, Math.round((completedAt - startedAt) / 60_000)) : null;

    return {
      key,
      label: cfg?.label ?? key,
      department: cfg?.department ?? null,
      group: STEP_GROUP[key],
      expectedMinutes, state, startedAt, completedAt, deadline,
      overdueMinutes, actualMinutes,
    };
  });

  const isDone = (p: PhaseView) => p.state === "COMPLETED" || p.state === "NOT_APPLICABLE";

  // Remaining minutes for a group: phases within a group are sequential, so
  // every incomplete phase contributes to the group's remaining time.
  // Overdue phases contribute their original SLA — "once acted on, it'll
  // take the normal time" — instead of the overdue duration which would
  // make the ETA grow unboundedly (e.g. Physical Checkout idle 30h).
  const groupRemaining = (group: number): number => {
    let mins = 0;
    for (const p of phases) {
      if (p.group !== group || isDone(p)) continue;
      if (p.startedAt !== null && p.deadline !== null) {
        const left = Math.ceil((p.deadline - now) / 60_000);
        if (left > 0) {
          mins += left;
        } else {
          mins += p.expectedMinutes;
        }
      } else {
        mins += p.expectedMinutes;
      }
    }
    return mins;
  };

  // Critical path: groups 1-3 overlap, then checkout. g5 runs alongside g4.
  const parallelHead = Math.max(groupRemaining(1), groupRemaining(2), groupRemaining(3));
  const tail = Math.max(groupRemaining(4), groupRemaining(5));
  const etaMinutes = parallelHead + tail;

  // Fixed expected time: initiated_at + critical-path TAT sum (never changes).
  // Group 2 → Group 3 is serial (Bill Prep waits on PHC+PR).
  // Within group 2: DRUG_RETURN is sequential, then PHC and PR run in parallel.
  const initiatedAt = num(tracking.initiated_at);
  const tat = (key: StepKey) => {
    const p = phases.find(ph => ph.key === key);
    return p && p.state !== "NOT_APPLICABLE" ? p.expectedMinutes : 0;
  };
  const g1Total = tat("DISCHARGE_INITIATION") + tat("DISCHARGE_DOC");
  const g2Total = tat("DRUG_RETURN") + Math.max(tat("PHARMACY_CLEARANCE"), tat("PROCEDURE_RECONCILIATION"));
  const g3Total = tat("BILLING_STARTED") + tat("AUDIT") + tat("BILL_READY") + tat("PAYMENT");
  const g4Total = tat("SYSTEM_CHECKOUT");
  const g5Total = tat("PHYSICAL_CHECKOUT");
  const criticalPathMinutes = Math.max(g1Total, g2Total + g3Total) + g4Total + g5Total;
  const expectedTime = initiatedAt != null ? initiatedAt + criticalPathMinutes * 60_000 : null;

  const counted = phases.filter(p => p.state !== "NOT_APPLICABLE" && !AUTO_STEPS.has(p.key));
  const done = counted.filter(p => p.state === "COMPLETED").length;
  const total = counted.length;
  const delayed = phases.filter(p => p.state === "DELAYED" && !AUTO_STEPS.has(p.key)).map(p => p.key);
  const current = phases.filter(p => (p.state === "IN_PROGRESS" || p.state === "DELAYED") && !AUTO_STEPS.has(p.key)).map(p => p.key);

  return {
    phases, current, delayed,
    state: finished ? "COMPLETED" : delayed.length > 0 ? "DELAYED" : "ON_TIME",
    eta: finished ? null : now + etaMinutes * 60_000,
    etaMinutes: finished ? null : etaMinutes,
    expectedTime,
    done, total,
    pct: total ? Math.round((done / total) * 100) : 0,
  };
}

/** Attach `workflow` to a tracking row (or to a row that embeds one). */
export function withWorkflow<T extends TrackingRow>(row: T, config: PhaseConfig[], now = Date.now()) {
  return { ...row, workflow: computeWorkflow(row, config, now) };
}

/** Decorate a list of rows with one config fetch, applying per-row payer overrides. */
export async function decorateMany<T extends TrackingRow & { payer_type?: string | null }>(rows: T[]) {
  const [config, payerRows] = await Promise.all([listPhaseConfig(), listPayerTatConfig()]);
  const { stepOverrides, overallTargets } = buildPayerMaps(payerRows);
  const now = Date.now();
  return rows.map(r => {
    const pt = (r.payer_type as string | null) ?? null;
    const effectiveConfig = applyPayerConfig(config, pt, stepOverrides);
    const wf = computeWorkflow(r, effectiveConfig, now);
    const workflow: WorkflowView | null = wf ? {
      ...wf,
      payerType: pt,
      payerTargetMinutes: pt ? (overallTargets.get(pt) ?? null) : null,
    } : null;
    return { ...r, workflow };
  });
}

// ── Phase start bookkeeping ──────────────────────────────────────────────────

/**
 * SQL fragment starting every group-leading phase. Called when a discharge is
 * initiated — groups 1, 2, 3 and 5 all open at once; group 4 (System Checkout)
 * only opens once its prerequisites clear.
 */
export function initialStartSql(now: number): { sql: string; params: unknown[] } {
  const leads: StepKey[] = ["DISCHARGE_INITIATION", "DRUG_RETURN"];
  const sets = leads.map(k => `${startedCol(k)} = COALESCE(${startedCol(k)}, ?)`);
  return { sql: sets.join(", "), params: leads.map(() => now) };
}

/**
 * Phases that fan out from a single predecessor — when `from` completes,
 * all listed successors start in parallel (instead of the default sequential
 * "next sibling in the group array" behaviour).
 */
const PARALLEL_SUCCESSORS: Partial<Record<StepKey, StepKey[]>> = {
  DRUG_RETURN: ["PHARMACY_CLEARANCE", "PROCEDURE_RECONCILIATION"],
};

/**
 * The phase(s) that should start when `completed` finishes. Returns an array
 * because some steps fan out to multiple parallel successors.
 * System Checkout is special — it opens only when every group 1-3 phase is done.
 */
export function nextPhasesToStart(completed: StepKey, tracking: TrackingRow): StepKey[] {
  const result: StepKey[] = [];

  // Check for explicit parallel fan-out first
  const parallel = PARALLEL_SUCCESSORS[completed];
  if (parallel) {
    for (const k of parallel) {
      if (tracking[startedCol(k)] == null) result.push(k);
    }
  } else {
    // Default: next sequential sibling in the same group
    const group = STEP_GROUP[completed];
    const siblings = GROUP_STEPS[group] ?? [];
    const idx = siblings.indexOf(completed);
    const next = siblings[idx + 1];
    // Skip if this step fans out to parallel successors (already handled above)
    if (next && tracking[startedCol(next)] == null && !Object.values(PARALLEL_SUCCESSORS).some(arr => arr.includes(next))) {
      result.push(next);
    }
  }

  // Bill Prep (BILLING_STARTED) unlocks only when BOTH Pharmacy Clearance and
  // Procedure Reconciliation are done. Its start time = now (the later of the two).
  if (tracking[startedCol("BILLING_STARTED")] == null &&
      (completed === "PHARMACY_CLEARANCE" || completed === "PROCEDURE_RECONCILIATION")) {
    const sibling = completed === "PHARMACY_CLEARANCE" ? "PROCEDURE_RECONCILIATION" : "PHARMACY_CLEARANCE";
    const siblingStatus = String(tracking[statusCol(sibling)] ?? "PENDING");
    if (siblingStatus === "COMPLETED" || siblingStatus === "NOT_APPLICABLE") {
      result.push("BILLING_STARTED");
    }
  }

  // Does completing this step unlock System Checkout?
  // `completed !== "SYSTEM_CHECKOUT"` is load-bearing, not a tidy-up. A row can
  // reach "groups 1-3 all done, system_checkout_started_at still NULL" — the
  // force-complete paths write step statuses without stamping SLA columns — and
  // completing System Checkout from there made this block return the step as its
  // OWN successor. updateStep then emitted system_checkout_started_at twice in
  // one SET clause, which Postgres rejects outright (42601, "multiple
  // assignments to same column"), so the save failed with a 500.
  if (completed !== "SYSTEM_CHECKOUT" && tracking[startedCol("SYSTEM_CHECKOUT")] == null) {
    const blockers = [...GROUP_STEPS[1], ...GROUP_STEPS[2], ...GROUP_STEPS[3]];
    const allClear = blockers.every((k) => {
      const v = k === completed ? "COMPLETED" : String(tracking[statusCol(k)] ?? "PENDING");
      return v === "COMPLETED" || v === "NOT_APPLICABLE";
    });
    if (allClear) result.push("SYSTEM_CHECKOUT");
  }

  // Physical Checkout timer starts only when System Checkout completes.
  if (completed === "SYSTEM_CHECKOUT" && tracking[startedCol("PHYSICAL_CHECKOUT")] == null) {
    result.push("PHYSICAL_CHECKOUT");
  }

  // updateStep turns every entry into its own SET assignment, so it cannot
  // tolerate `completed` appearing here, nor the same key twice — either one
  // yields a duplicate column and Postgres rejects the whole statement. Stating
  // that invariant here keeps the burden off each branch above.
  return [...new Set(result)].filter((k) => k !== completed);
}

/** @deprecated Use nextPhasesToStart instead */
export function nextPhaseToStart(completed: StepKey, tracking: TrackingRow): StepKey | null {
  const all = nextPhasesToStart(completed, tracking);
  return all.length > 0 ? all[0] : null;
}
