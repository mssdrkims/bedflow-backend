import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import {
  createReopenRequest, listPendingRequests, listMyRequests,
  reviewRequest, pendingCount,
} from "../services/reopenRequestService.js";
import { emitUpdate } from "../websocket/io.js";
import { allWardsLive, allBedDetailsLive, adminDashboard, adminDashboardHistory, consultantsLive, wardsOperationalHospitalWide, summarize } from "../services/bedService.js";
import { listPayerTypes } from "../services/payerTypeService.js";
import { listDestinations } from "../services/destinationService.js";
import { listBeds, updateBedStatus, getBedDetail } from "../services/bedDetailService.js";
import { updateActiveAdmission } from "../services/patientAdmissionService.js";
import { db } from "../db/index.js";

const router = Router();
const FC_STEPS = ["BILLING_STARTED", "AUDIT", "BILL_READY", "PAYMENT", "SYSTEM_CHECKOUT"] as const;
type FCStep = typeof FC_STEPS[number];

router.use(authRequired, requireRole("FC", "MASTER_FC"));

/** FC has no ward-assignment table (unlike PRE Blocks / nurse stations) — every
 *  operational ward hospital-wide is in scope, so the only per-ward check needed
 *  is that it's still operational at the moment of the write (in addition to the
 *  identical check updateBedStatus already does internally). */
async function assertWardOperational(wardId: number) {
  const ward = await db.prepare("SELECT operational FROM wards WHERE id=?").get<{ operational: boolean }>(wardId);
  if (!ward) throw new HttpError(404, "Ward not found");
  if (!ward.operational) throw new HttpError(409, "This ward is currently non-operational. Contact your manager.");
}

router.get("/reopen-pending-count", asyncH(async (req, res) => {
  const count = req.user!.role === "MASTER_FC"
    ? await pendingCount([...FC_STEPS])
    : 0;
  res.json({ count });
}));

router.post("/reopen-request", asyncH(async (req, res) => {
  const { admissionId, stepKey, reason } = z.object({
    admissionId: z.number().int(),
    stepKey: z.enum(FC_STEPS),
    reason: z.string().min(1).max(500),
  }).parse(req.body);

  const request = await createReopenRequest({
    admissionId, stepKey, reason, userId: req.user!.id,
  });
  emitUpdate("fc:reopen-request", { type: "new", request });
  res.status(201).json({ ok: true, request });
}));

router.get("/reopen-requests", asyncH(async (req, res) => {
  const steps = [...FC_STEPS];
  if (req.user!.role === "MASTER_FC") {
    res.json({ requests: await listPendingRequests(steps) });
  } else {
    res.json({ requests: await listMyRequests(req.user!.id, steps) });
  }
}));

router.post("/reopen-requests/:id/review", asyncH(async (req, res) => {
  if (req.user!.role !== "MASTER_FC")
    throw new HttpError(403, "Only Master FC can review reopen requests");

  const { action, reviewNote } = z.object({
    action: z.enum(["APPROVED", "DENIED"]),
    reviewNote: z.string().max(500).nullable().optional(),
  }).parse(req.body);

  const result = await reviewRequest({
    requestId: Number(req.params.id),
    action, reviewNote,
    userId: req.user!.id,
    role: req.user!.role,
  });
  emitUpdate("fc:reopen-request", { type: "reviewed", request: result });
  emitUpdate("discharge:update", { type: "reopen" });
  res.json({ ok: true, request: result });
}));

// ── Hospital-wide dashboard (read-only) ──────────────────────────────────────

router.get("/live-wards", asyncH(async (_req, res) => {
  res.json(await allWardsLive());
}));

router.get("/bed-details", asyncH(async (_req, res) => {
  res.json(await allBedDetailsLive());
}));

router.get("/admin-dashboard", asyncH(async (req, res) => {
  const unit = typeof req.query.unit === "string" ? req.query.unit : null;
  // includeLoungeSummary=false — Admin(COO)-only cards; see adminDashboard()'s
  // doc comment in bedService.ts.
  res.json(await adminDashboard(unit, null, false));
}));

router.get("/admin-dashboard-history", asyncH(async (req, res) => {
  const unit = typeof req.query.unit === "string" ? req.query.unit : null;
  res.json({ snapshots: await adminDashboardHistory(48, unit) });
}));

router.get("/consultants", asyncH(async (_req, res) => {
  res.json(await consultantsLive());
}));

