import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { listBeds, updateBedStatus, getBedDetail } from "../services/bedDetailService.js";
import { listPayerTypes } from "../services/payerTypeService.js";
import { listDestinations } from "../services/destinationService.js";
import { allWardsLive, allBedDetailsLive, adminDashboard, adminDashboardHistory, consultantsLive } from "../services/bedService.js";
import { emitUpdate } from "../websocket/io.js";
import { audit } from "../services/auditService.js";
import { db } from "../db/index.js";

interface NaaAssignment { id: number; ward_id: number; access_type: string; bed_names: string; station_id: number | null; }

// Joins through to the ward's station so overrides can be scoped per station —
// a nurse covering two stations may have ward-level overrides in one of them
// while still getting full default access to the other.
async function getNurseAssignments(nurseId: number): Promise<NaaAssignment[]> {
  return db.prepare(
    `SELECT naa.id, naa.ward_id, naa.access_type, naa.bed_names, w.station_id
     FROM nurse_access_assignments naa
     JOIN wards w ON w.id = naa.ward_id
     WHERE naa.nurse_id=? AND naa.status='active'`
  ).all<NaaAssignment>(nurseId);
}

/** Stations where this nurse has at least one ward-level override configured
 * — within those stations, only the explicitly assigned wards are visible.
 * Stations with no rows here keep full default access to every ward. */
function stationsWithOverrides(assignments: NaaAssignment[]): Set<number> {
  return new Set(assignments.map(a => a.station_id).filter((id): id is number => id != null));
}

export async function canNurseAccessBed(nurseId: number, bedId: number, stationIds: number[]): Promise<boolean> {
  const bd = await db.prepare(
    "SELECT bd.ward_id, bd.bed_name, w.station_id FROM bed_details bd JOIN wards w ON w.id=bd.ward_id WHERE bd.id=?"
  ).get<{ ward_id: number; bed_name: string; station_id: number | null }>(bedId);
  if (!bd || bd.station_id == null || !stationIds.includes(bd.station_id)) return false;

  const assignments = await getNurseAssignments(nurseId);
  if (!stationsWithOverrides(assignments).has(bd.station_id)) return true; // whole station open

  const asgn = assignments.find(a => a.ward_id === bd.ward_id);
  if (!asgn) return false; // this station has overrides, but none for this ward
  if (asgn.access_type === "FULL") return true;
  let allowed: string[] = [];
  try { allowed = JSON.parse(asgn.bed_names || "[]"); } catch { /* ignore */ }
  return allowed.includes(bd.bed_name);
}

const router = Router();
router.use(authRequired, requireRole("NURSE"));

/** Resolve all stations this nurse is assigned to, directly from DB — always fresh, no JWT dependency. */
export async function getMyStations(req: { user?: { id: number } }): Promise<{ id: number; name: string }[]> {
  const userId = req.user?.id;
  if (!userId) throw new HttpError(401, "Please sign in to continue.");
  const rows = await db.prepare(
    `SELECT ns.id, ns.name
     FROM nurse_stations nst
     JOIN nursing_stations ns ON ns.id = nst.station_id
     WHERE nst.nurse_id = ?
     ORDER BY ns.name`
  ).all<{ id: number; name: string }>(userId);
  if (rows.length === 0) throw new HttpError(400, "No nursing station assigned to your account. Contact your manager.");
  return rows;
}

const BED_ORDER_SQL = `
  ORDER BY
    substring(bed_name from '^[^0-9]*') ASC,
    NULLIF(substring(bed_name from '[0-9]+'), '')::bigint NULLS LAST,
    bed_name ASC`;

