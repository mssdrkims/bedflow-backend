import { Router } from "express";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH } from "../middleware/error.js";
import { allWardsLive, allBedDetailsLive, adminDashboard, adminDashboardHistory, consultantsLive } from "../services/bedService.js";
import { listPayerTypes } from "../services/payerTypeService.js";
import { db } from "../db/index.js";

const router = Router();
router.use(authRequired, requireRole("CONSULTANT"));

// Every consultant-scoped query below filters by ownership (individual doctor OR
// Consultant Group membership) instead of matching consultant_name text, same
// resolution as consultantGroupService.ownsAdmission. -1 is a safe sentinel for a
// login with no doctor_master_id linked yet — it can never match a real
// doctors_master id, so such a login simply sees nothing instead of erroring.
function myDoctorMasterId(req: { user?: { doctor_master_id?: number | null } }): number {
  return req.user?.doctor_master_id ?? -1;
}

// ── Dashboard mirrors COO dashboard (read-only, no unit-type restriction) ─────

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

router.get("/payer-types", asyncH(async (_req, res) => {
  res.json({ payerTypes: await listPayerTypes(true) });
}));

router.get("/admin-dashboard-history", asyncH(async (req, res) => {
  const unit = typeof req.query.unit === "string" ? req.query.unit : null;
  res.json({ snapshots: await adminDashboardHistory(48, unit) });
}));

