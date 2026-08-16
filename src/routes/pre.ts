import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { wardsGroupedByBlock, summarize, updateWard, allWardsLive, allBedDetailsLive, adminDashboard, adminDashboardHistory, consultantsLive, type WardView } from "../services/bedService.js";
import { alarmState, submitRounds } from "../services/roundService.js";
import { listBeds, updateBedStatus, getBedDetail } from "../services/bedDetailService.js";
import { updateActiveAdmission } from "../services/patientAdmissionService.js";
import { listPayerTypes } from "../services/payerTypeService.js";
import { listDestinations } from "../services/destinationService.js";
import { emitUpdate } from "../websocket/io.js";
import { audit } from "../services/auditService.js";
import { db } from "../db/index.js";

const router = Router();
router.use(authRequired, requireRole("PRE"));

/** All PRE Blocks the authenticated PRE user is assigned to. Throws 400 if none. */
async function myPreBlocks(req: { user?: { id: number } }) {
  const rows = await db.prepare(
    `SELECT pb.id, pb.name
     FROM user_pre_blocks upb
     JOIN pre_blocks pb ON pb.id = upb.pre_block_id
     WHERE upb.user_id = ?
     ORDER BY pb.name`
  ).all<{ id: number; name: string }>(req.user!.id);

  if (rows.length === 0)
    throw new HttpError(400, "No PRE Block assigned to your account");

  return rows;
}

// ── Admin dashboard — hospital-wide, identical to the COO/Admin dashboard ───
//
// These five endpoints are deliberately NOT restricted to the caller's own PRE
// Blocks: PRE's Home dashboard is meant to be the same hospital-wide read-only
// view the Admin sees, so they mirror the /coo equivalents exactly (coo.ts).
//
// This is a read-only widening. Every *write* path and the ward/bed entry
// screens below still resolve wards through myPreBlocks(), so a PRE user can
// see the whole hospital here but can still only act on their own blocks.
//
// One deliberate exception: the Discharge Lounge occupancy summary
// (totalPatients / lounge) is Admin(COO)-only, so /admin-dashboard passes
// includeLoungeSummary=false here — see adminDashboard()'s doc comment in
// bedService.ts. Everything else about this endpoint still mirrors COO.

router.get("/live-wards", asyncH(async (_req, res) => {
  res.json(await allWardsLive());
}));

router.get("/bed-details", asyncH(async (_req, res) => {
  res.json(await allBedDetailsLive());
}));

router.get("/admin-dashboard", asyncH(async (req, res) => {
  const unit = typeof req.query.unit === "string" ? req.query.unit : null;
  res.json(await adminDashboard(unit, null, false));
}));

router.get("/admin-dashboard-history", asyncH(async (req, res) => {
  const unit = typeof req.query.unit === "string" ? req.query.unit : null;
  res.json({ snapshots: await adminDashboardHistory(48, unit) });
}));

router.get("/consultants", asyncH(async (_req, res) => {
  res.json(await consultantsLive());
}));

router.get("/snapshots", asyncH(async (_req, res) => {
  const rows = await db.prepare(
    "SELECT ts,total,vacant,reserved,occupied,payer_snapshot FROM occupancy_snapshots ORDER BY ts DESC LIMIT 48"
  ).all<{ ts: number; total: number; vacant: number; reserved: number; occupied: number; payer_snapshot: Record<string, number> | null }>();
  // pg auto-parses the jsonb column; older rows predate this column and are NULL.
  const snapshots = rows.reverse().map((r) => ({ ...r, payers: r.payer_snapshot || {} }));
  res.json({ snapshots });
}));

router.get("/me", asyncH(async (req, res) => {
  const blocks  = await myPreBlocks(req);
  const grouped = await wardsGroupedByBlock(req.user!.id);
  const label   = blocks.map(b => b.name).join(", ");
  // Flat deduplicated ward list for summary + backwards compat
  const wardMap = new Map<number, WardView>();
  for (const b of grouped) for (const w of b.wards) if (!wardMap.has(w.id)) wardMap.set(w.id, w);
  const wards = [...wardMap.values()];
  res.json({
    preBlockIds:   blocks.map(b => b.id),
    preBlockId:    blocks[0].id,   // legacy field
    preBlockNames: blocks.map(b => b.name),
    preBlockName:  label,
    pre:   label,
    floor: label,
    label,
    blocks: grouped,   // grouped by block — used for section headers in Entry tab
    wards,             // flat deduped list — used for summary, alarmState, MyMap
    summary: summarize(wards),
    alarm:   await alarmState(blocks.map(b => b.id)),
  });
}));

