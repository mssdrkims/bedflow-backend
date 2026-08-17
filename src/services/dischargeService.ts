import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import { updateBedStatus } from "./bedDetailService.js";
import { getActiveAdmissionByBed, getAdmissionById, closeAdmission, getMyPatientsRow, type PatientAdmission } from "./patientAdmissionService.js";
import { initialStartSql, nextPhasesToStart, startedCol, completedCol, ALL_STEPS } from "./dischargeSlaService.js";
import { consultantRoomsFor } from "./consultantGroupService.js";
import { emitConsultantPatientUpdate } from "../websocket/io.js";
import type { Role } from "../types/index.js";

/** Builds the shared "scope to these wards" WHERE fragment used by every
 *  discharge list/count query below. extraAdmissionIds widens the match to
 *  also include specific admissions by id regardless of their current
 *  ward_id — needed for Discharge Lounge patients when a Unit filter is
 *  active: their pa.ward_id becomes the Lounge ward's id after transfer
 *  (bedTransferService.ts), which would otherwise make them invisible to a
 *  unit-scoped filter. Callers resolve which lounge admissions actually
 *  originated from the selected unit via bedService.ts's
 *  loungeOriginAdmissionIds() and pass their ids here. */
function wardScopeSql(wardIds: number[] | null, extraAdmissionIds?: number[] | null): { clause: string; params: unknown[] } {
  if (!wardIds) return { clause: "", params: [] };
  if (extraAdmissionIds?.length) return { clause: "AND (pa.ward_id = ANY(?) OR pa.id = ANY(?))", params: [wardIds, extraAdmissionIds] };
  return { clause: "AND pa.ward_id = ANY(?)", params: [wardIds] };
}

export interface DischargeTracking {
  id: number;
  admission_id: number;
  status: "PLANNED" | "DISCHARGE_INITIATED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  planned_date: string;
  planned_time: string | null;
  planned_by: number | null;
  prompted_at: number | null;
  initiated_at: number | null;
  discharge_initiation_status: string;
  discharge_doc_status: string;
  drug_return_status: string;
  pharmacy_clearance_status: string;
  procedure_reconciliation_status: string;
  billing_started_status: string;
  audit_status: string;
  bill_ready_status: string;
  payment_status: string;
  system_checkout_status: string;
  physical_checkout_status: string;
  patient_left: boolean | null;
  created_by: number | null;
  created_at: number;
  updated_at: number;
}

export type StepKey =
  | "DISCHARGE_INITIATION" | "DISCHARGE_DOC" | "DRUG_RETURN" | "PHARMACY_CLEARANCE" | "PROCEDURE_RECONCILIATION"
  | "BILLING_STARTED" | "AUDIT" | "BILL_READY" | "PAYMENT" | "SYSTEM_CHECKOUT" | "PHYSICAL_CHECKOUT";

const STEP_COLUMN: Record<StepKey, string> = {
  DISCHARGE_INITIATION: "discharge_initiation_status",
  DISCHARGE_DOC: "discharge_doc_status",
  DRUG_RETURN: "drug_return_status",
  PHARMACY_CLEARANCE: "pharmacy_clearance_status",
  PROCEDURE_RECONCILIATION: "procedure_reconciliation_status",
  BILLING_STARTED: "billing_started_status",
  AUDIT: "audit_status",
  BILL_READY: "bill_ready_status",
  PAYMENT: "payment_status",
  SYSTEM_CHECKOUT: "system_checkout_status",
  PHYSICAL_CHECKOUT: "physical_checkout_status",
};

// Roles allowed to update each step. "Wrong checklist update" is explicitly
// allowed by the spec (edit + save history) — there is no enforced step
// ordering here, only who is allowed to touch a given step.
export const STEP_PERMISSIONS: Record<StepKey, Role[]> = {
  DISCHARGE_INITIATION: ["PRE", "DOCTOR", "CONSULTANT"],
  DISCHARGE_DOC: ["PRE", "DOCTOR", "CONSULTANT"],
  DRUG_RETURN: ["PRE", "NURSE", "PHARMACY", "MASTER_PHARMACY"],
  PHARMACY_CLEARANCE: ["PRE", "NURSE", "PHARMACY", "MASTER_PHARMACY"],
  PROCEDURE_RECONCILIATION: ["PRE", "PHARMACY", "MASTER_PHARMACY"],
  BILLING_STARTED: ["PRE", "FC", "MASTER_FC"],
  AUDIT: ["PRE", "FC", "MASTER_FC"],
  BILL_READY: ["PRE", "FC", "MASTER_FC"],
  PAYMENT: ["PRE", "FC", "MASTER_FC"],
  SYSTEM_CHECKOUT: ["PRE", "FC", "MASTER_FC"],
  PHYSICAL_CHECKOUT: ["PRE", "NURSE"],
};

const STEP_LABELS: Record<StepKey, string> = {
  DISCHARGE_INITIATION: "Discharge Initiation",
  DISCHARGE_DOC: "Discharge Summary",
  DRUG_RETURN: "Drug Return",
  PHARMACY_CLEARANCE: "Pharmacy Clearance",
  PROCEDURE_RECONCILIATION: "Procedure Reconciliation",
  BILLING_STARTED: "Bill Prep",
  AUDIT: "Audit",
  BILL_READY: "Bill Finalized",
  PAYMENT: "Payment Status",
  SYSTEM_CHECKOUT: "System Checkout",
  PHYSICAL_CHECKOUT: "Physical Checkout",
};

// Every step System Checkout must wait on — everything except itself and Physical
// Checkout (which happens after/parallel to it, not before it).
const PRE_SYSTEM_CHECKOUT_STEPS: StepKey[] = [
  "DISCHARGE_DOC", "DRUG_RETURN", "PHARMACY_CLEARANCE", "PROCEDURE_RECONCILIATION",
  "BILLING_STARTED", "AUDIT", "BILL_READY", "PAYMENT",
];

const STEP_VALUES: Record<StepKey, string[]> = {
  DISCHARGE_INITIATION: ["PENDING", "COMPLETED"],
  DISCHARGE_DOC: ["PENDING", "COMPLETED"],
  DRUG_RETURN: ["PENDING", "COMPLETED"],
  PHARMACY_CLEARANCE: ["PENDING", "COMPLETED"],
  PROCEDURE_RECONCILIATION: ["PENDING", "COMPLETED", "NOT_APPLICABLE"],
  BILLING_STARTED: ["PENDING", "COMPLETED"],
  AUDIT: ["PENDING", "COMPLETED"],
  BILL_READY: ["PENDING", "COMPLETED"],
  PAYMENT: ["PENDING", "COMPLETED"],
  SYSTEM_CHECKOUT: ["PENDING", "COMPLETED"],
  PHYSICAL_CHECKOUT: ["PENDING", "COMPLETED"],
};

// CONSULTANT plans/initiates only for their own patients — ownership is enforced
// upstream in discharge.ts (consultantOwnsBed / consultantOwnsAdmission).
const PLAN_ROLES: Role[] = ["PRE", "DOCTOR", "CONSULTANT"];
const RESCHEDULE_ROLES: Role[] = ["PRE", "DOCTOR", "CONSULTANT"];
const CANCEL_ROLES: Role[] = ["PRE", "DOCTOR", "CONSULTANT"];
const INITIATE_ROLES: Role[] = ["PRE", "DOCTOR", "CONSULTANT"];

function requireRoleIn(role: Role, allowed: Role[], action: string) {
  if (!allowed.includes(role))
    throw new HttpError(403, `${action} requires role: ${allowed.join(" or ")}`);
}