router.get("/me", asyncH(async (req, res) => {
  const stations = await getMyStations(req);
  const stationIds = stations.map(s => s.id);
  const assignments = await getNurseAssignments(req.user!.id);
  const overriddenStations = stationsWithOverrides(assignments);
  const openStationIds = stationIds.filter(id => !overriddenStations.has(id));
  const overriddenWardIds = assignments.map(a => a.ward_id);

  const openWards = openStationIds.length ? await db.prepare(`
    SELECT w.id, w.name, w.station_id, w.unit_type, w.room_type, w.total_beds, w.operational,
           b.vacant, b.reserved, b.occupied,
           bb.name AS block_name, bb.label AS block_label,
           f.name AS floor_name
    FROM wards w
    LEFT JOIN beds b ON b.ward_id = w.id
    JOIN floors f ON f.id = w.floor_id
    JOIN building_blocks bb ON bb.id = f.building_block_id
    WHERE w.station_id = ANY(?)
    ORDER BY w.operational DESC, bb.sort_order, bb.name, f.sort_order, w.name
  `).all(openStationIds) as Array<Record<string, unknown>> : [];

  const assignedWardRows = overriddenWardIds.length ? await db.prepare(`
    SELECT w.id, w.name, w.station_id, w.unit_type, w.room_type, w.total_beds, w.operational,
           b.vacant, b.reserved, b.occupied,
           bb.name AS block_name, bb.label AS block_label,
           f.name AS floor_name
    FROM wards w
    LEFT JOIN beds b ON b.ward_id = w.id
    LEFT JOIN floors f ON f.id = w.floor_id
    LEFT JOIN building_blocks bb ON bb.id = f.building_block_id
    WHERE w.id = ANY(?)
    ORDER BY bb.sort_order NULLS LAST, bb.name NULLS LAST, f.sort_order NULLS LAST, w.name
  `).all(overriddenWardIds) as Array<Record<string, unknown>> : [];

  // For BEDS-type access, mark wards where bed_names is empty rather than
  // silently dropping them — nurse sees the card with a warning instead of
  // the ward disappearing with no explanation.
  const filteredAssigned = assignedWardRows.map(w => {
    const asgn = assignments.find(a => a.ward_id === w.id)!;
    if (asgn.access_type !== "BEDS") return w;
    let allowed: string[] = [];
    try { allowed = JSON.parse(asgn.bed_names || "[]"); } catch { /* ignore */ }
    if (allowed.length === 0)
      return { ...w, beds_warning: "No beds assigned to your account for this ward. Contact your manager." };
    return w;
  });

  // Per-ward "reviewed" stamp (see POST /wards/:id/review below) — merged in
  // here so WardPage shows the right status the moment it opens, same as
  // wardsForPreBlock() does for PRE.
  const allWardIdsForReview = [...openWards, ...filteredAssigned].map(w => (w as { id: number }).id);
  const reviewRows = allWardIdsForReview.length ? await db.prepare(
    "SELECT ward_id, MAX(reviewed_at) AS reviewed_at FROM nurse_ward_reviews WHERE ward_id = ANY(?) GROUP BY ward_id"
  ).all<{ ward_id: number; reviewed_at: number }>(allWardIdsForReview) : [];
  const reviewedAtByWard = new Map(reviewRows.map(r => [Number(r.ward_id), Number(r.reviewed_at)]));
  for (const w of [...openWards, ...filteredAssigned])
    (w as { reviewedAt?: number | null }).reviewedAt = reviewedAtByWard.get((w as { id: number }).id) ?? null;

  // Home's summary cards used to be computed client-side by reducing the whole
  // `wards` array in the browser (calculateWardTotals in bedUtils.js) — that
  // had no operational/Discharge-Lounge exclusion, so it silently double-
  // counted non-operational wards and lounge holding-beds as real capacity
  // (unlike the Dashboard, whose adminDashboard() SQL excludes both). Computed
  // here instead, once, in the DB, with the exact same exclusion so Home and
  // Dashboard numbers can't drift apart again.
  const allWardIds = [...openWards, ...filteredAssigned].map(w => (w as { id: number }).id);
  const totalsRows = allWardIds.length ? await db.prepare(`
    SELECT w.station_id,
      COUNT(*) FILTER (WHERE w.operational = true AND NOT w.is_discharge_lounge)::int AS wards,
      COALESCE(SUM(CASE WHEN w.operational = true AND NOT w.is_discharge_lounge THEN w.total_beds ELSE 0 END), 0)::int AS total_beds,
      COALESCE(SUM(CASE WHEN w.operational = true AND NOT w.is_discharge_lounge THEN COALESCE(b.vacant,0) + COALESCE(b.reserved,0) ELSE 0 END), 0)::int AS total_vacant,
      COALESCE(SUM(CASE WHEN w.operational = true AND NOT w.is_discharge_lounge THEN COALESCE(b.occupied,0) + COALESCE(b.occupied_reserved,0) ELSE 0 END), 0)::int AS total_occupied
    FROM wards w
    LEFT JOIN beds b ON b.ward_id = w.id
    WHERE w.id = ANY(?)
    GROUP BY w.station_id
  `).all<{ station_id: number; wards: number; total_beds: number; total_vacant: number; total_occupied: number }>(allWardIds) : [];

  const byStation: Record<number, { wards: number; totalBeds: number; totalVacant: number; totalOccupied: number }> = {};
  const grand = { wards: 0, totalBeds: 0, totalVacant: 0, totalOccupied: 0 };
  for (const r of totalsRows) {
    byStation[r.station_id] = { wards: r.wards, totalBeds: r.total_beds, totalVacant: r.total_vacant, totalOccupied: r.total_occupied };
    grand.wards += r.wards; grand.totalBeds += r.total_beds;
    grand.totalVacant += r.total_vacant; grand.totalOccupied += r.total_occupied;
  }

  res.json({
    nursing_station: stations.map(s => s.name).join(", "), station_id: stationIds[0],
    stations, wards: [...openWards, ...filteredAssigned],
    totals: { ...grand, byStation },
  });
}));