router.post("/ward", asyncH(async (req, res) => {
  const blocks = await myPreBlocks(req);
  const blockIds = blocks.map(b => b.id);
  const { wardId, vacant_none, vacant_reserved, occupied_none, occupied_reserved } = z.object({
    wardId:            z.number().int(),
    vacant_none:       z.number().int().min(0),
    vacant_reserved:   z.number().int().min(0),
    occupied_none:     z.number().int().min(0),
    occupied_reserved: z.number().int().min(0).default(0),
  }).parse(req.body);

  // Ward must belong to at least one of the user's blocks
  const ownRow = await db.prepare(
    "SELECT pre_block_id FROM pre_block_wards WHERE ward_id=? AND pre_block_id = ANY(?)"
  ).get<{ pre_block_id: number }>(wardId, blockIds);
  if (!ownRow) throw new HttpError(403, "Ward not in your PRE Block");

  const result = await updateWard(wardId, vacant_none, vacant_reserved, occupied_none, occupied_reserved, req.user!.id);
  const stationRow = await db.prepare(
    "SELECT station_id FROM wards WHERE id=?"
  ).get<{ station_id: number | null }>(wardId);
  const blockName = blocks.find(b => b.id === ownRow.pre_block_id)?.name ?? "";
  emitUpdate("bed:update", { floor: blockName, wardId, ...result }, {
    pre: String(ownRow.pre_block_id),
    stationId: stationRow?.station_id ?? undefined,
  });
  res.json({ ok: true, ...result });
}));

router.post("/submit", asyncH(async (req, res) => {
  const blocks = await myPreBlocks(req);
  const result = await submitRounds(blocks.map(b => b.id), req.user!.id);
  for (const block of blocks)
    emitUpdate("round:submit", { floor: block.name }, { pre: String(block.id) });
  res.json(result);
}));

// ── bed-level tracking ────────────────────────────────────────────────────────

router.get("/wards/:id/beds", asyncH(async (req, res) => {
  const blocks = await myPreBlocks(req);
  const blockIds = blocks.map(b => b.id);
  const wardId = Number(req.params.id);
  if (!await db.prepare(
    "SELECT 1 FROM pre_block_wards WHERE ward_id=? AND pre_block_id = ANY(?)"
  ).get(wardId, blockIds))
    throw new HttpError(403, "Ward not in your PRE Block");
  const physicalStatus    = req.query.physical_status    as string | undefined;
  const reservationStatus = req.query.reservation_status as string | undefined;
  res.json({ beds: await listBeds(wardId, physicalStatus, reservationStatus, false, true) });
}));

// ── Review-confirm (manual "reviewed, nothing to update" stamp on one ward) ──
// Mirrors Doctor's ward-level review exactly — independent of round submission,
// never counts toward the alarm's "all wards submitted" gate.
router.post("/wards/:id/review", asyncH(async (req, res) => {
  const blocks = await myPreBlocks(req);
  const blockIds = blocks.map(b => b.id);
  const wardId = Number(req.params.id);
  const ownRow = await db.prepare(
    "SELECT pre_block_id FROM pre_block_wards WHERE ward_id=? AND pre_block_id = ANY(?)"
  ).get<{ pre_block_id: number }>(wardId, blockIds);
  if (!ownRow) throw new HttpError(403, "Ward not in your PRE Block");

  // Cooldown — a ward can only be re-reviewed 5 minutes after its last review,
  // enforced server-side (not just a disabled button) so the "reviewed" trail
  // can't be spammed via repeated taps or direct API calls.
  const REVIEW_COOLDOWN_MS = 5 * 60 * 1000;
  const lastReview = await db.prepare(
    "SELECT reviewed_at FROM pre_ward_reviews WHERE ward_id=? ORDER BY reviewed_at DESC LIMIT 1"
  ).get<{ reviewed_at: number }>(wardId);
  if (lastReview) {
    const waitMs = REVIEW_COOLDOWN_MS - (Date.now() - Number(lastReview.reviewed_at));
    if (waitMs > 0)
      throw new HttpError(429, `You can review this ward again in ${Math.ceil(waitMs / 60000)}m`);
  }

  const t = Date.now();
  await db.prepare(
    "INSERT INTO pre_ward_reviews (pre_block_id, ward_id, user_id, reviewed_at) VALUES (?,?,?,?)"
  ).run(ownRow.pre_block_id, wardId, req.user!.id, t);
  await audit(req.user!.id, "pre_ward_review", String(wardId), { preBlockId: ownRow.pre_block_id });

  const stationRow = await db.prepare(
    "SELECT station_id FROM wards WHERE id=?"
  ).get<{ station_id: number | null }>(wardId);

  // pre: reaches the reviewing PRE's own Entry/Dashboard tabs (PRE sockets only
  // join pre:<blockId> rooms, never ward:<id> — omitting this was the bug: the
  // review saved fine, but the requester's own live view never got the event).
  emitUpdate("bed:update", { preBlockId: ownRow.pre_block_id, wardId, reviewedAt: t }, {
    pre: String(ownRow.pre_block_id),
    stationId: stationRow?.station_id ?? undefined,
    wardId,
  });
  res.json({ ok: true, reviewedAt: t });
}));