router.get("/payer-types", asyncH(async (_req, res) => {
  res.json({ payerTypes: await listPayerTypes(true) });
}));

router.get("/snapshots", asyncH(async (_req, res) => {
  const rows = await db.prepare(
    "SELECT ts,total,vacant,reserved,occupied,payer_snapshot FROM occupancy_snapshots ORDER BY ts DESC LIMIT 48"
  ).all<{ ts: number; total: number; vacant: number; reserved: number; occupied: number; payer_snapshot: Record<string, number> | null }>();
  const snapshots = rows.reverse().map((r) => ({ ...r, payers: r.payer_snapshot || {} }));
  res.json({ snapshots });
}));

router.get("/overstay", asyncH(async (_req, res) => {
  const IST = 5.5 * 3600 * 1000;
  const todayIST = new Date(Date.now() + IST).toISOString().slice(0, 10);
  const rows = await db.prepare(`
    SELECT
      pa.id AS admission_id, pa.ip_last6, pa.admitted_at,
      COALESCE(dm.name, pa.consultant_name, 'Unknown') AS doctor,
      w.name AS ward, bd.bed_name AS bed,
      dt.planned_date, dt.status AS discharge_status,
      (CURRENT_DATE - dt.planned_date::date) AS days_overdue
    FROM patient_admissions pa
    JOIN discharge_tracking dt ON dt.admission_id = pa.id
    JOIN wards w ON w.id = pa.ward_id
    JOIN bed_details bd ON bd.id = pa.bed_id
    LEFT JOIN doctors_master dm ON dm.id = pa.doctor_id
    WHERE pa.status = 'ACTIVE'
      AND dt.status NOT IN ('COMPLETED', 'CANCELLED')
      AND dt.planned_date < ?
    ORDER BY days_overdue DESC, pa.admitted_at ASC
  `).all(todayIST);
  const total = rows.length;
  const tier1 = rows.filter((r: any) => Number(r.days_overdue) === 1).length;
  const tier2 = rows.filter((r: any) => Number(r.days_overdue) >= 2 && Number(r.days_overdue) <= 3).length;
  const tier3 = rows.filter((r: any) => Number(r.days_overdue) >= 4).length;
  res.json({ total, tier1, tier2, tier3, rows });
}));

// ── Bed Entry — hospital-wide, operational wards only, no round/review workflow ──
// FC gets full write access (admit, edit patient info) across every operational
// ward, unlike PRE/Nurse which are scoped to their assigned blocks/stations.
// There's deliberately no /wards/:id/review or /submit here — Review and Submit
// Round are a PRE-specific round-compliance workflow that FC's Bed Entry does not
// have.

router.get("/wards", asyncH(async (_req, res) => {
  const wards = await wardsOperationalHospitalWide();
  res.json({ wards, summary: summarize(wards) });
}));

router.get("/destinations", asyncH(async (_req, res) => {
  res.json({ destinations: await listDestinations(true) });
}));

router.get("/wards/:id/beds", asyncH(async (req, res) => {
  const wardId = Number(req.params.id);
  await assertWardOperational(wardId);
  const physicalStatus    = req.query.physical_status    as string | undefined;
  const reservationStatus = req.query.reservation_status as string | undefined;
  res.json({ beds: await listBeds(wardId, physicalStatus, reservationStatus, false, true) });
}));