router.get("/wards/:id/beds", asyncH(async (req, res) => {
  const stations = await getMyStations(req);
  const stationIds = stations.map(s => s.id);
  const wardId = Number(req.params.id);
  const physicalStatus    = req.query.physical_status    as string | undefined;
  const reservationStatus = req.query.reservation_status as string | undefined;

  const ward = await db.prepare("SELECT id, station_id FROM wards WHERE id=?")
    .get<{ id: number; station_id: number | null }>(wardId);
  if (!ward || ward.station_id == null || !stationIds.includes(ward.station_id))
    throw new HttpError(403, "Ward not in your nursing station");

  const assignments = await getNurseAssignments(req.user!.id);
  if (stationsWithOverrides(assignments).has(ward.station_id)) {
    const asgn = assignments.find(a => a.ward_id === wardId);
    if (!asgn) throw new HttpError(403, "Ward not in your assignments");

    const allBeds = await listBeds(wardId, physicalStatus, reservationStatus, false, true);
    if (asgn.access_type === "BEDS") {
      let allowed: string[] = [];
      try { allowed = JSON.parse(asgn.bed_names || "[]"); } catch { /* ignore */ }
      const allowedSet = new Set(allowed);
      return res.json({ beds: allBeds.filter(b => allowedSet.has(b.bed_name)) });
    }
    return res.json({ beds: allBeds });
  }

  res.json({ beds: await listBeds(wardId, physicalStatus, reservationStatus, false, true) });
}));

// ── Review-confirm (manual "reviewed, nothing to update" stamp on one ward) ──
// Mirrors PRE's/Doctor's ward-level review exactly — same 5-minute cooldown,
// same fanout convention (station + ward, so the reviewing nurse's own live
// view refreshes — nurse sockets only join station:<id> rooms).
router.post("/wards/:id/review", asyncH(async (req, res) => {
  const stations = await getMyStations(req);
  const stationIds = stations.map(s => s.id);
  const wardId = Number(req.params.id);

  const ward = await db.prepare("SELECT id, station_id FROM wards WHERE id=?")
    .get<{ id: number; station_id: number | null }>(wardId);
  if (!ward || ward.station_id == null || !stationIds.includes(ward.station_id))
    throw new HttpError(403, "Ward not in your nursing station");

  const assignments = await getNurseAssignments(req.user!.id);
  if (stationsWithOverrides(assignments).has(ward.station_id) && !assignments.some(a => a.ward_id === wardId))
    throw new HttpError(403, "Ward not in your assignments");

  const REVIEW_COOLDOWN_MS = 5 * 60 * 1000;
  const lastReview = await db.prepare(
    "SELECT reviewed_at FROM nurse_ward_reviews WHERE ward_id=? ORDER BY reviewed_at DESC LIMIT 1"
  ).get<{ reviewed_at: number }>(wardId);
  if (lastReview) {
    const waitMs = REVIEW_COOLDOWN_MS - (Date.now() - Number(lastReview.reviewed_at));
    if (waitMs > 0)
      throw new HttpError(429, `You can review this ward again in ${Math.ceil(waitMs / 60000)}m`);
  }

  const t = Date.now();
  await db.prepare(
    "INSERT INTO nurse_ward_reviews (ward_id, user_id, reviewed_at) VALUES (?,?,?)"
  ).run(wardId, req.user!.id, t);
  await audit(req.user!.id, "nurse_ward_review", String(wardId), { stationId: ward.station_id });

  emitUpdate("bed:update", { wardId, reviewedAt: t }, { stationId: ward.station_id, wardId });
  res.json({ ok: true, reviewedAt: t });
}));