router.get("/payer-types", asyncH(async (_req, res) => {
  res.json({ payerTypes: await listPayerTypes(true) });
}));

router.get("/destinations", asyncH(async (_req, res) => {
  res.json({ destinations: await listDestinations(true) });
}));

router.patch("/beds/:id/status", asyncH(async (req, res) => {
  const blocks = await myPreBlocks(req);
  const blockIds = blocks.map(b => b.id);
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

  // Bed must belong to a ward that's in one of the user's blocks
  const owns = await db.prepare(
    `SELECT bd.id, pbw.pre_block_id FROM bed_details bd
     JOIN pre_block_wards pbw ON pbw.ward_id = bd.ward_id
     WHERE bd.id = ? AND pbw.pre_block_id = ANY(?)`
  ).get<{ id: number; pre_block_id: number }>(bedId, blockIds);
  if (!owns) throw new HttpError(403, "Bed not in your PRE Block");

  const result = await updateBedStatus({
    bedId, physicalStatus: physical_status, reservationStatus: reservation_status,
    payerType: payer_type, destination, reservationNote: reservation_note, userId: req.user!.id,
    ipLast6: ip_last6, admissionType: admission_type, departmentName: department_name,
    patientName: patient_name, admissionDate: admission_date,
    doctorId: doctor_id, departmentId: department_id, consultantGroupId: consultant_group_id,
  });

  const stationRow = await db.prepare(
    "SELECT station_id FROM wards WHERE id=?"
  ).get<{ station_id: number | null }>(result.ward_id);

  const blockName = blocks.find(b => b.id === owns.pre_block_id)?.name ?? "";
  // Full current row alongside the existing summary fields — every connected
  // client (this one included) can patch just this bed locally instead of
  // refetching the whole ward. Purely additive: existing fields, rooms, and
  // triggers are unchanged.
  const bedDetail = await getBedDetail(bedId);
  emitUpdate("bed:update", {
    bedId, wardId: result.ward_id,
    physicalStatus: physical_status, reservationStatus: reservation_status,
    payerType: result.payer_type, destination: result.destination, reservationNote: result.reservation_note,
    floor: blockName,
    bed: bedDetail,
  }, {
    pre: String(owns.pre_block_id),
    stationId: stationRow?.station_id ?? undefined,
  });
  res.json(result);
}));

/** Corrects IP/admission-type/consultant/department on a bed's already-active
 *  admission — for fixing a data-entry mistake made at admission time, not for
 *  changing physical/reservation status (use PATCH /beds/:id/status for that). */