async function logHistory(opts: {
  admissionId: number; trackingId: number | null; field: string;
  oldValue: unknown; newValue: unknown; userId: number | null; reason?: string | null;
}) {
  await db.prepare(
    `INSERT INTO discharge_history (admission_id, discharge_tracking_id, field, old_value, new_value, changed_by, changed_at, reason)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    opts.admissionId, opts.trackingId, opts.field,
    opts.oldValue === undefined || opts.oldValue === null ? null : String(opts.oldValue),
    opts.newValue === undefined || opts.newValue === null ? null : String(opts.newValue),
    opts.userId, Date.now(), opts.reason ?? null,
  );
}

export async function getTrackingByAdmission(admissionId: number): Promise<DischargeTracking | undefined> {
  return db.prepare("SELECT * FROM discharge_tracking WHERE admission_id=?").get<DischargeTracking>(admissionId);
}

async function getTrackingById(trackingId: number): Promise<DischargeTracking | undefined> {
  return db.prepare("SELECT * FROM discharge_tracking WHERE id=?").get<DischargeTracking>(trackingId);
}

function isValidDate(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** For the discharge view of a bed: active admission (if any) + its tracking row. */
export async function getDischargeForBed(bedId: number) {
  const admission = await getActiveAdmissionByBed(bedId);
  if (!admission) return { admission: null, tracking: null };
  const tracking = await getTrackingByAdmission(admission.id);
  return { admission, tracking: tracking ?? null };
}

/** Every active admission in a ward with its discharge tracking (if any) — powers the
 *  ward card's "Discharge" button, which shows everything in flight for that ward. */
export async function dischargesForWard(wardId: number) {
  return db.prepare(`
    SELECT pa.id AS admission_id, pa.bed_id, bd.bed_name, pa.ip_last6, dt.*
    FROM patient_admissions pa
    JOIN bed_details bd ON bd.id = pa.bed_id
    LEFT JOIN discharge_tracking dt ON dt.admission_id = pa.id
    WHERE pa.ward_id = ? AND pa.status = 'ACTIVE'
    ORDER BY bd.bed_name
  `).all(wardId);
}

/** Every discharge that's currently alive (planned or running) across the given wards —
 *  powers the "Discharges" page each role sees. wardIds = null is hospital-wide.
 *  Running discharges come first (most actionable), then planned by nearest date. */
/** consultantDoctorMasterId — CONSULTANT scoping is by admission ownership (individual
 *  or Consultant Group membership), not by ward, so their Discharges page shows only
 *  their own patients — resolved the same way as consultantGroupService.ownsAdmission,
 *  inlined here since this is a list query rather than a single-row check. */
export async function listActiveDischarges(wardIds: number[] | null, consultantDoctorMasterId?: number | null, extraAdmissionIds?: number[] | null) {
  const params: unknown[] = [];
  let scopeClause = "";
  const wardScope = wardScopeSql(wardIds, extraAdmissionIds);
  if (wardScope.clause) { scopeClause += " " + wardScope.clause; params.push(...wardScope.params); }
  if (consultantDoctorMasterId) {
    scopeClause += ` AND ((pa.owner_type='DOCTOR' AND pa.doctor_id = ?)
      OR (pa.owner_type='GROUP' AND EXISTS (
            SELECT 1 FROM consultant_group_members m
            WHERE m.group_id = pa.consultant_group_id AND m.doctor_id = ?)))`;
    params.push(consultantDoctorMasterId, consultantDoctorMasterId);
  }

  return db.prepare(`
    SELECT dt.*, pa.id AS admission_id, pa.bed_id, pa.ward_id, pa.ip_last6,
           bd.bed_name, bd.payer_type, w.name AS ward_name
    FROM discharge_tracking dt
    JOIN patient_admissions pa ON pa.id = dt.admission_id
    JOIN bed_details bd ON bd.id = pa.bed_id
    JOIN wards w ON w.id = pa.ward_id
    WHERE pa.status='ACTIVE' AND dt.status IN ('PLANNED','DISCHARGE_INITIATED','IN_PROGRESS')
      ${scopeClause}
    ORDER BY (dt.status = 'PLANNED') ASC, dt.planned_date ASC, w.name, bd.bed_name
  `).all(...params);
}

/** Admissions where the given step is PENDING and the discharge is actually running —
 *  the actionable queue behind FC's Bill Finalized / Payment Status screen (and reusable for any
 *  other role's "what do I need to act on" list). wardIds = null is hospital-wide. */
export async function listByStepStatus(step: StepKey, status: string, wardIds: number[] | null) {
  const col = STEP_COLUMN[step];
  if (!col) throw new HttpError(400, `Unknown discharge step: ${step}`);
  const allowed = STEP_VALUES[step];
  if (!allowed.includes(status)) throw new HttpError(400, `Invalid status for ${step}`);
  const scopeClause = wardIds ? "AND pa.ward_id = ANY(?)" : "";
  const params: unknown[] = [status, ...(wardIds ? [wardIds] : [])];

  return db.prepare(`
    SELECT dt.*, pa.id AS admission_id, pa.bed_id, pa.ward_id, pa.ip_last6, bd.bed_name, w.name AS ward_name
    FROM discharge_tracking dt
    JOIN patient_admissions pa ON pa.id = dt.admission_id
    JOIN bed_details bd ON bd.id = pa.bed_id
    JOIN wards w ON w.id = pa.ward_id
    WHERE pa.status='ACTIVE' AND dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS')
      AND dt.${col} = ? ${scopeClause}
    ORDER BY dt.updated_at ASC
  `).all(...params);
}

export async function listPendingByStep(step: StepKey, wardIds: number[] | null, extraAdmissionIds?: number[] | null) {
  const col = STEP_COLUMN[step];
  if (!col) throw new HttpError(400, `Unknown discharge step: ${step}`);
  const { clause: scopeClause, params } = wardScopeSql(wardIds, extraAdmissionIds);

  return db.prepare(`
    SELECT dt.*, pa.id AS admission_id, pa.bed_id, pa.ward_id, pa.ip_last6, bd.bed_name, w.name AS ward_name
    FROM discharge_tracking dt
    JOIN patient_admissions pa ON pa.id = dt.admission_id
    JOIN bed_details bd ON bd.id = pa.bed_id
    JOIN wards w ON w.id = pa.ward_id
    WHERE pa.status='ACTIVE' AND dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS')
      AND dt.${col} = 'PENDING' ${scopeClause}
    ORDER BY dt.updated_at ASC
  `).all(...params);
}

export async function listBillingPipeline(wardIds: number[] | null, extraAdmissionIds?: number[] | null) {
  const { clause: scopeClause, params } = wardScopeSql(wardIds, extraAdmissionIds);

  // Payment done but System Checkout still pending is a valid, distinct bucket
  // now (FC's own next step) — the old payment_status != 'COMPLETED' filter
  // would have excluded exactly those rows, so it's widened to also admit them.
  const rows = await db.prepare(`
    SELECT dt.*, pa.id AS admission_id, pa.bed_id, pa.ward_id, pa.ip_last6,
           bd.bed_name, w.name AS ward_name, pa.admitted_at
    FROM discharge_tracking dt
    JOIN patient_admissions pa ON pa.id = dt.admission_id
    JOIN bed_details bd ON bd.id = pa.bed_id
    JOIN wards w ON w.id = pa.ward_id
    WHERE pa.status='ACTIVE' AND dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS')
      AND (dt.payment_status != 'COMPLETED' OR dt.system_checkout_status = 'PENDING')
      ${scopeClause}
    ORDER BY dt.updated_at ASC
  `).all(...params);

  const buckets: Record<string, typeof rows> = {
    SYSTEM_CHECKOUT: [], BILLING_STARTED: [], AUDIT: [], BILL_READY: [], PAYMENT: [],
  };
  for (const r of rows) {
    const row = r as Record<string, unknown>;
    // Every step's *_status column defaults to 'PENDING' the moment a discharge is
    // created — for every future step, not just whichever one is actually next in
    // line. So "status is PENDING" alone doesn't mean this phase is FC's problem
    // yet; it also has to have actually been unlocked (its own *_started_at
    // stamped) — the same signal computeWorkflow() uses for the per-admission
    // Discharge Details view. Without the started_at check, a discharge still
    // stuck on Drug Return/Pharmacy Clearance would show up under Bill Prep
    // Pending before Bill Prep has even opened (its prerequisites gate its start,
    // same as every step here — see nextPhasesToStart in dischargeSlaService.ts).
    if (row.billing_started_status === "PENDING" && row.billing_started_started_at != null) buckets.BILLING_STARTED.push(r);
    else if (row.audit_status === "PENDING" && row.audit_started_at != null) buckets.AUDIT.push(r);
    else if (row.bill_ready_status === "PENDING" && row.bill_ready_started_at != null) buckets.BILL_READY.push(r);
    else if (row.payment_status === "PENDING" && row.payment_started_at != null) buckets.PAYMENT.push(r);
    else if (row.system_checkout_status === "PENDING" && row.system_checkout_started_at != null) buckets.SYSTEM_CHECKOUT.push(r);
  }
  return buckets;
}

/** Shared by every discharge-workflow mutation that doesn't already emit its own
 *  My Patients event (plan/reschedule/cancel-plan/initiate/cancel-after-initiation)
 *  — one line per call site instead of duplicating the owner/room/row lookup. */
async function emitMyPatientsUpdate(admissionId: number) {
  const admission = await getAdmissionById(admissionId);
  const rooms = admission ? consultantRoomsFor(admission) : [];
  if (!rooms.length) return;
  const row = await getMyPatientsRow(admissionId);
  if (row) emitConsultantPatientUpdate(rooms, { type: "UPDATED", action: "UPSERT", ...row });
}

export async function planDischarge(opts: {
  bedId: number; plannedDate: string; plannedTime?: string | null; userId: number; role: Role;
}): Promise<DischargeTracking> {
  requireRoleIn(opts.role, PLAN_ROLES, "Planning a discharge");
  if (!isValidDate(opts.plannedDate)) throw new HttpError(400, "planned_date must be YYYY-MM-DD");

  const admission = await getActiveAdmissionByBed(opts.bedId);
  if (!admission) throw new HttpError(404, "No active patient admission for this bed");

  const existing = await getTrackingByAdmission(admission.id);
  if (existing && !["CANCELLED"].includes(existing.status))
    throw new HttpError(409, "This admission already has a discharge in progress");

  const now = Date.now();
  // The patient may already have physically left (e.g. moved to the Discharge Lounge
  // via a manual Bed Transfer before any discharge was planned) — physically_left_at
  // is the source of truth for that, independent of this tracking row's existence.
  const alreadyLeft = admission.physically_left_at != null;
  const row = await db.prepare(
    `INSERT INTO discharge_tracking (admission_id, status, planned_date, planned_time, planned_by, created_by, created_at, updated_at,
       physical_checkout_status, patient_left)
     VALUES (?, 'PLANNED', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).run(admission.id, opts.plannedDate, opts.plannedTime ?? null, opts.userId, opts.userId, now, now,
    alreadyLeft ? "COMPLETED" : "PENDING", alreadyLeft ? true : null);
  const trackingId = Number(row.lastInsertRowid);

  await logHistory({
    admissionId: admission.id, trackingId, field: "plan",
    oldValue: null, newValue: `${opts.plannedDate} ${opts.plannedTime ?? ""}`.trim(), userId: opts.userId,
  });
  await audit(opts.userId, "discharge_plan", String(admission.id), { bedId: opts.bedId, plannedDate: opts.plannedDate, plannedTime: opts.plannedTime });

  await emitMyPatientsUpdate(admission.id);
  return (await getTrackingById(trackingId))!;
}

export async function reschedule(opts: {
  admissionId: number; plannedDate: string; plannedTime?: string | null; reason?: string | null; userId: number; role: Role;
}): Promise<DischargeTracking> {
  requireRoleIn(opts.role, RESCHEDULE_ROLES, "Rescheduling a discharge");
  if (!isValidDate(opts.plannedDate)) throw new HttpError(400, "planned_date must be YYYY-MM-DD");

  const tracking = await getTrackingByAdmission(opts.admissionId);
  if (!tracking) throw new HttpError(404, "No discharge plan found for this admission");
  if (["COMPLETED", "CANCELLED"].includes(tracking.status))
    throw new HttpError(409, `Cannot reschedule a discharge that is already ${tracking.status.toLowerCase()}`);

  const oldValue = `${tracking.planned_date} ${tracking.planned_time ?? ""}`.trim();
  const newValue = `${opts.plannedDate} ${opts.plannedTime ?? ""}`.trim();
  const now = Date.now();
  await db.transaction(async () => {
    const r = await db.prepare(
      "UPDATE discharge_tracking SET planned_date=?, planned_time=?, status='PLANNED', prompted_at=NULL, updated_at=? WHERE id=? AND updated_at=?"
    ).run(opts.plannedDate, opts.plannedTime ?? null, now, tracking.id, tracking.updated_at);
    if (r.changes === 0) throw new HttpError(409, "This discharge was just updated by someone else. Please refresh and try again.");

    await logHistory({
      admissionId: opts.admissionId, trackingId: tracking.id, field: "reschedule",
      oldValue, newValue, userId: opts.userId, reason: opts.reason,
    });
    await audit(opts.userId, "discharge_reschedule", String(opts.admissionId), { from: oldValue, to: newValue, reason: opts.reason });
  });

  await emitMyPatientsUpdate(opts.admissionId);
  return (await getTrackingById(tracking.id))!;
}

export async function cancelPlan(opts: { admissionId: number; reason?: string | null; userId: number; role: Role }): Promise<void> {
  requireRoleIn(opts.role, CANCEL_ROLES, "Cancelling a discharge plan");
  const tracking = await getTrackingByAdmission(opts.admissionId);
  if (!tracking) throw new HttpError(404, "No discharge plan found for this admission");
  if (tracking.status !== "PLANNED")
    throw new HttpError(409, "Only a discharge that hasn't started yet can be cancelled this way");

  const now = Date.now();
  await db.transaction(async () => {
    const r = await db.prepare("UPDATE discharge_tracking SET status='CANCELLED', updated_at=? WHERE id=? AND updated_at=?").run(now, tracking.id, tracking.updated_at);
    if (r.changes === 0) throw new HttpError(409, "This discharge was just updated by someone else. Please refresh and try again.");

    await logHistory({
      admissionId: opts.admissionId, trackingId: tracking.id, field: "status",
      oldValue: tracking.status, newValue: "CANCELLED", userId: opts.userId, reason: opts.reason,
    });
    await audit(opts.userId, "discharge_cancel_plan", String(opts.admissionId), { reason: opts.reason });
  });

  await emitMyPatientsUpdate(opts.admissionId);
}

export async function initiateDischarge(opts: { admissionId: number; userId: number; role: Role }): Promise<DischargeTracking> {
  requireRoleIn(opts.role, INITIATE_ROLES, "Starting a discharge");
  const tracking = await getTrackingByAdmission(opts.admissionId);
  if (!tracking) throw new HttpError(404, "No discharge plan found for this admission");
  if (tracking.status !== "PLANNED" && tracking.status !== "CANCELLED")
    throw new HttpError(409, `Cannot start — discharge is already ${tracking.status}`);

  const now = Date.now();

  // Snapshot payer_type from the bed at initiation time — after discharge the
  // bed is vacated and bed_details.payer_type is cleared to NULL, so we need
  // to capture it now while the patient is still in the bed.
  const admRow = await db.prepare(
    `SELECT bd.payer_type FROM patient_admissions pa
     JOIN bed_details bd ON bd.id = pa.bed_id
     WHERE pa.id = ?`
  ).get<{ payer_type: string | null }>(opts.admissionId);
  const payerType = admRow?.payer_type ?? null;

  // Starting the discharge opens every group-leading phase at once — that start
  // stamp is what the SLA deadline and ETA are measured from.
  // DISCHARGE_INITIATION is auto-completed at initiation — the "Initiate Now"
  // action IS the discharge initiation step, so it's instantly done.
  const { sql: startSql, params: startParams } = initialStartSql(now);
  await db.transaction(async () => {
    const r = await db.prepare(
      `UPDATE discharge_tracking SET status='DISCHARGE_INITIATED', initiated_at=?, payer_type=?,
       discharge_initiation_status='COMPLETED',
       discharge_initiation_completed_at=COALESCE(discharge_initiation_completed_at, ?),
       discharge_doc_started_at=COALESCE(discharge_doc_started_at, ?),
       ${startSql}, updated_at=? WHERE id=? AND updated_at=?`
    ).run(now, payerType, now, now, ...startParams, now, tracking.id, tracking.updated_at);
    if (r.changes === 0) throw new HttpError(409, "This discharge was just updated by someone else. Please refresh and try again.");

    await logHistory({
      admissionId: opts.admissionId, trackingId: tracking.id, field: "status",
      oldValue: tracking.status, newValue: "DISCHARGE_INITIATED", userId: opts.userId,
    });
    await audit(opts.userId, "discharge_initiate", String(opts.admissionId), {});
  });

  await emitMyPatientsUpdate(opts.admissionId);
  return (await getTrackingById(tracking.id))!;
}

async function resetAndCancelTracking(tracking: DischargeTracking, userId: number | null, reason: string | null | undefined) {
  const now = Date.now();
  await db.transaction(async () => {
    for (const step of Object.keys(STEP_COLUMN) as StepKey[]) {
      const col = STEP_COLUMN[step];
      const oldValue = (tracking as unknown as Record<string, string>)[col];
      if (oldValue !== "PENDING") {
        await logHistory({
          admissionId: tracking.admission_id, trackingId: tracking.id, field: step,
          oldValue, newValue: "PENDING", userId, reason: reason ?? "Discharge cancelled after initiation",
        });
      }
    }
    const clearSla = ALL_STEPS
      .flatMap(k => [`${startedCol(k)}=NULL`, `${completedCol(k)}=NULL`])
      .join(", ");
    const r = await db.prepare(`
      UPDATE discharge_tracking SET
        status='CANCELLED',
        discharge_initiation_status='PENDING', discharge_doc_status='PENDING', drug_return_status='PENDING', pharmacy_clearance_status='PENDING',
        procedure_reconciliation_status='PENDING', billing_started_status='PENDING', audit_status='PENDING',
        bill_ready_status='PENDING', payment_status='PENDING', system_checkout_status='PENDING', physical_checkout_status='PENDING',
        ${clearSla},
        patient_left=NULL, updated_at=?
      WHERE id=? AND updated_at=?
    `).run(now, tracking.id, tracking.updated_at);
    if (r.changes === 0) throw new HttpError(409, "This discharge was just updated by someone else. Please refresh and try again.");

    await logHistory({
      admissionId: tracking.admission_id, trackingId: tracking.id, field: "status",
      oldValue: tracking.status, newValue: "CANCELLED", userId, reason,
    });
    await audit(userId, "discharge_cancel", String(tracking.admission_id), { reason });
  });
}

/** "Discharge cancelled after initiation" edge case: stop workflow, reset checklist, keep history. */
export async function cancelAfterInitiation(opts: { admissionId: number; reason?: string | null; userId: number; role: Role }): Promise<void> {
  requireRoleIn(opts.role, CANCEL_ROLES, "Cancelling an in-progress discharge");
  const tracking = await getTrackingByAdmission(opts.admissionId);
  if (!tracking) throw new HttpError(404, "No discharge found for this admission");
  if (["COMPLETED", "CANCELLED"].includes(tracking.status))
    throw new HttpError(409, `Discharge is already ${tracking.status}`);

  await resetAndCancelTracking(tracking, opts.userId, opts.reason);
  await emitMyPatientsUpdate(opts.admissionId);
}

/** Called from bedDetailService when a bed with an active admission is manually marked
 *  Vacant outside the discharge workflow. No role gate — this is a system-triggered side
 *  effect of the physical-status change itself, not a user-initiated cancel action. */
export async function handleManualVacate(bedId: number, userId: number | null): Promise<void> {
  const admission = await getActiveAdmissionByBed(bedId);
  if (!admission) return;

  const tracking = await getTrackingByAdmission(admission.id);
  if (tracking && !["COMPLETED", "CANCELLED"].includes(tracking.status))
    await resetAndCancelTracking(tracking, userId, "Bed manually marked vacant outside the discharge workflow");

  await closeAdmission(admission.id, userId);
}

/** Vacates the bed + closes the admission once both checkouts are done and the patient has left.
 *  This is the only place the discharge module is allowed to change bed status. */
async function completeIfEligible(tracking: DischargeTracking, userId: number) {
  if (tracking.system_checkout_status !== "COMPLETED") return;
  if (tracking.physical_checkout_status !== "COMPLETED") return;
  if (tracking.patient_left !== true) return;
  if (tracking.status === "COMPLETED") return;

  const admission = await getAdmissionById(tracking.admission_id);
  if (!admission) return;

  const now = Date.now();
  await db.transaction(async () => {
    await updateBedStatus({
      bedId: admission.bed_id, physicalStatus: "VACANT", reservationStatus: "NONE",
      userId, changeReason: "DISCHARGE_CHECKOUT",
    });
    await closeAdmission(admission.id, userId);
    const r = await db.prepare("UPDATE discharge_tracking SET status='COMPLETED', updated_at=? WHERE id=? AND updated_at=?").run(now, tracking.id, tracking.updated_at);
    if (r.changes === 0) throw new HttpError(409, "This discharge was just updated by someone else. Please refresh and try again.");
  });
  await logHistory({
    admissionId: tracking.admission_id, trackingId: tracking.id, field: "status",
    oldValue: tracking.status, newValue: "COMPLETED", userId,
  });
  await audit(userId, "discharge_complete", String(tracking.admission_id), {});
}

/** Stamps patient_admissions.physically_left_at — the source of truth for "patient
 *  physically left" that survives even when no discharge_tracking row exists yet.
 *  Safe to call unconditionally; a no-op once already set. */
async function markPhysicallyLeft(admissionId: number): Promise<void> {
  await db.prepare(
    "UPDATE patient_admissions SET physically_left_at = COALESCE(physically_left_at, ?) WHERE id=?"
  ).run(Date.now(), admissionId);
}

const AUTO_LOUNGE_REASON = "Auto-completed via Discharge Lounge transfer";

/** Called from bedTransferService.transferBed whenever the destination is the
 *  Discharge Lounge — regardless of who transferred the bed (PRE/Nurse/FC) and
 *  regardless of whether a discharge had already been planned/initiated on the
 *  physical bed. The transfer itself is now treated as "this patient is
 *  administratively ready to leave": every step through Payment is force-
 *  completed (auto-initiating the discharge first if none existed yet), and
 *  Physical Checkout completes too (the transfer IS the patient physically
 *  leaving). Only System Checkout is left for staff to actually verify before
 *  the bed can vacate. Each forced step is logged with a distinct reason so
 *  it's never confused with a real manual completion. Mirrors dischargeImmediate's
 *  "create tracking row if missing, force-complete a list of steps" shape,
 *  just excluding SYSTEM_CHECKOUT from the forced list and not vacating/closing. */
export async function autoCompleteDischargeForLoungeTransfer(admissionId: number, userId: number): Promise<void> {
  await markPhysicallyLeft(admissionId);

  let tracking = await getTrackingByAdmission(admissionId);
  if (tracking?.status === "COMPLETED") return; // already fully discharged — nothing to do

  // Same convention as planDischarge: a CANCELLED tracking row doesn't block
  // (or get reused by) a new discharge — a fresh row is started, same as if
  // there had been no discharge at all.
  const needsFreshRow = !tracking || tracking.status === "CANCELLED";

  const now = Date.now();
  const nowIst = new Date(now + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

  await db.transaction(async () => {
    if (needsFreshRow) {
      const row = await db.prepare(
        `INSERT INTO discharge_tracking (admission_id, status, planned_date, planned_by, created_by, created_at, updated_at, initiated_at)
         VALUES (?, 'DISCHARGE_INITIATED', ?, ?, ?, ?, ?, ?) RETURNING id`
      ).run(admissionId, nowIst, userId, userId, now, now, now);
      tracking = (await getTrackingById(Number(row.lastInsertRowid)))!;
      await logHistory({
        admissionId, trackingId: tracking.id, field: "status",
        oldValue: null, newValue: "DISCHARGE_INITIATED", userId, reason: AUTO_LOUNGE_REASON,
      });
    }

    const forceSteps = (Object.keys(STEP_COLUMN) as StepKey[]).filter((s) => s !== "SYSTEM_CHECKOUT" && s !== "PHYSICAL_CHECKOUT");
    // Statuses alone are not enough. Everything downstream — the SLA view, the
    // "Not started / took Xm" line, nextPhasesToStart's unlock check — reads the
    // timestamp columns, so writing only the status left rows claiming a step was
    // COMPLETED yet never started. COALESCE so a step that was genuinely worked
    // through earlier keeps its real times; only the forced ones get `now`.
    const stepSets = forceSteps.flatMap((s) => [
      `${STEP_COLUMN[s]}='COMPLETED'`,
      `${startedCol(s)}=COALESCE(${startedCol(s)}, ?)`,
      `${completedCol(s)}=COALESCE(${completedCol(s)}, ?)`,
    ]);
    // Groups 1-3 are all clear now, which is exactly what unlocks System Checkout.
    // Finishing that last step by hand would have stamped this; forcing must too,
    // or the row lands "everything done, System Checkout never started" — the
    // state that made completing it blow up with a duplicate-column UPDATE.
    stepSets.push(`${startedCol("SYSTEM_CHECKOUT")}=COALESCE(${startedCol("SYSTEM_CHECKOUT")}, ?)`);
    const setSql = stepSets.join(", ");
    const stepParams = [...forceSteps.flatMap(() => [now, now]), now];
    const r = await db.prepare(
      `UPDATE discharge_tracking SET status='IN_PROGRESS', physical_checkout_status='COMPLETED', patient_left=true,
         physical_checkout_started_at=COALESCE(physical_checkout_started_at, ?), physical_checkout_completed_at=?,
         ${setSql}, updated_at=? WHERE id=? AND updated_at=?`
    ).run(now, now, ...stepParams, now, tracking!.id, tracking!.updated_at);
    if (r.changes === 0) throw new HttpError(409, "This discharge was just updated by someone else. Please refresh and try again.");

    for (const s of [...forceSteps, "PHYSICAL_CHECKOUT" as StepKey]) {
      const col = STEP_COLUMN[s];
      const oldValue = (tracking as unknown as Record<string, string>)[col];
      if (oldValue !== "COMPLETED") {
        await logHistory({
          admissionId, trackingId: tracking!.id, field: s,
          oldValue, newValue: "COMPLETED", userId, reason: AUTO_LOUNGE_REASON,
        });
      }
    }
  });

  const updated = (await getTrackingById(tracking!.id))!;
  await completeIfEligible(updated, userId);
}

/** Called from bedTransferService.transferBed (via readmitFromLounge) when the
 *  *source* bed was the Discharge Lounge — the patient is physically back on a real
 *  bed now, so the earlier "patient left" declaration is stale and must be undone.
 *  Only physical_checkout_status/patient_left are touched — every other checklist
 *  step (billing, audit, etc.) is left exactly as it was, same scope boundary as
 *  markPhysicalCheckoutFromTransfer. No-op if there's nothing to undo. */
export async function resetPhysicalCheckoutOnReadmit(admissionId: number, userId: number): Promise<void> {
  await db.prepare("UPDATE patient_admissions SET physically_left_at = NULL WHERE id=?").run(admissionId);

  const tracking = await getTrackingByAdmission(admissionId);
  if (!tracking || ["COMPLETED", "CANCELLED"].includes(tracking.status)) return;
  if (tracking.physical_checkout_status !== "COMPLETED") return;

  const now = Date.now();
  const r = await db.prepare(
    `UPDATE discharge_tracking SET physical_checkout_status='PENDING', patient_left=NULL,
       physical_checkout_started_at=NULL, physical_checkout_completed_at=NULL, updated_at=?
     WHERE id=? AND updated_at=?`
  ).run(now, tracking.id, tracking.updated_at);
  if (r.changes === 0) throw new HttpError(409, "This discharge was just updated by someone else. Please refresh and try again.");

  await logHistory({
    admissionId, trackingId: tracking.id, field: "PHYSICAL_CHECKOUT",
    oldValue: "COMPLETED", newValue: "PENDING", userId,
    reason: "Readmitted from Discharge Lounge — patient is back on a real bed",
  });
}

/** PRE-only emergency override for a lounge admission: force-completes every
 *  checklist step and closes the discharge in one shot. Usable at any point, on
 *  any admission currently sitting in the Discharge Lounge — including one with
 *  no discharge_tracking row at all yet, which gets created and completed in the
 *  same transaction. Physical checkout is always already true here (a lounge
 *  admission implies physically_left_at is set), so nothing needs deriving for it. */
export async function dischargeImmediate(opts: { admissionId: number; userId: number; role: Role }): Promise<void> {
  requireRoleIn(opts.role, ["PRE"], "Discharge Immediate");

  const admission = await getAdmissionById(opts.admissionId);
  if (!admission || admission.status !== "ACTIVE") throw new HttpError(404, "No active admission found");

  const bedRow = await db.prepare(
    `SELECT w.is_discharge_lounge FROM bed_details bd JOIN wards w ON w.id = bd.ward_id WHERE bd.id = ?`
  ).get<{ is_discharge_lounge: boolean }>(admission.bed_id);
  if (!bedRow?.is_discharge_lounge)
    throw new HttpError(409, "Discharge Immediate is only available for admissions currently in the Discharge Lounge");

  let tracking = await getTrackingByAdmission(opts.admissionId);
  if (tracking && ["COMPLETED", "CANCELLED"].includes(tracking.status))
    throw new HttpError(409, `Discharge is already ${tracking.status}`);

  const now = Date.now();
  const nowIst = new Date(now + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

  await db.transaction(async () => {
    if (!tracking) {
      const row = await db.prepare(
        `INSERT INTO discharge_tracking (admission_id, status, planned_date, planned_by, created_by, created_at, updated_at,
           physical_checkout_status, patient_left, initiated_at)
         VALUES (?, 'DISCHARGE_INITIATED', ?, ?, ?, ?, ?, 'COMPLETED', true, ?) RETURNING id`
      ).run(opts.admissionId, nowIst, opts.userId, opts.userId, now, now, now);
      tracking = (await getTrackingById(Number(row.lastInsertRowid)))!;
    }

    const steps = Object.keys(STEP_COLUMN) as StepKey[];
    // Same reasoning as the lounge-transfer force above: stamp the SLA columns,
    // not just the statuses, so this row's durations and history are readable
    // rather than a completed discharge whose every phase claims "Not started".
    // This row closes immediately so it can't hit the duplicate-column crash,
    // but it would still report nulls to every downstream SLA consumer.
    const stepSets = steps.flatMap((s) => [
      `${STEP_COLUMN[s]}='COMPLETED'`,
      `${startedCol(s)}=COALESCE(${startedCol(s)}, ?)`,
      `${completedCol(s)}=COALESCE(${completedCol(s)}, ?)`,
    ]);
    const setSql = stepSets.join(", ");
    const stepParams = steps.flatMap(() => [now, now]);
    const r = await db.prepare(
      `UPDATE discharge_tracking SET status='COMPLETED', patient_left=true, ${setSql}, updated_at=? WHERE id=? AND updated_at=?`
    ).run(...stepParams, now, tracking!.id, tracking!.updated_at);
    if (r.changes === 0) throw new HttpError(409, "This discharge was just updated by someone else. Please refresh and try again.");

    for (const s of steps) {
      const col = STEP_COLUMN[s];
      const oldValue = (tracking as unknown as Record<string, string>)[col];
      if (oldValue !== "COMPLETED") {
        await logHistory({
          admissionId: opts.admissionId, trackingId: tracking!.id, field: s,
          oldValue, newValue: "COMPLETED", userId: opts.userId, reason: "Discharge Immediate (force-complete)",
        });
      }
    }

    await updateBedStatus({
      bedId: admission.bed_id, physicalStatus: "VACANT", reservationStatus: "NONE",
      userId: opts.userId, changeReason: "DISCHARGE_CHECKOUT",
    });
    await closeAdmission(admission.id, opts.userId);
  });

  await audit(opts.userId, "discharge_force_complete", String(opts.admissionId), {});
}

export async function updateStep(opts: {
  admissionId: number; step: StepKey; status: string; patientLeft?: boolean | null;
  reason?: string | null; userId: number; role: Role;
}): Promise<DischargeTracking> {
  const permission = STEP_PERMISSIONS[opts.step];
  if (!permission) throw new HttpError(400, `Unknown discharge step: ${opts.step}`);
  requireRoleIn(opts.role, permission, `Updating ${opts.step}`);

  const allowedValues = STEP_VALUES[opts.step];
  if (!allowedValues.includes(opts.status))
    throw new HttpError(400, `Invalid status for ${opts.step}. Must be one of: ${allowedValues.join(", ")}`);

  const tracking = await getTrackingByAdmission(opts.admissionId);
  if (!tracking) throw new HttpError(404, "No discharge found for this admission");
  if (["COMPLETED", "CANCELLED"].includes(tracking.status))
    throw new HttpError(409, `Discharge is already ${tracking.status} — cannot update steps`);

  if (opts.step === "PHYSICAL_CHECKOUT" && opts.status === "COMPLETED" && opts.patientLeft === undefined)
    throw new HttpError(400, "patient_left (true/false) is required when completing Physical Checkout");

  // Bill Prep requires both Pharmacy Clearance and Procedure Reconciliation done.
  if (opts.step === "BILLING_STARTED" && opts.status === "COMPLETED") {
    const phcDone = ["COMPLETED", "NOT_APPLICABLE"].includes(tracking.pharmacy_clearance_status);
    const prDone = ["COMPLETED", "NOT_APPLICABLE"].includes(tracking.procedure_reconciliation_status);
    const missing: string[] = [];
    if (!phcDone) missing.push(STEP_LABELS.PHARMACY_CLEARANCE);
    if (!prDone) missing.push(STEP_LABELS.PROCEDURE_RECONCILIATION);
    if (missing.length > 0)
      throw new HttpError(409, `Complete these steps before Bill Prep: ${missing.join(", ")}`);
  }

  // Drug Return cannot be reopened once either downstream step has been completed.
  if (opts.step === "DRUG_RETURN" && opts.status === "PENDING") {
    const phcDone = ["COMPLETED", "NOT_APPLICABLE"].includes(tracking.pharmacy_clearance_status);
    const prDone = ["COMPLETED", "NOT_APPLICABLE"].includes(tracking.procedure_reconciliation_status);
    if (phcDone || prDone)
      throw new HttpError(409, "Cannot reopen Drug Return — Pharmacy Clearance or Procedure Reconciliation is already completed.");
  }

  // System Checkout must be the last administrative step — it can't be marked
  // complete while any other part of the discharge flow (doctor summary, drug/
  // clinical clearance, billing & payment) is still outstanding.
  if (opts.step === "SYSTEM_CHECKOUT" && opts.status === "COMPLETED") {
    const pending = PRE_SYSTEM_CHECKOUT_STEPS.filter((key) => {
      const val = (tracking as unknown as Record<string, string>)[STEP_COLUMN[key]];
      return !["COMPLETED", "NOT_APPLICABLE"].includes(val);
    });
    if (pending.length > 0)
      throw new HttpError(409, `Complete these steps before System Checkout: ${pending.map((k) => STEP_LABELS[k]).join(", ")}`);
  }

  const col = STEP_COLUMN[opts.step];
  const oldValue = (tracking as unknown as Record<string, string>)[col];
  const now = Date.now();

  // First real step update after initiation moves status from
  // DISCHARGE_INITIATED to IN_PROGRESS — purely informational for the UI.
  const nextStatus = tracking.status === "DISCHARGE_INITIATED" ? "IN_PROGRESS" : tracking.status;

  const patientLeft = opts.step === "PHYSICAL_CHECKOUT" ? (opts.patientLeft ?? null) : tracking.patient_left;

  // SLA bookkeeping. Finishing a phase stamps its completion time and opens the
  // next phase in the same group (nextPhaseToStart also unlocks System Checkout
  // once groups 1-3 are all clear). Reopening a phase clears its completion so
  // the deadline is measured from the original start again.
  const slaSets: string[] = [];
  const slaParams: unknown[] = [];
  const isDone = ["COMPLETED", "NOT_APPLICABLE"].includes(opts.status);
  if (isDone) {
    slaSets.push(`${completedCol(opts.step)}=?`); slaParams.push(now);
    // A phase can be completed before it was ever formally started (out-of-order
    // edits are allowed) — stamp a start so duration/ETA maths stay sane.
    slaSets.push(`${startedCol(opts.step)}=COALESCE(${startedCol(opts.step)}, ?)`); slaParams.push(now);
    const nexts = nextPhasesToStart(opts.step, tracking as unknown as Record<string, unknown>);
    for (const next of nexts) { slaSets.push(`${startedCol(next)}=COALESCE(${startedCol(next)}, ?)`); slaParams.push(now); }
  } else {
    slaSets.push(`${completedCol(opts.step)}=NULL`);
    // Reopening System Checkout resets Physical Checkout timer if PC hasn't been completed.
    if (opts.step === "SYSTEM_CHECKOUT" && tracking.physical_checkout_status === "PENDING") {
      slaSets.push(`${startedCol("PHYSICAL_CHECKOUT")}=NULL`);
      slaSets.push(`${completedCol("PHYSICAL_CHECKOUT")}=NULL`);
    }
  }
  const slaSql = slaSets.length ? `, ${slaSets.join(", ")}` : "";

  const r = await db.prepare(
    `UPDATE discharge_tracking SET ${col}=?, status=?, patient_left=?${slaSql}, updated_at=? WHERE id=? AND updated_at=?`
  ).run(opts.status, nextStatus, patientLeft, ...slaParams, now, tracking.id, tracking.updated_at);
  if (r.changes === 0)
    throw new HttpError(409, "This discharge was just updated by someone else. Please refresh and try again.");

  await logHistory({
    admissionId: opts.admissionId, trackingId: tracking.id, field: opts.step,
    oldValue, newValue: opts.status, userId: opts.userId, reason: opts.reason,
  });
  await audit(opts.userId, "discharge_step_update", String(opts.admissionId), { step: opts.step, from: oldValue, to: opts.status });

  const updated = (await getTrackingById(tracking.id))!;
  await completeIfEligible(updated, opts.userId);

  // Skip if completeIfEligible just closed the admission above — closeAdmission
  // already emitted its own DISCHARGED event for this same change, a second
  // UPDATED here would be redundant.
  const final = (await getTrackingById(tracking.id))!;
  if (final.status !== "COMPLETED") {
    const admission = await getAdmissionById(opts.admissionId);
    const rooms = admission ? consultantRoomsFor(admission) : [];
    if (rooms.length) {
      const row = await getMyPatientsRow(opts.admissionId);
      if (row) emitConsultantPatientUpdate(rooms, { type: "UPDATED", action: "UPSERT", ...row });
    }
  }
  return final;
}

export interface DischargeDashboardCounts {
  plannedToday: number; plannedTomorrow: number; scheduledOngoingToday: number; initiated: number;
  drugReturnPending: number; drugReturnCompleted: number;
  pharmacyPending: number; pharmacyCompleted: number;
  procedurePending: number; procedureCompleted: number;
  billingStarted: number; billingStartedCompleted: number;
  auditPending: number; auditCompleted: number;
  billReady: number; billReadyCompleted: number;
  paymentPending: number; paymentCompleted: number;
  systemCheckoutPending: number; systemCheckoutCompleted: number;
  physicalCheckoutPending: number; physicalCheckoutCompleted: number;
  completedToday: number;
  overduePlanned: number;
  /** System Checkout done, Physical Checkout not — billing/paperwork finished, patient hasn't
   *  physically left yet. Bed stays Occupied as normal; this is purely a visibility count. */
  awaitingPatientLeave: number;
  /** Initiated and at least one checklist step has been touched — distinct from
   *  `initiated`, which is only the freshly-started DISCHARGE_INITIATED status. */
  pending: number;
  /** Cancelled at any point (before or after initiation). */
  cancelled: number;
  /** Initiated today (initiated_at >= todayStart) — covers both planned-for-today
   *  that got initiated + unplanned "initiate now" used today. */
  initiatedToday: number;
  /** Initiated today but NOT scheduled for today — no plan at all, or planned for
   *  a different date (future planned but pushed early). */
  unplannedToday: number;
  unplannedPending: number;
  /** Cancelled today specifically (updated_at >= todayStart). */
  cancelledToday: number;
  /** Patient physically left before system checkout was completed — billing risk. */
  patientLeft: number;
  /** Physical Checkout done, System Checkout still pending — patient is in the Discharge Lounge. */
  inDischargeLounge: number;
}

/** wardIds = null means hospital-wide (COO/FC); otherwise scoped to the caller's wards. */
export async function dashboardCounts(wardIds: number[] | null, extraAdmissionIds?: number[] | null): Promise<DischargeDashboardCounts> {
  const { clause: scopeClause, params } = wardScopeSql(wardIds, extraAdmissionIds);

  // IST day boundaries (hospital is India-based — see existing scheduler's IST usage).
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const today = nowIst.toISOString().slice(0, 10);
  const tomorrow = new Date(nowIst.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const todayStartMs = new Date(nowIst.toISOString().slice(0, 10) + "T00:00:00+05:30").getTime();

  const row = await db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status='PLANNED' AND dt.planned_date=?) AS planned_today,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status='PLANNED' AND dt.planned_date=?) AS planned_tomorrow,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.planned_date=? AND dt.created_at < ?) AS scheduled_ongoing_today,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status='DISCHARGE_INITIATED') AS initiated,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status='IN_PROGRESS') AS pending,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status='CANCELLED') AS cancelled,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.drug_return_status='PENDING') AS drug_return_pending,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS','COMPLETED') AND dt.drug_return_status='COMPLETED' AND dt.initiated_at >= ?) AS drug_return_completed,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.pharmacy_clearance_status='PENDING') AS pharmacy_pending,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS','COMPLETED') AND dt.pharmacy_clearance_status='COMPLETED' AND dt.initiated_at >= ?) AS pharmacy_completed,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.procedure_reconciliation_status='PENDING') AS procedure_pending,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS','COMPLETED') AND dt.procedure_reconciliation_status IN ('COMPLETED','NOT_APPLICABLE') AND dt.initiated_at >= ?) AS procedure_completed,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.billing_started_status='PENDING') AS billing_started,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS','COMPLETED') AND dt.billing_started_status='COMPLETED' AND dt.initiated_at >= ?) AS billing_started_completed,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.audit_status='PENDING') AS audit_pending,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS','COMPLETED') AND dt.audit_status='COMPLETED' AND dt.initiated_at >= ?) AS audit_completed,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.bill_ready_status='PENDING') AS bill_ready,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS','COMPLETED') AND dt.bill_ready_status='COMPLETED' AND dt.initiated_at >= ?) AS bill_ready_completed,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.payment_status='PENDING') AS payment_pending,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS','COMPLETED') AND dt.payment_status='COMPLETED' AND dt.initiated_at >= ?) AS payment_completed,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.system_checkout_status='PENDING') AS system_checkout_pending,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS','COMPLETED') AND dt.system_checkout_status='COMPLETED' AND dt.initiated_at >= ?) AS system_checkout_completed,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.physical_checkout_status='PENDING') AS physical_checkout_pending,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS','COMPLETED') AND dt.physical_checkout_status='COMPLETED' AND dt.initiated_at >= ?) AS physical_checkout_completed,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.system_checkout_status='COMPLETED' AND dt.physical_checkout_status<>'COMPLETED') AS awaiting_patient_leave,
      COUNT(*) FILTER (WHERE dt.status='COMPLETED' AND dt.updated_at >= ?) AS completed_today,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status='PLANNED' AND dt.planned_date < ?) AS overdue_planned,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS','COMPLETED') AND dt.initiated_at >= ?) AS initiated_today,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS','COMPLETED') AND dt.initiated_at >= ?
                       AND dt.planned_date = ? AND dt.created_at >= ?) AS unplanned_today,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS')
                       AND dt.planned_date = ? AND dt.created_at >= ?) AS unplanned_pending,
      COUNT(*) FILTER (WHERE dt.status='CANCELLED' AND dt.updated_at >= ?) AS cancelled_today,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.patient_left = TRUE AND dt.system_checkout_status != 'COMPLETED') AS patient_left,
      COUNT(*) FILTER (WHERE pa.status='ACTIVE' AND dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.physical_checkout_status='COMPLETED' AND dt.system_checkout_status!='COMPLETED') AS in_discharge_lounge
    FROM discharge_tracking dt
    JOIN patient_admissions pa ON pa.id = dt.admission_id
    WHERE pa.status IN ('ACTIVE','DISCHARGED') ${scopeClause}
  `).get<Record<string, number>>(today, tomorrow, today, todayStartMs,
    todayStartMs, todayStartMs, todayStartMs, todayStartMs, todayStartMs, todayStartMs, todayStartMs, todayStartMs, todayStartMs,
    todayStartMs, today, todayStartMs, todayStartMs, today, todayStartMs, today, todayStartMs, todayStartMs, ...params);

  return {
    plannedToday: Number(row?.planned_today || 0),
    plannedTomorrow: Number(row?.planned_tomorrow || 0),
    scheduledOngoingToday: Number(row?.scheduled_ongoing_today || 0),
    initiated: Number(row?.initiated || 0),
    pending: Number(row?.pending || 0),
    cancelled: Number(row?.cancelled || 0),
    drugReturnPending: Number(row?.drug_return_pending || 0),
    drugReturnCompleted: Number(row?.drug_return_completed || 0),
    pharmacyPending: Number(row?.pharmacy_pending || 0),
    pharmacyCompleted: Number(row?.pharmacy_completed || 0),
    procedurePending: Number(row?.procedure_pending || 0),
    procedureCompleted: Number(row?.procedure_completed || 0),
    billingStarted: Number(row?.billing_started || 0),
    billingStartedCompleted: Number(row?.billing_started_completed || 0),
    auditPending: Number(row?.audit_pending || 0),
    auditCompleted: Number(row?.audit_completed || 0),
    billReady: Number(row?.bill_ready || 0),
    billReadyCompleted: Number(row?.bill_ready_completed || 0),
    paymentPending: Number(row?.payment_pending || 0),
    paymentCompleted: Number(row?.payment_completed || 0),
    systemCheckoutPending: Number(row?.system_checkout_pending || 0),
    systemCheckoutCompleted: Number(row?.system_checkout_completed || 0),
    physicalCheckoutPending: Number(row?.physical_checkout_pending || 0),
    physicalCheckoutCompleted: Number(row?.physical_checkout_completed || 0),
    awaitingPatientLeave: Number(row?.awaiting_patient_leave || 0),
    completedToday: Number(row?.completed_today || 0),
    overduePlanned: Number(row?.overdue_planned || 0),
    initiatedToday: Number(row?.initiated_today || 0),
    unplannedToday: Number(row?.unplanned_today || 0),
    unplannedPending: Number(row?.unplanned_pending || 0),
    cancelledToday: Number(row?.cancelled_today || 0),
    patientLeft: Number(row?.patient_left || 0),
    inDischargeLounge: Number(row?.in_discharge_lounge || 0),
  };
}

const DISCHARGE_LIST_SELECT = `
  SELECT dt.*, pa.id AS admission_id, pa.bed_id, pa.ward_id, pa.ip_last6,
         bd.bed_name, w.name AS ward_name
  FROM discharge_tracking dt
  JOIN patient_admissions pa ON pa.id = dt.admission_id
  JOIN bed_details bd ON bd.id = pa.bed_id
  JOIN wards w ON w.id = pa.ward_id