router.patch("/beds/:id/status", asyncH(async (req, res) => {
  const bedId = Number(req.params.id);
  const { physical_status, reservation_status, payer_type, destination, reservation_note, ip_last6, patient_name, admission_date, admission_type, department_name, doctor_id, department_id, consultant_group_id } = z.object({
    physical_status:    z.enum(["VACANT", "OCCUPIED"]),
    reservation_status: z.enum(["NONE", "RESERVED"]),
    payer_type:         z.string().max(100).nullable().optional(),
    destination:        z.string().max(100).nullable().optional(),
    reservation_note:   z.string().max(255).nullable().optional(),
    ip_last6:           z.string().max(6).optional(),
    // Not .nullable(): omitting these means "untouched", but an explicit null
    // would mean "blank them", which is never allowed once a value exists.
    patient_name:       z.string().max(120).optional(),
    admission_date:     z.string().max(10).optional(),
    admission_type:     z.enum(["IP", "DAYCARE", "OPD"]).optional(),
    department_name:    z.string().max(120).nullable().optional(),
    doctor_id:          z.number().int().positive().nullable().optional(),
    department_id:      z.number().int().positive().nullable().optional(),
    consultant_group_id: z.number().int().positive().nullable().optional(),
  }).parse(req.body);

  // station_id comes along for the emit below: nurses only ever join
  // station:<id> rooms (never "overview"/ward:), so it's the only way a bed
  // change made here reaches the nurses staffing that ward. Joined onto the
  // lookup this route already does rather than fetched separately.
  const bed = await db.prepare(
    "SELECT bd.ward_id, w.station_id FROM bed_details bd JOIN wards w ON w.id = bd.ward_id WHERE bd.id=?"
  ).get<{ ward_id: number; station_id: number | null }>(bedId);
  if (!bed) throw new HttpError(404, "Bed not found");
  await assertWardOperational(bed.ward_id);

  const result = await updateBedStatus({
    bedId, physicalStatus: physical_status, reservationStatus: reservation_status,
    payerType: payer_type, destination, reservationNote: reservation_note, userId: req.user!.id,
    ipLast6: ip_last6, admissionType: admission_type, departmentName: department_name,
    patientName: patient_name, admissionDate: admission_date,
    doctorId: doctor_id, departmentId: department_id, consultantGroupId: consultant_group_id,
  });

  // Full current row alongside the existing summary fields — lets every
  // connected client patch just this bed locally instead of refetching the
  // whole ward. Purely additive: existing fields, rooms, and triggers unchanged.
  const bedDetail = await getBedDetail(bedId);
  emitUpdate("bed:update", {
    bedId, wardId: result.ward_id,
    physicalStatus: physical_status, reservationStatus: reservation_status,
    payerType: result.payer_type, destination: result.destination, reservationNote: result.reservation_note,
    bed: bedDetail,
  }, { wardId: result.ward_id, stationId: bed.station_id ?? undefined });
  res.json(result);
}));

/** Corrects IP/admission-type/consultant/department on a bed's already-active
 *  admission — mirrors PRE's PATCH /beds/:id/admission exactly (see pre.ts). */
router.patch("/beds/:id/admission", asyncH(async (req, res) => {
  const bedId = Number(req.params.id);
  const { ip_last6, patient_name, admission_date, admission_type, department_name, doctor_id, department_id, consultant_group_id, payer_type } = z.object({
    ip_last6:        z.string().length(6).optional(),
    // Omitted = untouched, so an admission that predates these fields keeps its
    // blank value and unrelated edits (payer type, consultant) still save. Sent =
    // fully validated, so a touched field can never be stored blank. No .nullable()
    // — there is no request that legitimately clears these back to empty.
    patient_name:    z.string().max(120).optional(),
    admission_date:  z.string().max(10).optional(),
    admission_type:  z.enum(["IP", "DAYCARE", "OPD"]).optional(),
    department_name: z.string().max(120).nullable().optional(),
    doctor_id:       z.number().int().positive().nullable().optional(),
    department_id:   z.number().int().positive().optional(),
    consultant_group_id: z.number().int().positive().nullable().optional(),
    payer_type:      z.string().max(100).nullable().optional(),
  }).parse(req.body);

  // station_id joined on for the emit below — see the note on the status route.
  const bed = await db.prepare(
    "SELECT bd.ward_id, bd.physical_status, w.station_id FROM bed_details bd JOIN wards w ON w.id = bd.ward_id WHERE bd.id=?"
  ).get<{ ward_id: number; physical_status: string; station_id: number | null }>(bedId);
  if (!bed) throw new HttpError(404, "Bed not found");
  await assertWardOperational(bed.ward_id);
  if (bed.physical_status !== "OCCUPIED") throw new HttpError(409, "Bed is not currently occupied.");

  await updateActiveAdmission({
    bedId, userId: req.user!.id,
    ipLast6: ip_last6, admissionType: admission_type,
    patientName: patient_name, admissionDate: admission_date,
    departmentName: department_name,
    doctorId: doctor_id, departmentId: department_id, consultantGroupId: consultant_group_id,
    payerType: payer_type,
  });

  emitUpdate("bed:update", { bedId, wardId: bed.ward_id }, { wardId: bed.ward_id, stationId: bed.station_id ?? undefined });
  res.json({ ok: true });
}));

export default router;
