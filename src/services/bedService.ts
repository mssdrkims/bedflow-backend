import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import { startOfDayIST } from "../config/domain.js";
import { dashboardCounts } from "./dischargeService.js";

export interface WardView {
  id: number; ward: string; total: number;
  vacant: number | null; reserved: number | null; occupied: number | null;
  occupied_reserved: number | null;
  updatedAt: number | null;
  unit_type: string | null;
  station_id: number | null;
  nursing_station: string | null;
  operational: boolean;
  reviewedAt?: number | null;
  is_discharge_lounge?: boolean;
}

export interface PreSummary {
  v: number; r: number; o: number; or: number;
  total: number; wards: number; wardsDone: number; complete: boolean;
}

function normalizeDashboardUnitType(unitType?: string | null): string | null {
  const raw = (unitType || "").trim();
  if (!raw) return null;
  if (raw.includes("Renova")) return "Renova";
  if (raw === "KIMS") return "KIMS";
  return raw;
}

function dashboardUnitMatches(rawUnitType: string | null | undefined, selectedUnitType?: string | null) {
  const selected = normalizeDashboardUnitType(selectedUnitType);
  if (!selected || selected === "TOTAL") return true;
  return normalizeDashboardUnitType(rawUnitType) === selected;
}

function dashboardSnapshotUnitKeys(unitType?: string | null): string[] | null {
  const normalized = normalizeDashboardUnitType(unitType);
  if (!normalized || normalized === "TOTAL") return null;
  if (normalized === "Renova") return ["Renova", "KIMS - Renova"];
  return [normalized];
}

/** Ward ids whose unit_type matches the Unit toolbar's current selection —
 *  same normalization/grouping rules as adminDashboard()'s own filter (see
 *  dashboardUnitMatches above), driven entirely off whatever unit_type values
 *  actually exist on operational wards. Adding a new unit in Setup → Wards
 *  needs zero code changes here — it's picked up automatically. Returns null
 *  for "TOTAL"/empty (no filter, hospital-wide), matching every other wardIds
 *  convention in this file. Used by discharge.ts to make the Transaction
 *  Board's drilldown lists/counts respect the same Unit filter its card
 *  numbers already do. */
export async function wardIdsForUnit(unitType?: string | null): Promise<number[] | null> {
  const normalized = normalizeDashboardUnitType(unitType);
  if (!normalized || normalized === "TOTAL") return null;
  const rows = await db.prepare("SELECT id, unit_type FROM wards WHERE operational=true")
    .all<{ id: number; unit_type: string | null }>();
  return rows.filter((r) => dashboardUnitMatches(r.unit_type, unitType)).map((r) => r.id);
}

/** Admission ids of patients currently sitting in the Discharge Lounge whose
 *  most recent transfer came FROM one of the given wards. A lounge patient's
 *  patient_admissions.ward_id becomes the Lounge ward's id the moment they're
 *  transferred (see bedTransferService.ts's moveAdmission), so a plain
 *  "pa.ward_id = ANY(unitWardIds)" filter would silently drop every lounge
 *  patient once a Unit filter is active — same reasoning as
 *  loungeOriginBreakdown above, just returning admission ids instead of a
 *  count so callers can OR them into an existing ward-scoped query. */
export async function loungeOriginAdmissionIds(wardIds: number[] | null): Promise<number[]> {
  if (!wardIds || wardIds.length === 0) return [];
  const rows = await db.prepare(`
    SELECT pa.id
    FROM patient_admissions pa
    JOIN bed_details bd_lounge ON bd_lounge.id = pa.bed_id
    JOIN wards w_lounge ON w_lounge.id = bd_lounge.ward_id AND w_lounge.is_discharge_lounge AND w_lounge.operational = true
    JOIN LATERAL (
      SELECT bth.from_bed_id FROM bed_transfer_history bth
      WHERE bth.admission_id = pa.id ORDER BY bth.transferred_at DESC LIMIT 1
    ) lt ON true
    JOIN bed_details bd_from ON bd_from.id = lt.from_bed_id
    WHERE pa.status = 'ACTIVE' AND bd_from.ward_id = ANY(?)
  `).all<{ id: number }>(wardIds);
  return rows.map((r) => r.id);
}

export async function wardsForFloor(floorId: number): Promise<WardView[]> {
  return db.prepare(
    `SELECT w.id, w.name AS ward, w.total_beds AS total, w.unit_type,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved, b.updated_at AS "updatedAt"
     FROM wards w JOIN beds b ON b.ward_id = w.id
     WHERE w.floor_id = ? ORDER BY w.name`
  ).all<WardView>(floorId);
}

export async function wardsForPreBlock(preBlockId: number): Promise<WardView[]> {
  return db.prepare(
    `SELECT w.id, w.name AS ward, w.total_beds AS total, w.unit_type, w.operational,
            w.is_discharge_lounge,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved, b.updated_at AS "updatedAt",
            pwr.reviewed_at AS "reviewedAt"
     FROM pre_block_wards pbw
     JOIN wards w ON w.id = pbw.ward_id
     JOIN beds  b ON b.ward_id = w.id
     LEFT JOIN (
       SELECT ward_id, pre_block_id, MAX(reviewed_at) AS reviewed_at
       FROM pre_ward_reviews GROUP BY ward_id, pre_block_id
     ) pwr ON pwr.ward_id = w.id AND pwr.pre_block_id = pbw.pre_block_id
     WHERE pbw.pre_block_id = ? ORDER BY w.operational DESC, w.name`
  ).all<WardView>(preBlockId);
}

/** All wards across every PRE Block the user is assigned to (deduplicated). */
export async function wardsForUserBlocks(userId: number): Promise<WardView[]> {
  return db.prepare(
    `SELECT w.id, w.name AS ward, w.total_beds AS total, w.unit_type, w.operational,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved, b.updated_at AS "updatedAt"
     FROM wards w
     JOIN beds b ON b.ward_id = w.id
     WHERE w.id IN (
       SELECT DISTINCT pbw.ward_id
       FROM user_pre_blocks upb
       JOIN pre_block_wards pbw ON pbw.pre_block_id = upb.pre_block_id
       WHERE upb.user_id = ?
     )
     ORDER BY w.operational DESC, w.name`
  ).all<WardView>(userId);
}

/** All operational wards hospital-wide, no per-user assignment scoping — used by FC's
 *  Bed Entry, which (unlike PRE/Nurse) has no block/station assignment table to join
 *  through and is intentionally granted every operational ward instead. Includes the
 *  Discharge Lounge ward if it's operational, same as PRE's own ward lists do. */
export async function wardsOperationalHospitalWide(): Promise<WardView[]> {
  return db.prepare(
    `SELECT w.id, w.name AS ward, w.total_beds AS total, w.unit_type, w.operational,
            w.is_discharge_lounge,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved, b.updated_at AS "updatedAt"
     FROM wards w
     JOIN beds b ON b.ward_id = w.id
     WHERE w.operational = true
     ORDER BY w.name`
  ).all<WardView>();
}

/** Wards for each PRE Block a user is assigned to, grouped by block (preserves block membership). */
export async function wardsGroupedByBlock(userId: number): Promise<{ id: number; name: string; wards: WardView[] }[]> {
  const blocks = await db.prepare(
    `SELECT pb.id, pb.name
     FROM user_pre_blocks upb
     JOIN pre_blocks pb ON pb.id = upb.pre_block_id
     WHERE upb.user_id = ?
     ORDER BY pb.name`
  ).all<{ id: number; name: string }>(userId);

  const result: { id: number; name: string; wards: WardView[] }[] = [];
  for (const block of blocks)
    result.push({ id: block.id, name: block.name, wards: await wardsForPreBlock(block.id) });
  return result;
}