`;

export async function listCancelledToday(wardIds: number[] | null, extraAdmissionIds?: number[] | null) {
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const todayStartMs = new Date(nowIst.toISOString().slice(0, 10) + "T00:00:00+05:30").getTime();
  const { clause: scopeClause, params } = wardScopeSql(wardIds, extraAdmissionIds);
  return db.prepare(
    `${DISCHARGE_LIST_SELECT} WHERE dt.status='CANCELLED' AND dt.updated_at >= ? ${scopeClause} ORDER BY dt.updated_at DESC`
  ).all(todayStartMs, ...params);
}

export async function listAdmittedToday(wardIds: number[] | null, extraAdmissionIds?: number[] | null) {
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const todayStart = new Date(nowIst.toISOString().slice(0, 10) + "T00:00:00+05:30").getTime();
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;
  const { clause: scopeClause, params } = wardScopeSql(wardIds, extraAdmissionIds);
  return db.prepare(`
    SELECT pa.id AS admission_id, pa.bed_id, pa.ward_id, pa.ip_last6, pa.admitted_at,
           bd.bed_name, w.name AS ward_name
    FROM patient_admissions pa
    JOIN bed_details bd ON bd.id = pa.bed_id
    JOIN wards w ON w.id = pa.ward_id
    WHERE pa.admitted_at >= ? AND pa.admitted_at < ? ${scopeClause}
    ORDER BY pa.admitted_at DESC
  `).all(todayStart, todayEnd, ...params);
}

export async function listInitiatedToday(wardIds: number[] | null, extraAdmissionIds?: number[] | null) {
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const todayStartMs = new Date(nowIst.toISOString().slice(0, 10) + "T00:00:00+05:30").getTime();
  const { clause: scopeClause, params } = wardScopeSql(wardIds, extraAdmissionIds);
  return db.prepare(
    `${DISCHARGE_LIST_SELECT} WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS','COMPLETED')
     AND dt.initiated_at >= ? ${scopeClause} ORDER BY dt.initiated_at DESC`
  ).all(todayStartMs, ...params);
}

export async function listCompletedToday(wardIds: number[] | null, extraAdmissionIds?: number[] | null) {
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const todayStartMs = new Date(nowIst.toISOString().slice(0, 10) + "T00:00:00+05:30").getTime();
  const { clause: scopeClause, params } = wardScopeSql(wardIds, extraAdmissionIds);
  return db.prepare(
    `${DISCHARGE_LIST_SELECT} WHERE dt.status='COMPLETED' AND dt.updated_at >= ?
     AND pa.status='DISCHARGED' ${scopeClause} ORDER BY dt.updated_at DESC`
  ).all(todayStartMs, ...params);
}

export async function listPatientLeft(wardIds: number[] | null, extraAdmissionIds?: number[] | null) {
  const { clause: scopeClause, params } = wardScopeSql(wardIds, extraAdmissionIds);
  return db.prepare(
    `${DISCHARGE_LIST_SELECT} WHERE dt.patient_left = TRUE AND dt.system_checkout_status != 'COMPLETED'
     AND pa.status IN ('ACTIVE','DISCHARGED') ${scopeClause} ORDER BY dt.updated_at DESC`
  ).all(...params);
}

/** Who most recently finished each step (COMPLETED or NOT_APPLICABLE), keyed by
 *  step key — powers the "Completed by <name> (<role>)" line on each phase card.
 *  DISTINCT ON picks the latest such row per field, so a step that was reopened
 *  and redone shows its current completer, not the first one. */
export async function stepActorsForAdmission(admissionId: number) {
  const rows = await db.prepare(
    `SELECT DISTINCT ON (dh.field) dh.field, dh.changed_by, dh.changed_at,
            u.name AS changed_by_name, u.role AS changed_by_role
     FROM discharge_history dh
     LEFT JOIN users u ON u.id = dh.changed_by
     WHERE dh.admission_id=? AND dh.field != 'status' AND dh.new_value IN ('COMPLETED', 'NOT_APPLICABLE')
     ORDER BY dh.field, dh.changed_at DESC`
  ).all<{ field: string; changed_by: number | null; changed_at: number; changed_by_name: string | null; changed_by_role: string | null }>(admissionId);
  const byStep: Record<string, { name: string | null; role: string | null; at: number }> = {};
  for (const r of rows) byStep[r.field] = { name: r.changed_by_name, role: r.changed_by_role, at: r.changed_at };
  return byStep;
}

export async function historyForAdmission(admissionId: number) {
  const discharge = await db.prepare(
    `SELECT dh.*, u.name AS changed_by_name, u.role AS changed_by_role
     FROM discharge_history dh LEFT JOIN users u ON u.id = dh.changed_by
     WHERE dh.admission_id=? ORDER BY dh.changed_at DESC`
  ).all(admissionId);
  const transfers = await db.prepare(
    `SELECT bth.*, u.name AS transferred_by_name,
            fb.bed_name AS from_bed_name, tb.bed_name AS to_bed_name,
            fw.name AS from_ward_name, tw.name AS to_ward_name
     FROM bed_transfer_history bth
     LEFT JOIN users u ON u.id = bth.transferred_by
     LEFT JOIN bed_details fb ON fb.id = bth.from_bed_id
     LEFT JOIN bed_details tb ON tb.id = bth.to_bed_id
     LEFT JOIN wards fw ON fw.id = bth.from_ward_id
     LEFT JOIN wards tw ON tw.id = bth.to_ward_id
     WHERE bth.admission_id=? ORDER BY bth.transferred_at DESC`
  ).all(admissionId);
  return { discharge, transfers };
}