/** Every ward id this nurse can see — full-station wards plus any per-ward
 *  overrides — the hard access boundary for the "admin-style" dashboard
 *  below. Same ward-level granularity /nurse/me already uses; a nurse with a
 *  partial (BEDS-only) override still sees that ward's aggregate numbers
 *  elsewhere, so scoping the dashboard the same way is consistent.
 *  Always includes the Discharge Lounge ward, regardless of station — a
 *  nurse can move a patient there from the discharge flow even if the lounge
 *  isn't assigned to their own station, so they need to be able to see it. */
async function myWardIds(req: { user?: { id: number } }): Promise<number[]> {
  const stations = await getMyStations(req);
  const stationIds = stations.map(s => s.id);
  const assignments = await getNurseAssignments(req.user!.id);
  const overriddenStations = stationsWithOverrides(assignments);
  const openStationIds = stationIds.filter(id => !overriddenStations.has(id));
  const overriddenWardIds = assignments.map(a => a.ward_id);

  const openWardRows = openStationIds.length
    ? await db.prepare("SELECT id FROM wards WHERE station_id = ANY(?)").all<{ id: number }>(openStationIds)
    : [];
  const wardIds = new Set([...openWardRows.map(r => r.id), ...overriddenWardIds]);
  const lounge = await db.prepare("SELECT id FROM wards WHERE is_discharge_lounge=true").get<{ id: number }>();
  if (lounge) wardIds.add(lounge.id);
  return [...wardIds];
}

// ── Admin-style dashboard, scoped to the caller's own wards only ────────────

router.get("/live-wards", asyncH(async (req, res) => {
  res.json(await allWardsLive(await myWardIds(req)));
}));

router.get("/bed-details", asyncH(async (req, res) => {
  res.json(await allBedDetailsLive(await myWardIds(req)));
}));

router.get("/admin-dashboard", asyncH(async (req, res) => {
  const unit = typeof req.query.unit === "string" ? req.query.unit : null;
  // includeLoungeSummary=false — Nurse is not Admin/COO; see adminDashboard()'s
  // doc comment in bedService.ts.
  res.json(await adminDashboard(unit, await myWardIds(req), false));
}));

router.get("/payer-types", asyncH(async (_req, res) => {
  res.json({ payerTypes: await listPayerTypes(true) });
}));

router.get("/destinations", asyncH(async (_req, res) => {
  res.json({ destinations: await listDestinations(true) });
}));