router.patch("/beds/:id/admission", asyncH(async (req, res) => {
  const blocks = await myPreBlocks(req);
  const blockIds = blocks.map(b => b.id);
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

  const owns = await db.prepare(
    `SELECT bd.id, bd.ward_id, bd.physical_status, pbw.pre_block_id FROM bed_details bd
     JOIN pre_block_wards pbw ON pbw.ward_id = bd.ward_id
     WHERE bd.id = ? AND pbw.pre_block_id = ANY(?)`
  ).get<{ id: number; ward_id: number; physical_status: string; pre_block_id: number }>(bedId, blockIds);
  if (!owns) throw new HttpError(403, "Bed not in your PRE Block");
  if (owns.physical_status !== "OCCUPIED") throw new HttpError(409, "Bed is not currently occupied.");

  // updateActiveAdmission returns the fully-resolved admission row, but no caller
  // reads it — the PRE client discards the PATCH response and refetches via
  // onChanged(), and every client (including the sender) gets a bed:update socket
  // event that triggers the same refetch. Sending it back would just be an unused,
  // easily-misread-as-a-diff payload, so it's intentionally not part of the response.
  await updateActiveAdmission({
    bedId, userId: req.user!.id,
    ipLast6: ip_last6, admissionType: admission_type,
    patientName: patient_name, admissionDate: admission_date,
    departmentName: department_name,
    doctorId: doctor_id, departmentId: department_id, consultantGroupId: consultant_group_id,
    payerType: payer_type,
  });

  const stationRow = await db.prepare(
    "SELECT station_id FROM wards WHERE id=?"
  ).get<{ station_id: number | null }>(owns.ward_id);
  const blockName = blocks.find(b => b.id === owns.pre_block_id)?.name ?? "";
  emitUpdate("bed:update", { bedId, wardId: owns.ward_id, floor: blockName }, {
    pre: String(owns.pre_block_id),
    stationId: stationRow?.station_id ?? undefined,
  });
  res.json({ ok: true });
}));

// ── Overstay alerts scoped to this PRE user's blocks ─────────────────────────
// Overstay = System Checkout done, Physical Checkout not done, and at least
// 1 hour since System Checkout completed — same definition as coo.ts/nurse.ts's
// versions (see coo.ts for the full rationale). This route previously used a
// different, older definition ("planned discharge date passed"), which is a
// totally different thing and was showing Discharge Lounge patients (Physical
// Checkout already done, waiting on System Checkout) as if they were
// overstaying, when they're actually the opposite case.
router.get("/overstay", asyncH(async (req, res) => {
  const blocks   = await myPreBlocks(req);
  const blockIds = blocks.map(b => b.id);
  const oneHourAgoMs = Date.now() - 60 * 60 * 1000;

  const wardRows = await db.prepare(
    `SELECT ward_id FROM pre_block_wards WHERE pre_block_id = ANY(?)`
  ).all<{ ward_id: number }>(blockIds);
  const wardIds = wardRows.map(r => r.ward_id);

  if (wardIds.length === 0) return res.json({ total: 0, tier1: 0, tier2: 0, tier3: 0, rows: [] });

  const rows = await db.prepare(`
    SELECT
      pa.id                                                          AS admission_id,
      pa.ip_last6,
      pa.admitted_at,
      COALESCE(dm.name, pa.consultant_name, 'Unknown')              AS doctor,
      w.name                                                         AS ward,
      bd.bed_name                                                    AS bed,
      dt.planned_date,
      dt.status                                                      AS discharge_status,
      dt.system_checkout_completed_at,
      GREATEST(0, CURRENT_DATE - to_timestamp(dt.system_checkout_completed_at / 1000.0)::date) AS days_overdue
    FROM patient_admissions pa
    JOIN discharge_tracking dt ON dt.admission_id = pa.id
    JOIN wards w ON w.id = pa.ward_id
    JOIN bed_details bd ON bd.id = pa.bed_id
    LEFT JOIN doctors_master dm ON dm.id = pa.doctor_id
    WHERE pa.status = 'ACTIVE'
      AND pa.ward_id = ANY(?)
      AND dt.status IN ('DISCHARGE_INITIATED', 'IN_PROGRESS')
      AND dt.system_checkout_status = 'COMPLETED'
      AND dt.physical_checkout_status <> 'COMPLETED'
      AND dt.system_checkout_completed_at <= ?
    ORDER BY dt.system_checkout_completed_at ASC
  `).all<{
    admission_id: number; ip_last6: string; admitted_at: number;
    doctor: string; ward: string; bed: string;
    planned_date: string; discharge_status: string;
    system_checkout_completed_at: number; days_overdue: number;
  }>(wardIds, oneHourAgoMs);

  const total = rows.length;
  const tier1 = rows.filter(r => Number(r.days_overdue) === 1).length;
  const tier2 = rows.filter(r => Number(r.days_overdue) >= 2 && Number(r.days_overdue) <= 3).length;
  const tier3 = rows.filter(r => Number(r.days_overdue) >= 4).length;
  res.json({ total, tier1, tier2, tier3, rows });
}));

export default router;