export function summarize(wards: WardView[]): PreSummary {
  let v = 0, r = 0, o = 0, or_ = 0, total = 0, wardsDone = 0;
  // Non-operational wards are shown to PRE but excluded from round counts
  const opWards = wards.filter(w => w.operational !== false);
  for (const w of opWards) {
    if (w.vacant !== null) wardsDone++;
    // Discharge Lounge is a virtual holding ward, not real hospital capacity —
    // PRE still has to report on it (counts toward wards/wardsDone/complete
    // below, same round-completion requirement as any other ward), but its
    // beds are excluded from the bed-count totals, matching the Admin
    // dashboard's Hospital Snapshot / Occupancy Board convention exactly
    // (see adminDashboard() in this file).
    if (w.is_discharge_lounge) continue;
    total += w.total;
    if (w.vacant !== null) {
      v += w.vacant || 0;
      r += w.reserved || 0;
      o += w.occupied || 0;
      or_ += w.occupied_reserved || 0;
    }
  }
  return {
    v, r, o, or: or_, total, wards: opWards.length, wardsDone,
    complete: opWards.length > 0 && wardsDone === opWards.length
  };
}

export async function updateWard(
  wardId: number,
  vacantNone: number, vacantReserved: number,
  occupiedNone: number, occupiedReserved: number,
  userId: number
) {
  const ward = await db.prepare(
    "SELECT id, name, total_beds AS total, floor_id FROM wards WHERE id = ?"
  ).get<{ id: number; name: string; total: number; floor_id: number }>(wardId);
  if (!ward) throw new HttpError(404, "Ward not found");

  const vn = Math.max(0, Math.floor(vacantNone));
  const vr = Math.max(0, Math.floor(vacantReserved));
  const on_ = Math.max(0, Math.floor(occupiedNone));
  const or_ = Math.max(0, Math.floor(occupiedReserved));
  if (vn + vr + on_ + or_ !== ward.total)
    throw new HttpError(400, `Counts must total ${ward.total} beds`);

  const now = Date.now();
  await db.transaction(async () => {
    await db.prepare(
      "UPDATE beds SET vacant=?, reserved=?, occupied=?, occupied_reserved=?, updated_at=?, updated_by=? WHERE ward_id=?"
    ).run(vn, vr, on_, or_, now, userId, wardId);
    await db.prepare(
      "INSERT INTO bed_status_updates (ward_id, ward_name, vacant_none, vacant_reserved, occupied_none, occupied_reserved, updated_by, created_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run(wardId, ward.name, vn, vr, on_, or_, userId, now);
  });

  const floorLabel = ward.floor_id
    ? (await db.prepare("SELECT name FROM floors WHERE id = ?")
      .get<{ name: string }>(ward.floor_id))?.name ?? String(ward.floor_id)
    : "unknown";
  await audit(userId, "ward_update", floorLabel, {
    ward: ward.name, vacant_none: vn, vacant_reserved: vr, occupied_none: on_, occupied_reserved: or_,
  });
  return { ward: ward.name, vacant: vn, reserved: vr, occupied: on_, occupied_reserved: or_, total: ward.total };
}

interface FloorOverviewItem {
  floor_id: number;
  building_block_id: number;
  pre: string;
  floor: string;
  label: string;
  wards: WardView[];
  summary: PreSummary;
  lastSubmittedAt: number | null;
  roundsToday: number;
  assignedUser: { id: number; name: string } | null;
}

export async function orgOverview(): Promise<{
  floors: { name: string; pres: FloorOverviewItem[] }[];
  totals: { v: number; r: number; o: number; or: number; total: number; presReporting: number; presTotal: number };
}> {
  // Each pre_block is annotated with the building_block of its first ward (lowest bb sort_order).
  // Wards that have no floor_id (or no building_block) get building_block_id = NULL → "Other" group.
  const preBlocks = await db.prepare(
    `SELECT DISTINCT ON (pb.id)
       pb.id, pb.name,
       bb.id   AS building_block_id,
       bb.name AS bb_name,
       bb.label AS bb_label,
       COALESCE(bb.sort_order, 9999) AS bb_sort
     FROM pre_blocks pb
     LEFT JOIN pre_block_wards pbw ON pbw.pre_block_id = pb.id
     LEFT JOIN wards w ON w.id = pbw.ward_id
     LEFT JOIN floors f ON f.id = w.floor_id
     LEFT JOIN building_blocks bb ON bb.id = f.building_block_id
     ORDER BY pb.id, bb.sort_order NULLS LAST`
  ).all<{
    id: number; name: string;
    building_block_id: number | null; bb_name: string | null; bb_label: string | null;
    bb_sort: number;
  }>();

  const today = startOfDayIST();

  if (preBlocks.length === 0) {
    return { floors: [], totals: { v: 0, r: 0, o: 0, or: 0, total: 0, presReporting: 0, presTotal: 0 } };
  }

  const blockIds = preBlocks.map(pb => pb.id);

  // Batch 1: all wards for all pre_blocks (station_id/nursing_station exposed so the
  // frontend can pivot to a nursing-station view without an extra round-trip)
  const allWardRows = await db.prepare(
    `SELECT pbw.pre_block_id, w.id, w.name AS ward, w.total_beds AS total, w.unit_type,
            w.station_id, w.nursing_station,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved, b.updated_at AS "updatedAt"
     FROM pre_block_wards pbw
     JOIN wards w ON w.id = pbw.ward_id
     JOIN beds  b ON b.ward_id = w.id
     WHERE pbw.pre_block_id = ANY(?) AND w.operational = true
     ORDER BY pbw.pre_block_id, w.name`
  ).all<WardView & { pre_block_id: number }>(blockIds);
  const wardsByBlock = new Map<number, WardView[]>();
  for (const { pre_block_id, ...w } of allWardRows) {
    const key = Number(pre_block_id);
    if (!wardsByBlock.has(key)) wardsByBlock.set(key, []);
    wardsByBlock.get(key)!.push(w);
  }

  // Batch 2: last submitted round per pre_block
  const lastRoundRows = await db.prepare(
    `SELECT pre_block_id, MAX(submitted_at) AS submitted_at
     FROM pre_rounds WHERE pre_block_id = ANY(?) GROUP BY pre_block_id`
  ).all<{ pre_block_id: number; submitted_at: number }>(blockIds);
  const lastRoundByBlock = new Map(lastRoundRows.map(r => [Number(r.pre_block_id), Number(r.submitted_at)]));

  // Batch 3: rounds submitted today per pre_block
  const countRows = await db.prepare(
    `SELECT pre_block_id, COUNT(*) AS c
     FROM pre_rounds WHERE submitted_at >= ? AND pre_block_id = ANY(?) GROUP BY pre_block_id`
  ).all<{ pre_block_id: number; c: number }>(today, blockIds);
  const roundCountByBlock = new Map(countRows.map(r => [Number(r.pre_block_id), Number(r.c)]));

  // Batch 4: one representative PRE user per pre_block (lowest id wins)
  const preUsers = await db.prepare(
    `SELECT DISTINCT ON (upb.pre_block_id) u.id, u.name, upb.pre_block_id
     FROM user_pre_blocks upb
     JOIN users u ON u.id = upb.user_id
     WHERE upb.pre_block_id = ANY(?) ORDER BY upb.pre_block_id, u.id`
  ).all<{ id: number; name: string; pre_block_id: number }>(blockIds);
  const userByBlock = new Map(preUsers.map(u => [Number(u.pre_block_id), u]));

  const floorItems: FloorOverviewItem[] = preBlocks.map(pb => {
    const wards = wardsByBlock.get(pb.id) ?? [];
    const bbGroupLabel = pb.bb_label || (pb.bb_name ? `Block ${pb.bb_name}` : null);
    return {
      floor_id: pb.id,
      building_block_id: pb.building_block_id ?? -1,
      pre: pb.name,
      floor: pb.name,
      label: bbGroupLabel ? `${bbGroupLabel} — ${pb.name}` : pb.name,
      wards,
      summary: summarize(wards),
      lastSubmittedAt: lastRoundByBlock.get(pb.id) ?? null,
      roundsToday: roundCountByBlock.get(pb.id) ?? 0,
      assignedUser: userByBlock.get(pb.id) ?? null,
    };
  });

  // Group by building_block, preserving sort order; pre_blocks with no building_block → "Other"
  const bbSeen = new Map<number | null, { name: string; sort: number }>();
  for (const pb of preBlocks) {
    const key = pb.building_block_id ?? null;
    if (!bbSeen.has(key)) {
      bbSeen.set(key, {
        name: pb.bb_label || (pb.bb_name ? `Block ${pb.bb_name}` : "Other"),
        sort: pb.bb_sort,
      });
    }
  }

  // Ensure every building_block appears even if it has no pre_blocks yet
  // (mirrors the old floor-based behaviour; lets admins see unconfigured blocks)
  const allBBs = await db.prepare(
    "SELECT id, name, label, sort_order FROM building_blocks ORDER BY sort_order, name"
  ).all<{ id: number; name: string; label: string | null; sort_order: number }>();
  for (const bb of allBBs) {
    if (!bbSeen.has(bb.id)) {
      bbSeen.set(bb.id, { name: bb.label || `Block ${bb.name}`, sort: bb.sort_order });
    }
  }

  const sortedKeys = Array.from(bbSeen.entries())
    .sort(([, a], [, b]) => a.sort - b.sort)
    .map(([k]) => k);
  const grouped = sortedKeys.map(key => ({
    name: bbSeen.get(key)!.name,
    pres: floorItems.filter(fi => (fi.building_block_id === -1 ? null : fi.building_block_id) === key),
  }));

  let v = 0, r = 0, o = 0, or_ = 0, total = 0, presReporting = 0, presTotal = 0;
  for (const item of floorItems) {
    v += item.summary.v;
    r += item.summary.r;
    o += item.summary.o;
    or_ += item.summary.or;
    total += item.summary.total;
    if (item.summary.wards > 0) {
      presTotal++;
      if (item.summary.wardsDone > 0) presReporting++;
    }
  }
  return { floors: grouped, totals: { v, r, o, or: or_, total, presReporting, presTotal } };
}

// ── All-wards live overview (bypasses pre_block_wards filter) ────────────────
// Used by the admin Live Bed Dashboard so wards updated by nurses but not
// assigned to any PRE block are still visible in the counts.
/** restrictWardIds scopes every result to only those wards — used by the PRE
 *  dashboard so a PRE user's "admin-style" view can never see other blocks'
 *  or hospital-wide numbers. null/omitted = hospital-wide (COO). */
export async function allWardsLive(restrictWardIds?: number[] | null) {
  const wards = await db.prepare(
    `SELECT w.id, w.name AS ward, w.total_beds AS total,
            w.unit_type, w.bed_type, w.room_type, w.is_discharge_lounge,
            bb.name AS block_name,
            f.name  AS floor_name,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved,
            b.updated_at AS "updatedAt",
            u_beds.role AS updated_by_role,
            u_beds.name AS updated_by_name,
            rv.reviewed_at AS "reviewedAt"
     FROM wards w
     JOIN beds b ON b.ward_id = w.id
     LEFT JOIN users u_beds ON u_beds.id = b.updated_by
     LEFT JOIN floors f ON f.id = w.floor_id
     LEFT JOIN building_blocks bb ON bb.id = f.building_block_id
     -- "Last reviewed" = newest confirmation for any block that holds this ward,
     -- from a PRE round, a PRE/Nurse per-ward review-confirm, or a Doctor
     -- review-confirm. Unlike beds.updated_at (last value change), this moves
     -- every time a PRE/Nurse/Doctor confirms the ward, even with no occupancy change.
     LEFT JOIN (
       SELECT ward_id, MAX(reviewed_at) AS reviewed_at FROM (
         SELECT pbw.ward_id, pr.submitted_at AS reviewed_at
         FROM pre_block_wards pbw
         JOIN pre_rounds pr ON pr.pre_block_id = pbw.pre_block_id
         UNION ALL
         -- Per-ward PRE review-confirm (no round submission required)
         SELECT pwr.ward_id, pwr.reviewed_at
         FROM pre_ward_reviews pwr
         UNION ALL
         -- Per-ward Nurse review-confirm
         SELECT nwr.ward_id, nwr.reviewed_at
         FROM nurse_ward_reviews nwr
         UNION ALL
         -- Block-wide doctor reviews (ward_id NULL) fan out to every ward in the block
         SELECT dbw.ward_id, dr.reviewed_at
         FROM doctor_block_wards dbw
         JOIN doctor_block_reviews dr ON dr.doctor_block_id = dbw.doctor_block_id AND dr.ward_id IS NULL
         UNION ALL
         -- Single-ward doctor reviews apply to that ward only
         SELECT dr.ward_id, dr.reviewed_at
         FROM doctor_block_reviews dr WHERE dr.ward_id IS NOT NULL
       ) src
       GROUP BY ward_id
     ) rv ON rv.ward_id = w.id
     WHERE w.operational = true ${restrictWardIds ? "AND w.id = ANY(?)" : ""}
     ORDER BY w.name`
  ).all<WardView & { bed_type: string | null; room_type: string | null; block_name: string | null; floor_name: string | null; reviewedAt: number | null; is_discharge_lounge: boolean; updated_by_role: string | null; updated_by_name: string | null }>(...(restrictWardIds ? [restrictWardIds] : []));

  const allBedRow = await db.prepare(
    `SELECT COALESCE(SUM(total_beds),0) AS all_beds,
            COALESCE(SUM(CASE WHEN operational = false THEN total_beds ELSE 0 END),0) AS non_op_beds
     FROM wards
     ${restrictWardIds ? "WHERE id = ANY(?)" : ""}`
  ).get<{ all_beds: number; non_op_beds: number }>(...(restrictWardIds ? [restrictWardIds] : []));

  // Per-ward payer breakdown so the dashboard's Payer Mix can be recomputed
  // client-side from whatever wards are currently visible (Unit + Search).
  //   payersLive  = currently occupied beds by payer in that ward (includes
  //                 occupied+reserved beds — a reserved bed still has a real
  //                 patient/payer, same reasoning as Total Patients including it)
  //   payersAdmit = beds taken OCCUPIED by payer, bucketed by time window
  //                 (today IST / last 7d / 30d / 12 months) for the range toggle.
  const IST = 5.5 * 3600 * 1000;
  const startOfTodayMs = Math.floor((Date.now() + IST) / 86400000) * 86400000 - IST;
  const d7Ms = Date.now() - 7 * 86400000;
  const d30Ms = Date.now() - 30 * 86400000;
  const y1Ms = Date.now() - 365 * 86400000;
  const wardIds = wards.map((w) => w.id);
  const [liveP, admitP, admitTypeP, overstayP, loungeP, deptLiveP] = wardIds.length === 0
    ? [[], [], [], [], [], []]
    : await Promise.all([
      db.prepare(
        `SELECT ward_id, payer_type, COUNT(*)::int AS n FROM bed_details
          WHERE payer_type IS NOT NULL AND physical_status = 'OCCUPIED'
            AND ward_id = ANY(?) GROUP BY ward_id, payer_type`
      ).all<{ ward_id: number; payer_type: string; n: number }>(wardIds),
      db.prepare(
        `SELECT ward_id, payer_type,
                COUNT(*) FILTER (WHERE changed_at >= ?)::int AS today,
                COUNT(*) FILTER (WHERE changed_at >= ?)::int AS d7,
                COUNT(*) FILTER (WHERE changed_at >= ?)::int AS d30,
                COUNT(*)::int                                AS y1
           FROM bed_movements
          WHERE new_physical = 'OCCUPIED' AND payer_type IS NOT NULL
            AND changed_at >= ? AND ward_id = ANY(?)
          GROUP BY ward_id, payer_type`
      ).all<{ ward_id: number; payer_type: string; today: number; d7: number; d30: number; y1: number }>(
        startOfTodayMs, d7Ms, d30Ms, y1Ms, wardIds
      ),
      // Per-ward admission type counts (IP / OPD / DAYCARE) for the ward table columns.
      db.prepare(
        `SELECT bd.ward_id, pa.admission_type, COUNT(*)::int AS n
           FROM bed_details bd
           JOIN patient_admissions pa ON pa.bed_id = bd.id AND pa.status = 'ACTIVE'
          WHERE bd.operational_status = true AND bd.ward_id = ANY(?)
          GROUP BY bd.ward_id, pa.admission_type`
      ).all<{ ward_id: number; admission_type: string; n: number }>(wardIds),
      // Per-ward overstay: system checkout done, patient still physically in bed.
      db.prepare(
        `SELECT bd.ward_id, COUNT(*)::int AS n
           FROM bed_details bd
           JOIN patient_admissions pa ON pa.bed_id = bd.id AND pa.status = 'ACTIVE'
           JOIN discharge_tracking dt ON dt.admission_id = pa.id
          WHERE bd.physical_status = 'OCCUPIED'
            AND bd.reservation_status = 'NONE'
            AND dt.system_checkout_status = 'COMPLETED'
            AND dt.patient_left IS DISTINCT FROM true
            AND bd.operational_status = true
            AND bd.ward_id = ANY(?)
          GROUP BY bd.ward_id`
      ).all<{ ward_id: number; n: number }>(wardIds),
      // Per-ward discharge lounge count: patients currently in the lounge who
      // originated from each ward (traced via the most recent bed transfer).
      db.prepare(
        `SELECT bd_from.ward_id AS origin_ward_id, COUNT(*)::int AS n
           FROM patient_admissions pa
           JOIN bed_details bd_lounge ON bd_lounge.id = pa.bed_id
           JOIN wards w_lounge ON w_lounge.id = bd_lounge.ward_id
             AND w_lounge.is_discharge_lounge AND w_lounge.operational = true
           JOIN LATERAL (
             SELECT bth.from_bed_id FROM bed_transfer_history bth
             WHERE bth.admission_id = pa.id ORDER BY bth.transferred_at DESC LIMIT 1
           ) lt ON true
           JOIN bed_details bd_from ON bd_from.id = lt.from_bed_id
          WHERE pa.status = 'ACTIVE' AND bd_from.ward_id = ANY(?)
          GROUP BY bd_from.ward_id`
      ).all<{ origin_ward_id: number; n: number }>(wardIds),
      // Per-ward department breakdown (on-bed occupied beds by department name, excludes occ+res).
      db.prepare(
        `SELECT bd.ward_id, pa.department_name, COUNT(*)::int AS n
           FROM bed_details bd
           JOIN patient_admissions pa ON pa.bed_id = bd.id AND pa.status = 'ACTIVE'
          WHERE pa.department_name IS NOT NULL AND bd.operational_status = true
            AND bd.physical_status = 'OCCUPIED' AND bd.reservation_status = 'NONE'
            AND bd.ward_id = ANY(?)
          GROUP BY bd.ward_id, pa.department_name`
      ).all<{ ward_id: number; department_name: string; n: number }>(wardIds),
    ]);
  const liveByWard = new Map<number, Record<string, number>>();
  for (const row of liveP) {
    const m = liveByWard.get(row.ward_id) ?? {}; m[row.payer_type] = row.n; liveByWard.set(row.ward_id, m);
  }
  type Admit = { today: Record<string, number>; d7: Record<string, number>; d30: Record<string, number>; y1: Record<string, number> };
  const admitByWard = new Map<number, Admit>();
  for (const row of admitP) {
    const m = admitByWard.get(row.ward_id) ?? { today: {}, d7: {}, d30: {}, y1: {} };
    if (row.today) m.today[row.payer_type] = row.today;
    if (row.d7) m.d7[row.payer_type] = row.d7;
    if (row.d30) m.d30[row.payer_type] = row.d30;
    if (row.y1) m.y1[row.payer_type] = row.y1;
    admitByWard.set(row.ward_id, m);
  }
  const admitTypeByWard = new Map<number, Record<string, number>>();
  for (const row of admitTypeP) {
    const m = admitTypeByWard.get(row.ward_id) ?? {}; m[row.admission_type] = row.n; admitTypeByWard.set(row.ward_id, m);
  }
  const overstayByWard = new Map<number, number>();
  for (const row of overstayP) overstayByWard.set(row.ward_id, row.n);
  const loungeByWard = new Map<number, number>();
  for (const row of loungeP) loungeByWard.set(row.origin_ward_id, row.n);
  const deptLiveByWard = new Map<number, Record<string, number>>();
  for (const row of deptLiveP) {
    const m = deptLiveByWard.get(row.ward_id) ?? {}; m[row.department_name] = row.n; deptLiveByWard.set(row.ward_id, m);
  }
  for (const w of wards) {
    const wr = w as unknown as Record<string, unknown>;
    wr.payersLive = liveByWard.get(w.id) ?? {};
    wr.payersAdmit = admitByWard.get(w.id) ?? { today: {}, d7: {}, d30: {}, y1: {} };
    wr.admissionTypes = admitTypeByWard.get(w.id) ?? {};
    wr.overstayCount = overstayByWard.get(w.id) ?? 0;
    wr.loungeCount = loungeByWard.get(w.id) ?? 0;
    wr.departmentsLive = deptLiveByWard.get(w.id) ?? {};
  }

  let v = 0, r = 0, o = 0, or_ = 0, total = 0;
  for (const w of wards) {
    v += w.vacant ?? 0;
    r += w.reserved ?? 0;
    o += w.occupied ?? 0;
    or_ += w.occupied_reserved ?? 0;
    total += w.total;
  }
  return {
    wards,
    totals: { v, r, o, or: or_, total },
    allBeds: Number(allBedRow?.all_beds ?? total),
    nonOpBeds: Number(allBedRow?.non_op_beds ?? 0),
  };
}

export interface LiveBedDetail {
  id: number; ward_id: number; ward: string; bed_name: string;
  physical_status: string; reservation_status: string;
  payer_type: string | null; bed_type: string; unit_type: string | null;
  destination: string | null; reservation_note: string | null;
  operational_status: boolean; updated_at: number | null;
  updated_by_name: string | null;
  discharge_tracking: unknown | null;
  admission_type: string | null;
  /** Only set for a bed in the Discharge Lounge — the real ward/bed the patient
   *  physically left before landing here (most recent bed_transfer_history row
   *  for their admission). Null for every ordinary bed. */
  origin_ward_id: number | null;
  origin_ward_name: string | null;
  origin_bed_name: string | null;
}

// Bed-level rows for the dashboard's Bed Explorer popup (click a KPI/payer
// card to see which beds make it up). Mirrors allWardsLive's WHERE clause
// (operational wards only) so the beds returned here always add up to the
// counts shown on the cards. updated_by_name resolves to the staff member's
// name (not a doctor — this system has no patient/doctor records at all).
// bed_type is sourced from the WARD (w.bed_type), not the bed — Census/Non-
// Census is ward-level everywhere, so the Explorer's own classify()/filter
// logic (BedExplorerModal.jsx) sees the same answer the cards computed.
/** restrictWardIds — see allWardsLive(). Same scoping contract. */
export async function allBedDetailsLive(restrictWardIds?: number[] | null) {
  return db.prepare(
    `SELECT bd.id, bd.ward_id, w.name AS ward, w.unit_type, w.bed_type,
            bd.bed_name, bd.physical_status, bd.reservation_status, bd.payer_type,
            bd.destination, bd.reservation_note, bd.operational_status,
            bd.updated_at, u.name AS updated_by_name, row_to_json(dt.*) AS discharge_tracking,
            -- patient_name/admission_date ride along on the same active-admission
            -- join the IP already uses, so every role reading this feed (PRE, FC,
            -- Nurse, Doctor, COO, Pharmacy, Consultant) gets them at no extra cost.
            -- patient_name is what makes Entry search by patient name possible.
            pa.admission_type, pa.ip_last6, pa.patient_name, pa.admission_date,
            w_from.id AS origin_ward_id, w_from.name AS origin_ward_name, bd_from.bed_name AS origin_bed_name
     FROM bed_details bd
     JOIN wards w ON w.id = bd.ward_id
     LEFT JOIN users u ON u.id = bd.updated_by
     LEFT JOIN patient_admissions pa ON pa.bed_id = bd.id AND pa.status = 'ACTIVE'
     LEFT JOIN discharge_tracking dt ON dt.admission_id = pa.id
     -- Origin ward/bed — lounge beds only. The ON condition short-circuits this
     -- for every ordinary bed, so it costs nothing outside the Discharge Lounge.
     LEFT JOIN LATERAL (
       SELECT bth.from_bed_id, bth.from_ward_id FROM bed_transfer_history bth
       WHERE bth.admission_id = pa.id ORDER BY bth.transferred_at DESC LIMIT 1
     ) lt ON w.is_discharge_lounge AND pa.id IS NOT NULL
     LEFT JOIN bed_details bd_from ON bd_from.id = lt.from_bed_id
     LEFT JOIN wards w_from ON w_from.id = lt.from_ward_id
     WHERE w.operational = true ${restrictWardIds ? "AND w.id = ANY(?)" : ""}
     ORDER BY w.name,
       substring(bd.bed_name from '^[^0-9]*') ASC,
       NULLIF(substring(bd.bed_name from '[0-9]+'), '')::bigint NULLS LAST,
       bd.bed_name ASC`
  ).all<LiveBedDetail>(...(restrictWardIds ? [restrictWardIds] : []));
}

export async function snapshotOccupancy() {
  const { totals } = await orgOverview();

  // Per-payer occupied-bed breakdown at this instant, so Dashboard payer cards
  // can build a real sparkline over time (no history before this column existed).
  const payerRows = await db.prepare(
    `SELECT payer_type, COUNT(*)::int AS n FROM bed_details
     WHERE physical_status='OCCUPIED' AND payer_type IS NOT NULL
     GROUP BY payer_type`
  ).all<{ payer_type: string; n: number }>();
  const payerSnapshot: Record<string, number> = {};
  for (const r of payerRows) payerSnapshot[r.payer_type] = r.n;

  await db.prepare(
    "INSERT INTO occupancy_snapshots (ts, total, vacant, reserved, occupied, payer_snapshot) VALUES (?,?,?,?,?,?)"
  ).run(Date.now(), totals.total, totals.v, totals.r, totals.o, JSON.stringify(payerSnapshot));
}

// ── Midnight census ──────────────────────────────────────────────────────────
// One snapshot per IST day of every ward's live counts, captured at 00:00.

export async function captureMidnightCensus(date: string): Promise<boolean> {
  const exists = await db.prepare(
    "SELECT 1 FROM midnight_census WHERE census_date=?"
  ).get(date);
  if (exists) return false;

  const wards = await db.prepare(
    `SELECT w.id, w.name AS ward, w.total_beds AS total, w.unit_type, w.bed_type,
            b.vacant, b.reserved, b.occupied, b.occupied_reserved, b.updated_at AS "updatedAt"
     FROM wards w JOIN beds b ON b.ward_id = w.id ORDER BY w.name`
  ).all<WardView & { bed_type: string }>();

  await db.prepare(
    `INSERT INTO midnight_census (census_date, ts, snapshot)
     VALUES (?,?,?) ON CONFLICT (census_date) DO NOTHING`
  ).run(date, Date.now(), JSON.stringify(wards));
  return true;
}

export async function midnightCensusFor(date: string) {
  const row = await db.prepare(
    "SELECT ts, snapshot FROM midnight_census WHERE census_date=?"
  ).get<{ ts: number; snapshot: string }>(date);
  if (!row) return null;
  let wards: unknown[] = [];
  try { wards = JSON.parse(row.snapshot || "[]"); } catch { /* corrupt row */ }
  return { ts: row.ts, wards };
}

// ── Admin dashboard — Hospital Snapshot / Occupancy Board / Transaction Board ───
// "Lounge" (Discharge Lounge) beds are a real bed_type but never counted in these
// cards — they're virtual holding beds, not real hospital capacity, and would
// distort every count here if included.
//
// state classification per bed (mutually exclusive, so buckets sum cleanly):
//   lounge      — an active admission sitting in the Discharge Lounge
//   overstay    — Occupied+None, System Checkout done but the patient hasn't
//                 actually left yet (billing/paperwork finished, bed still not
//                 free). Keyed off patient_left rather than physical_checkout_status
//                 — Physical Checkout can be marked COMPLETED with "Patient left: No",
//                 which still means the patient is physically in the bed. patient_left
//                 can never be true on an Occupied bed once System Checkout is already
//                 done — completeIfEligible vacates the bed in the same request the
//                 moment both are true — so this check is safe.
//   onbed       — Occupied+None, everything else (the default occupied case)
//   occ_res     — Occupied+Reserved (patient temporarily away — OT, Scanning)
//   vacant_none — Vacant, no reservation
//   vacant_res  — Vacant + Reserved (held for an incoming patient)
/** wardIds = null means hospital-wide (no unit filter applied).
 *  Census/Non-Census classification is ward-level (w.bed_type) — the single
 *  source of truth. bed_details.bed_type is never read for this; a bed always
 *  inherits its ward's type and can't be individually overridden (see
 *  bedDetailService.ts generateBeds/addSingleBed/updateBedMaster).
 *  Bed-level operational_status is also required here — a bed pulled out of
 *  service shouldn't register as onbed/occ_res/vacant/etc, same as it's
 *  already excluded from "Operational Beds" on the snapshot. */
async function bedStateBreakdown(wardIds: number[] | null) {
  return db.prepare(`
    SELECT w.bed_type, pa.admission_type, bd.payer_type,
      CASE
        WHEN w.is_discharge_lounge AND bd.physical_status='OCCUPIED' THEN 'lounge'
        WHEN bd.physical_status='OCCUPIED' AND bd.reservation_status='NONE'
             AND dt.system_checkout_status='COMPLETED' AND dt.patient_left IS DISTINCT FROM true
          THEN 'overstay'
        WHEN bd.physical_status='OCCUPIED' AND bd.reservation_status='NONE' THEN 'onbed'
        WHEN bd.physical_status='OCCUPIED' AND bd.reservation_status='RESERVED' THEN 'occ_res'
        WHEN bd.physical_status='VACANT' AND bd.reservation_status='NONE' THEN 'vacant_none'
        WHEN bd.physical_status='VACANT' AND bd.reservation_status='RESERVED' THEN 'vacant_res'
        ELSE 'other'
      END AS state,
      COUNT(*)::int AS c
    FROM bed_details bd
    JOIN wards w ON w.id = bd.ward_id
    LEFT JOIN patient_admissions pa ON pa.bed_id = bd.id AND pa.status = 'ACTIVE'
    LEFT JOIN discharge_tracking dt ON dt.admission_id = pa.id
    -- Same convention as allWardsLive/allBedDetailsLive/orgOverview: a bed in a
    -- shut-down ward isn't counted anywhere else in the app, so it shouldn't
    -- inflate these cards either — otherwise clicking a card to see its beds
    -- (Bed Explorer, which also excludes non-operational wards) shows fewer
    -- beds than the card's own number. Bed-level operational_status matches
    -- the same convention one level down.
    WHERE w.operational = true AND bd.operational_status = true ${wardIds ? "AND w.id = ANY(?)" : ""}
    GROUP BY w.bed_type, pa.admission_type, bd.payer_type, state
  `).all<{ bed_type: string; admission_type: string | null; payer_type: string | null; state: string; c: number }>(...(wardIds ? [wardIds] : []));
}

/** For every admission currently sitting in the Discharge Lounge, the bed_type of
 *  the WARD they were moved out of (their most recent transfer-in) — lounge
 *  beds have no Census/Non-Census identity of their own, so the CEO's Occupancy
 *  Board splits lounge occupancy by where each patient actually came from.
 *  wardIds scopes by the ORIGIN ward (where the patient came from), matching
 *  the Unit filter's meaning everywhere else on this dashboard. */
async function loungeOriginBreakdown(wardIds: number[] | null) {
  return db.prepare(`
    SELECT w_from.bed_type AS origin_bed_type, pa.admission_type, bd_lounge.payer_type, COUNT(*)::int AS c
    FROM patient_admissions pa
    JOIN bed_details bd_lounge ON bd_lounge.id = pa.bed_id
    JOIN wards w_lounge ON w_lounge.id = bd_lounge.ward_id AND w_lounge.is_discharge_lounge AND w_lounge.operational = true
    JOIN LATERAL (
      SELECT bth.from_bed_id FROM bed_transfer_history bth
      WHERE bth.admission_id = pa.id ORDER BY bth.transferred_at DESC LIMIT 1
    ) lt ON true
    JOIN bed_details bd_from ON bd_from.id = lt.from_bed_id
    JOIN wards w_from ON w_from.id = bd_from.ward_id
    -- Scoped by the patient's ORIGIN ward (bd_from), by design — that's what
    -- makes "Census"/"Non Census" mean anything for a lounge patient (the
    -- lounge ward itself has no bed_type of its own that matters here, and
    -- its own unit_type is always NULL so it can never match a unit filter —
    -- see totalPatients/patientType below, which rely on this instead of
    -- bedStateBreakdown's wardIds-scoped 'lounge' rows for the same reason).
    -- payer_type is read off bd_lounge (the patient's current, physical bed)
    -- since that's where the payer is actually assigned/tracked.
    WHERE pa.status = 'ACTIVE' ${wardIds ? "AND bd_from.ward_id = ANY(?)" : ""}
    GROUP BY w_from.bed_type, pa.admission_type, bd_lounge.payer_type
  `).all<{ origin_bed_type: string; admission_type: string | null; payer_type: string | null; c: number }>(...(wardIds ? [wardIds] : []));
}

/** unitType = null/undefined/"TOTAL" means hospital-wide — matches the COO
 *  dashboard's "Unit" toolbar filter (TOTAL + logical unit groups like KIMS /
 *  Renova, plus any other raw unit names).
 *  Every count below is scoped to the same set of wards so the whole board
 *  (Hospital Snapshot, Occupancy Board, Transaction Board) moves together
 *  when that filter changes, same as the ward tables and By Payer cards
 *  already did. */
/** restrictWardIds — see allWardsLive(). Intersects with the unitType filter
 *  when both are given (e.g. a PRE user filtering their own wards by unit). */
// includeLoungeSummary gates two read-only aggregate fields — occupancy.totalPatients
// and occupancy.lounge — behind the caller's role. It does NOT touch wardIds,
// bed_details, or any lounge-transfer/admission write path, so bed entry and
// transferring a patient into the Discharge Lounge are unaffected for every
// role; this only controls whether these two summary numbers are computed and
// sent back. Admin/COO (and the scheduler's own snapshot capture, which never
// passes this arg) always get the default `true`.
export async function adminDashboard(unitType?: string | null, restrictWardIds?: number[] | null, includeLoungeSummary = true) {
  const scoped = !!normalizeDashboardUnitType(unitType) && normalizeDashboardUnitType(unitType) !== "TOTAL";
  let wardIds = scoped
    ? (await db.prepare("SELECT id, unit_type FROM wards WHERE operational=true").all<{ id: number; unit_type: string | null }>())
      .filter((r) => dashboardUnitMatches(r.unit_type, unitType))
      .map(r => r.id)
    : null;
  if (restrictWardIds) {
    wardIds = wardIds ? wardIds.filter(id => restrictWardIds.includes(id)) : restrictWardIds;
  }

  const rows = await bedStateBreakdown(wardIds);
  const sum = (pred: (r: { bed_type: string; admission_type: string | null; payer_type: string | null; state: string }) => boolean) =>
    rows.filter(pred).reduce((s, r) => s + r.c, 0);
  const occStates = ["onbed", "overstay", "occ_res"];

  // Inventory counts — deliberately NOT filtered by bed-level operational_status
  // (a broken bed is still physically a bed; that's what "Operational Beds"
  // is for, distinguishing it from the raw total). Census/Non-Census here is
  // ward-level (w.bed_type), same source of truth as everywhere else.
  const snapshotRow = await db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE w.bed_type IN ('Census','Non-Census')) AS total_beds,
      COUNT(*) FILTER (WHERE w.bed_type IN ('Census','Non-Census') AND w.operational AND bd.operational_status) AS operational_beds,
      COUNT(*) FILTER (WHERE w.bed_type='Census' AND w.operational) AS census_beds,
      COUNT(*) FILTER (WHERE w.bed_type='Non-Census' AND w.operational) AS non_census_beds
    FROM bed_details bd
    JOIN wards w ON w.id = bd.ward_id
    ${wardIds ? "WHERE w.id = ANY(?)" : ""}
  `).get<Record<string, number>>(...(wardIds ? [wardIds] : []));

  const onbed = sum(r => r.state === "onbed");
  const overstay = sum(r => r.state === "overstay");
  const reserved = sum(r => r.state === "occ_res");
  const loungeOrigin = await loungeOriginBreakdown(wardIds);
  // Origin-scoped, not bedStateBreakdown's 'lounge' rows — the lounge ward's
  // own unit_type is always NULL, so wardIds (a unit filter) would otherwise
  // drop every lounge patient here whenever a specific unit is selected. See
  // loungeOriginBreakdown's comment.
  const loungePatients = loungeOrigin.reduce((s, r) => s + r.c, 0);
  const loungeBy = (bedType: string) => loungeOrigin.filter(r => r.origin_bed_type === bedType).reduce((s, r) => s + r.c, 0);
  const loungeAdmittedBy = (admissionType: string) => loungeOrigin.filter(r => r.admission_type === admissionType).reduce((s, r) => s + r.c, 0);
  const loungePaidBy = (payerType: string) => loungeOrigin.filter(r => r.payer_type === payerType).reduce((s, r) => s + r.c, 0);

  // Origin-scoped, same reasoning as patientType — a lounge patient's payer
  // only counts toward a unit if that's where they actually came from,
  // otherwise a unit filter would leak every other unit's lounge patients
  // into "By Payer" (the old bug: frontend summed the lounge ward's payer
  // mix unconditionally regardless of the active unit filter).
  const payerTypeNames = new Set<string>();
  for (const r of rows) if (r.payer_type) payerTypeNames.add(r.payer_type);
  for (const r of loungeOrigin) if (r.payer_type) payerTypeNames.add(r.payer_type);
  const payerType: Record<string, number> = {};
  for (const pt of payerTypeNames) {
    payerType[pt] = sum(r => r.payer_type === pt && occStates.includes(r.state)) + loungePaidBy(pt);
  }

  const todayStart = startOfDayIST();
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;
  const admissionsToday = await db.prepare(`
    SELECT COUNT(*)::int AS c FROM patient_admissions
    WHERE admitted_at >= ? AND admitted_at < ? ${wardIds ? "AND ward_id = ANY(?)" : ""}
  `).get<{ c: number }>(todayStart, todayEnd, ...(wardIds ? [wardIds] : []));
  const discharge = await dashboardCounts(wardIds);

  return {
    snapshot: {
      totalBeds: Number(snapshotRow?.total_beds || 0),
      operationalBeds: Number(snapshotRow?.operational_beds || 0),
      censusBeds: Number(snapshotRow?.census_beds || 0),
      nonCensusBeds: Number(snapshotRow?.non_census_beds || 0),
    },
    occupancy: {
      // Omitted entirely (not just zeroed) for roles that shouldn't see it —
      // see includeLoungeSummary above. res.json() drops undefined keys.
      totalPatients: includeLoungeSummary ? (onbed + overstay + reserved + loungePatients) : undefined,
      // Same as totalPatients minus the Discharge Lounge — on-bed + overstay +
      // reserved beds only, both Census and Non-Census (occStates covers all
      // three; lounge is excluded by definition).
      totalOccupancy: onbed + overstay + reserved,

      // Kept for anything still reading the old flat shape.
      onbed, overstay, reserved, loungePatients,
      censusOcc: sum(r => r.bed_type === "Census" && occStates.includes(r.state)),
      nonCensusOcc: sum(r => r.bed_type === "Non-Census" && occStates.includes(r.state)),
      vacantCensus: sum(r => r.bed_type === "Census" && (r.state === "vacant_none" || r.state === "vacant_res")),
      vacantNonCensus: sum(r => r.bed_type === "Non-Census" && (r.state === "vacant_none" || r.state === "vacant_res")),
      // admission_type only exists on admissions created from 2026-07-12 onward —
      // pre-existing occupied beds have admission_type=NULL and won't count here yet.
      censusDaycare: sum(r => r.bed_type === "Census" && r.admission_type === "DAYCARE" && occStates.includes(r.state)),
      nonCensusDaycare: sum(r => r.bed_type === "Non-Census" && r.admission_type === "DAYCARE" && occStates.includes(r.state)),

      // CEO's Occupancy Board layout — grouped exactly as drawn.
      census: {
        totalOcc: sum(r => r.bed_type === "Census" && occStates.includes(r.state)),
        onBed: sum(r => r.bed_type === "Census" && r.state === "onbed"),
        res: sum(r => r.bed_type === "Census" && r.state === "occ_res"),
        overstay: sum(r => r.bed_type === "Census" && r.state === "overstay"),
      },
      nonCensus: {
        totalOcc: sum(r => r.bed_type === "Non-Census" && occStates.includes(r.state)),
        onBed: sum(r => r.bed_type === "Non-Census" && r.state === "onbed"),
        res: sum(r => r.bed_type === "Non-Census" && r.state === "occ_res"),
        overstay: sum(r => r.bed_type === "Non-Census" && r.state === "overstay"),
      },
      // total intentionally matches loungePatients above — both are origin-scoped
      // now, so this always equals the sum of its own census/nonCensus split.
      // Omitted for non-admin roles, same reasoning as totalPatients above.
      lounge: includeLoungeSummary ? {
        total: loungeBy("Census") + loungeBy("Non-Census"),
        census: loungeBy("Census"),
        nonCensus: loungeBy("Non-Census"),
      } : undefined,
      vacant: {
        total: sum(r => r.state === "vacant_none" || r.state === "vacant_res") - sum(r => r.bed_type === "Lounge" && (r.state === "vacant_none" || r.state === "vacant_res")),
        census: sum(r => r.bed_type === "Census" && r.state === "vacant_none"),
        cRes: sum(r => r.bed_type === "Census" && r.state === "vacant_res"),
        nonCensus: sum(r => r.bed_type === "Non-Census" && r.state === "vacant_none"),
        ncRes: sum(r => r.bed_type === "Non-Census" && r.state === "vacant_res"),
      },
      // occStates covers onbed/overstay/occ_res; lounge is added separately,
      // origin-scoped, for the same reason totalPatients/lounge.* are above.
      patientType: {
        ipd: sum(r => r.admission_type === "IP" && occStates.includes(r.state)) + loungeAdmittedBy("IP"),
        dayCare: sum(r => r.admission_type === "DAYCARE" && occStates.includes(r.state)) + loungeAdmittedBy("DAYCARE"),
        opd: sum(r => r.admission_type === "OPD" && occStates.includes(r.state)) + loungeAdmittedBy("OPD"),
      },
      // Keyed by payer name (from Setup → Payer Types); origin-scoped for the
      // Discharge Lounge same as patientType above.
      payerType,
    },
    transaction: {
      newAdmissionsToday: Number(admissionsToday?.c || 0),
      completedToday: discharge.completedToday,
      plannedTotal: discharge.plannedToday,
      scheduledOngoingToday: discharge.scheduledOngoingToday,
      initiated: discharge.initiated,
      initiatedToday: discharge.initiatedToday,
      unplannedToday: discharge.unplannedToday,
      unplannedPending: discharge.unplannedPending,
      pendingInitiated: discharge.plannedToday,
      overduePlanned: discharge.overduePlanned,
      pending: discharge.pending,
      cancelledToday: discharge.cancelledToday,
      drugReturnPending: discharge.drugReturnPending,
      drugReturnCompleted: discharge.drugReturnCompleted,
      pharmacyPending: discharge.pharmacyPending,
      pharmacyCompleted: discharge.pharmacyCompleted,
      procedurePending: discharge.procedurePending,
      procedureCompleted: discharge.procedureCompleted,
      billingStartedCompleted: discharge.billingStartedCompleted,
      auditCompleted: discharge.auditCompleted,
      billReadyCompleted: discharge.billReadyCompleted,
      paymentCompleted: discharge.paymentCompleted,
      systemCheckoutCompleted: discharge.systemCheckoutCompleted,
      physicalCheckoutCompleted: discharge.physicalCheckoutCompleted,
      billingStarted: discharge.billingStarted,
      auditPending: discharge.auditPending,
      billReady: discharge.billReady,
      paymentPending: discharge.paymentPending,
      systemCheckoutPending: discharge.systemCheckoutPending,
      physicalCheckoutPending: discharge.physicalCheckoutPending,
      awaitingPatientLeave: discharge.awaitingPatientLeave,
      patientLeft: discharge.patientLeft,
      inDischargeLounge: discharge.inDischargeLounge,
    },
  };
}

/** Hourly capture for every adminDashboard() field that occupancy_snapshots doesn't
 *  already cover — called from the scheduler on the same hourly tick as
 *  snapshotOccupancy(). Builds real sparkline history for the flat-line cards.
 *  Writes one row for hospital-wide (unit_type=NULL) PLUS one row per operational
 *  logical unit group, so the Unit toolbar filter can show a real per-unit
 *  trend instead of always falling back to the hospital-wide line. */
export async function snapshotAdminDashboard() {
  const unitRows = await db.prepare(
    // The Discharge Lounge is excluded regardless of whatever unit_type it's
    // been given — it's a shared virtual holding ward, not a real unit; its
    // patients are already attributed to their origin ward's unit elsewhere.
    "SELECT DISTINCT unit_type FROM wards WHERE operational=true AND unit_type IS NOT NULL AND unit_type <> '' AND is_discharge_lounge = false"
  ).all<{ unit_type: string }>();
  const targets: (string | null)[] = [null, ...Array.from(
    new Set(unitRows.map(r => normalizeDashboardUnitType(r.unit_type)).filter(Boolean))
  )];
  const ts = Date.now();

  for (const unit of targets) {
    const { occupancy, transaction } = await adminDashboard(unit ?? undefined);
    await db.prepare(
      `INSERT INTO admin_dashboard_snapshots (
         ts, unit_type, lounge_patients, census_daycare, non_census_daycare,
         new_admissions_today, completed_today, planned_total, initiated, pending, cancelled,
         drug_return_pending, pharmacy_pending, procedure_pending, billing_started,
         audit_pending, bill_ready, payment_pending, system_checkout_pending, physical_checkout_pending
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      ts, unit, occupancy.loungePatients, occupancy.censusDaycare, occupancy.nonCensusDaycare,
      transaction.newAdmissionsToday, transaction.completedToday, transaction.plannedTotal, transaction.initiated,
      transaction.pending, transaction.cancelledToday,
      transaction.drugReturnPending, transaction.pharmacyPending, transaction.procedurePending, transaction.billingStarted,
      transaction.auditPending, transaction.billReady, transaction.paymentPending,
      transaction.systemCheckoutPending, transaction.physicalCheckoutPending,
    );
  }
}