router.patch("/beds/:id/status", asyncH(async (req, res) => {
  const stations = await getMyStations(req);
  const stationIds = stations.map(s => s.id);
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

  const allowed = await canNurseAccessBed(req.user!.id, bedId, stationIds);
  if (!allowed) throw new HttpError(403, "You do not have access to this bed");

  const result = await updateBedStatus({
    bedId, physicalStatus: physical_status, reservationStatus: reservation_status,
    payerType: payer_type, destination, reservationNote: reservation_note, userId: req.user!.id,
    ipLast6: ip_last6, admissionType: admission_type, departmentName: department_name,
    patientName: patient_name, admissionDate: admission_date,
    doctorId: doctor_id, departmentId: department_id, consultantGroupId: consultant_group_id,
  });

  const preBlockRow = await db.prepare(
    "SELECT pre_block_id FROM pre_block_wards WHERE ward_id=?"
  ).get<{ pre_block_id: number }>(result.ward_id);

  // Broadcast to the ward's own station room(s) — not necessarily every station
  // this nurse happens to also cover.
  const wardStation = await db.prepare("SELECT station_id FROM wards WHERE id=?")
    .get<{ station_id: number | null }>(result.ward_id);
  const broadcastStationId = wardStation?.station_id ?? stationIds[0];

  // Full current row alongside the existing summary fields — lets every
  // connected client patch just this bed locally instead of refetching the
  // whole ward. Purely additive: existing fields, rooms, and triggers unchanged.
  const bedDetail = await getBedDetail(bedId);
  emitUpdate("bed:update", {
    bedId, wardId: result.ward_id, stationId: broadcastStationId,
    physicalStatus: physical_status, reservationStatus: reservation_status,
    payerType: result.payer_type, destination: result.destination, reservationNote: result.reservation_note,
    bed: bedDetail,
  }, {
    stationId: broadcastStationId,
    pre: preBlockRow ? String(preBlockRow.pre_block_id) : undefined,
  });
  res.json(result);
}));

// ── Hospital-wide dashboard (read-only) — same full-hospital view as PRE/COO ──
router.get("/hospital/live-wards", asyncH(async (_req, res) => {
  res.json(await allWardsLive());
}));

router.get("/hospital/bed-details", asyncH(async (_req, res) => {
  res.json(await allBedDetailsLive());
}));

router.get("/hospital/admin-dashboard", asyncH(async (req, res) => {
  const unit = typeof req.query.unit === "string" ? req.query.unit : null;
  // includeLoungeSummary=false — Nurse is not Admin/COO, even in this
  // hospital-wide view; see adminDashboard()'s doc comment in bedService.ts.
  res.json(await adminDashboard(unit, null, false));
}));

router.get("/hospital/admin-dashboard-history", asyncH(async (req, res) => {
  const unit = typeof req.query.unit === "string" ? req.query.unit : null;
  res.json({ snapshots: await adminDashboardHistory(48, unit) });
}));

router.get("/hospital/consultants", asyncH(async (_req, res) => {
  res.json(await consultantsLive());
}));

router.get("/hospital/snapshots", asyncH(async (_req, res) => {
  const rows = await db.prepare(
    "SELECT ts,total,vacant,reserved,occupied,payer_snapshot FROM occupancy_snapshots ORDER BY ts DESC LIMIT 48"
  ).all<{ ts: number; total: number; vacant: number; reserved: number; occupied: number; payer_snapshot: Record<string, number> | null }>();
  const snapshots = rows.reverse().map((r) => ({ ...r, payers: r.payer_snapshot || {} }));
  res.json({ snapshots });
}));

// ── Overstay alerts scoped to this nurse's stations ──────────────────────────
// Overstay = System Checkout done, Physical Checkout not done, and at least
// 1 hour since System Checkout completed — same definition as coo.ts's
// hospital-wide version, just station-scoped. See that route for the full
// rationale (this used to be "planned_date overdue," a different, narrower
// thing that also missed Discharge Lounge admissions entirely since the
// Lounge has no station_id — moot now, since a Lounge admission always has
// Physical Checkout already completed by the time it's there, so it can
// never match this definition's physical_checkout_status <> 'COMPLETED' gate).
router.get("/overstay", asyncH(async (req, res) => {
  const stations     = await getMyStations(req);
  const stationIds   = stations.map(s => s.id);
  const oneHourAgoMs = Date.now() - 60 * 60 * 1000;

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
      AND w.station_id = ANY(?)
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
  }>(stationIds, oneHourAgoMs);

  const total = rows.length;
  const tier1 = rows.filter(r => Number(r.days_overdue) === 1).length;
  const tier2 = rows.filter(r => Number(r.days_overdue) >= 2 && Number(r.days_overdue) <= 3).length;
  const tier3 = rows.filter(r => Number(r.days_overdue) >= 4).length;
  res.json({ total, tier1, tier2, tier3, rows });
}));

export default router;