router.get("/consultants", asyncH(async (req, res) => {
  const full = await consultantsLive();
  // Hide other consultants — only show the logged-in consultant's own row.
  // To enable: uncomment the filter below and remove the empty array.
  // const me = req.user!;
  // const myName = me.name || me.username || "";
  // full.consultants = full.consultants.filter(c => c.name === myName);
  full.consultants = [];
  res.json(full);
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

// ── My Wards: wards where this consultant has active patients ────────────────

router.get("/my-wards", asyncH(async (req, res) => {
  const dmi = myDoctorMasterId(req);

  const rows = await db.prepare(
    `SELECT
       w.id, w.name, w.unit_type, w.bed_type, w.total_beds,
       COUNT(bd.id)::int AS my_beds
     FROM wards w
     JOIN bed_details bd ON bd.ward_id = w.id
     JOIN patient_admissions pa ON pa.bed_id = bd.id AND pa.status = 'ACTIVE'
     WHERE ((pa.owner_type='DOCTOR' AND pa.doctor_id = $1)
         OR (pa.owner_type='GROUP' AND EXISTS (
               SELECT 1 FROM consultant_group_members m
               WHERE m.group_id = pa.consultant_group_id AND m.doctor_id = $1)))
       AND w.operational = true
     GROUP BY w.id, w.name, w.unit_type, w.bed_type, w.total_beds
     ORDER BY w.name`
  ).all<Record<string, unknown>>(dmi);

  res.json({ wards: rows });
}));

// ── Beds for a ward: only the consultant's active patient beds ───────────────

router.get("/beds/:wardId", asyncH(async (req, res) => {
  const dmi = myDoctorMasterId(req);
  const wardId = Number(req.params.wardId);

  const rows = await db.prepare(
    `SELECT
       bd.id, bd.ward_id, bd.bed_name, bd.physical_status, bd.reservation_status,
       bd.bed_type, bd.operational_status, bd.payer_type, bd.destination, bd.reservation_note,
       bd.updated_at, row_to_json(dt.*) AS discharge_tracking,
       pa.ip_last6, pa.patient_name, pa.admission_date, pa.admission_type, pa.consultant_name, pa.department_name,
       pa.doctor_id, pa.department_id, pa.owner_type, pa.consultant_group_id
     FROM bed_details bd
     JOIN patient_admissions pa ON pa.bed_id = bd.id AND pa.status = 'ACTIVE'
     LEFT JOIN discharge_tracking dt ON dt.admission_id = pa.id
     WHERE bd.ward_id = $1
       AND ((pa.owner_type='DOCTOR' AND pa.doctor_id = $2)
         OR (pa.owner_type='GROUP' AND EXISTS (
               SELECT 1 FROM consultant_group_members m
               WHERE m.group_id = pa.consultant_group_id AND m.doctor_id = $2)))
     ORDER BY
       substring(bd.bed_name from '^[^0-9]*') ASC,
       NULLIF(substring(bd.bed_name from '[0-9]+'), '')::bigint NULLS LAST,
       bd.bed_name ASC`
  ).all<Record<string, unknown>>(wardId, dmi);

  res.json({ beds: rows });
}));

// ── My Patients: active beds where this consultant is attached ────────────────

router.get("/my-patients", asyncH(async (req, res) => {
  const dmi = myDoctorMasterId(req);

  const rows = await db.prepare(
    `SELECT
       bd.id          AS bed_id,
       bd.bed_name,
       bd.ward_id,
       w.name         AS ward_name,
       bd.physical_status,
       bd.reservation_status,
       bd.destination,
       bd.reservation_note,
       bd.operational_status,
       bd.updated_at,
       pa.id          AS admission_id,
       pa.consultant_name,
       pa.department_name,
       pa.owner_type,
       pa.consultant_group_id,
       pa.ip_last6,
       pa.patient_name,
       pa.admission_date,
       pa.admission_type,
       bd.payer_type,
       pa.admitted_at,
       row_to_json(dt.*) AS discharge_tracking
     FROM bed_details bd
     JOIN wards w ON w.id = bd.ward_id
     JOIN patient_admissions pa ON pa.bed_id = bd.id AND pa.status = 'ACTIVE'
     LEFT JOIN discharge_tracking dt ON dt.admission_id = pa.id
     WHERE ((pa.owner_type='DOCTOR' AND pa.doctor_id = $1)
         OR (pa.owner_type='GROUP' AND EXISTS (
               SELECT 1 FROM consultant_group_members m
               WHERE m.group_id = pa.consultant_group_id AND m.doctor_id = $1)))
       AND w.operational = true
     ORDER BY w.name,
       substring(bd.bed_name from '^[^0-9]*') ASC,
       NULLIF(substring(bd.bed_name from '[0-9]+'), '')::bigint NULLS LAST,
       bd.bed_name ASC`
  ).all<Record<string, unknown>>(dmi);

  res.json({ patients: rows });
}));

// ── My Discharges: completed discharges for this consultant ──────────────────

router.get("/my-discharges", asyncH(async (req, res) => {
  const dmi = myDoctorMasterId(req);
  const from  = typeof req.query.from  === "string" ? Number(req.query.from)  : null;
  const to    = typeof req.query.to    === "string" ? Number(req.query.to)    : null;
  const limit = Math.min(Number(req.query.limit) || 100, 200);

  const rows = await db.prepare(
    `SELECT
       bd.id          AS bed_id,
       bd.bed_name,
       bd.ward_id,
       w.name         AS ward_name,
       pa.consultant_name,
       pa.department_name,
       pa.ip_last6,
       pa.patient_name,
       pa.admission_date,
       pa.admission_type,
       bd.payer_type,
       pa.admitted_at,
       pa.discharged_at,
       row_to_json(dt.*) AS discharge_tracking
     FROM patient_admissions pa
     JOIN bed_details bd ON bd.id = pa.bed_id
     JOIN wards w ON w.id = bd.ward_id
     LEFT JOIN discharge_tracking dt ON dt.admission_id = pa.id
     WHERE ((pa.owner_type='DOCTOR' AND pa.doctor_id = $1)
         OR (pa.owner_type='GROUP' AND EXISTS (
               SELECT 1 FROM consultant_group_members m
               WHERE m.group_id = pa.consultant_group_id AND m.doctor_id = $1)))
       AND pa.status = 'DISCHARGED'
       ${from ? "AND pa.updated_at >= $2" : ""}
       ${to   ? `AND pa.updated_at <= ${from ? "$3" : "$2"}` : ""}
     ORDER BY pa.updated_at DESC
     LIMIT ${limit}`
  ).all<Record<string, unknown>>(
    ...[dmi, ...(from ? [from] : []), ...(to ? [to] : [])]
  );

  res.json({ discharges: rows });
}));

export default router;