/** Active patients per consultant, broken down by payer type and department.
 *  Discharge Lounge is excluded: an admission stays ACTIVE after the lounge move
 *  (only System Checkout is left pending — see autoCompleteDischargeForLoungeTransfer),
 *  but the patient has physically left, so counting them against their consultant
 *  overstates the caseload and disagrees with every other hospital-wide figure on
 *  the dashboard, all of which already skip the lounge. */
export async function consultantsLive() {
  const rows = await db.prepare(`
    SELECT
      COALESCE(dm.name, pa.consultant_name, 'Unknown') AS name,
      bd.payer_type,
      pa.department_name,
      COUNT(*)::int AS n
    FROM patient_admissions pa
    JOIN bed_details bd ON bd.id = pa.bed_id
    JOIN wards w ON w.id = bd.ward_id
    LEFT JOIN doctors_master dm ON dm.id = pa.doctor_id
    WHERE pa.status = 'ACTIVE'
      AND NOT w.is_discharge_lounge
      AND (pa.doctor_id IS NOT NULL OR pa.consultant_name IS NOT NULL)
    GROUP BY COALESCE(dm.name, pa.consultant_name, 'Unknown'), bd.payer_type, pa.department_name
    ORDER BY name, payer_type
  `).all<{ name: string; payer_type: string; department_name: string | null; n: number }>();

  const payerTypeSet = new Set<string>();
  for (const r of rows) if (r.payer_type) payerTypeSet.add(r.payer_type);
  const payerTypes = [...payerTypeSet].sort();

  const byName = new Map<string, { name: string; total: number; payers: Record<string, number>; departments: Record<string, number> }>();
  for (const r of rows) {
    if (!byName.has(r.name)) byName.set(r.name, { name: r.name, total: 0, payers: {}, departments: {} });
    const entry = byName.get(r.name)!;
    entry.payers[r.payer_type] = (entry.payers[r.payer_type] ?? 0) + r.n;
    if (r.department_name) entry.departments[r.department_name] = (entry.departments[r.department_name] ?? 0) + r.n;
    entry.total += r.n;
  }

  const consultants = [...byName.values()]
    .filter(c => c.total > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  return { payerTypes, consultants };
}

/** Last N hourly rows for one unit (or hospital-wide when unitType is null/"TOTAL"),
 *  oldest first (matches the shape callers expect for sparklines). */
export async function adminDashboardHistory(limit = 48, unitType?: string | null) {
  const snapshotKeys = dashboardSnapshotUnitKeys(unitType);
  if (!snapshotKeys) {
    const rows = await db.prepare(
      `SELECT * FROM admin_dashboard_snapshots
       WHERE unit_type IS NOT DISTINCT FROM ?
       ORDER BY ts DESC LIMIT ?`
    ).all<Record<string, number>>(null, limit);
    return rows.reverse();
  }

  const fetchLimit = Math.max(limit * snapshotKeys.length * 4, limit);
  const rows = await db.prepare(
    `SELECT * FROM admin_dashboard_snapshots
     WHERE unit_type = ANY(?)
     ORDER BY ts DESC LIMIT ?`
  ).all<Array<Record<string, number | string | null>>[number]>(snapshotKeys, fetchLimit);

  const byTs = new Map<number, Record<string, number | string | null>>();
  for (const row of rows) {
    const ts = Number(row.ts || 0);
    if (!ts) continue;
    if (!byTs.has(ts)) byTs.set(ts, { ...row, unit_type: normalizeDashboardUnitType(unitType) });
    else {
      const acc = byTs.get(ts)!;
      for (const [key, value] of Object.entries(row)) {
        if (key === "ts" || key === "unit_type") continue;
        if (typeof value === "number") acc[key] = Number(acc[key] || 0) + value;
      }
    }
  }

  return Array.from(byTs.values())
    .sort((a, b) => Number(a.ts) - Number(b.ts))
    .slice(-limit) as Record<string, number>[];
}
