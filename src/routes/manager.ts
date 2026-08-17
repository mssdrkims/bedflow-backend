import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { db } from "../db/index.js";
import { emitUpdate } from "../websocket/io.js";
import {
  listBuildingBlocks, createBuildingBlock, editBuildingBlock, deleteBuildingBlock,
  listFloors, createFloor, editFloor, deleteFloor,
  createWard, editWard, deleteWard,
  createPre, editPre, deletePre,
  createNurse, editNurse, deleteNurse, addNurseStation, removeNurseStation,
  createDoctor, editDoctor, deleteDoctor,
  listNursingStations, createNursingStation, editNursingStation, deleteNursingStation, assignWardsToStation,
  availableDates, censusDates, historyForDate,
  listNurseAccess, createNurseAccess, editNurseAccess, deleteNurseAccess,
} from "../services/managerService.js";
import {
  listPreBlocks, getPreBlock, createPreBlock, editPreBlock,
  setPreBlockStatus, deletePreBlock,
} from "../services/preBlockService.js";
import {
  listDoctorBlocks, getDoctorBlock, createDoctorBlock, editDoctorBlock,
  setDoctorBlockStatus, deleteDoctorBlock, wardIdsForDoctorBlock,
} from "../services/doctorBlockService.js";
import {
  generateBeds, addSingleBed, listBeds, renameBed, deleteBed, updateBedMaster, bulkSetBedOperational,
} from "../services/bedDetailService.js";
import { midnightCensusFor } from "../services/bedService.js";
import { listPhaseConfig, updatePhaseConfig, reorderPhaseConfig, listPayerTatConfig, invalidatePayerTatCache } from "../services/dischargeSlaService.js";
import {
  listPayerTypes, createPayerType, updatePayerType, reorderPayerType, deletePayerType,
} from "../services/payerTypeService.js";
import {
  listDestinations, createDestination, updateDestination, reorderDestination, deleteDestination,
} from "../services/destinationService.js";
import {
  listDepartments, createDepartment, updateDepartment, deleteDepartment,
  listDoctorsWithDepartments,
} from "../services/doctorDeptService.js";
import {
  listGroupsWithDetails, createGroup as createConsultantGroup,
  updateGroup as updateConsultantGroup, deleteGroup as deleteConsultantGroup,
} from "../services/consultantGroupService.js";
import {
  listConsultantUsers, createConsultantUser, updateConsultantUser, deleteConsultantUser,
} from "../services/consultantUserService.js";
import {
  getDischargeLounge, setupDischargeLounge, renameDischargeLounge, getDischargeLoungeWard,
} from "../services/dischargeLoungeService.js";

const router = Router();

/** Tells connected clients that a hospital-wide reference list just changed, so
 *  anything caching it can drop that cache.
 *
 *  Payer types and destinations already announced themselves this way (their
 *  emits carry `payerTypeId` / `destinationId`). Doctors, departments and
 *  consultant groups announced NOTHING, which was fine while every screen
 *  re-fetched them on mount — but once the client began caching them for the
 *  session, an admin adding a consultant stayed invisible to everyone already
 *  logged in until they logged out and back in.
 *
 *  Rides on `bed:update` because that is the event every screen is already
 *  subscribed to; `refData` names which list moved. No wardId on purpose — this
 *  is hospital-wide, and a payload without one makes clients drop every cached
 *  ward rather than guess which were affected. These edits are rare, so the
 *  extra refetch costs nothing. */
function emitRefDataChanged(list: "doctors" | "departments" | "consultant-groups") {
  emitUpdate("bed:update", { refData: list });
}
router.use(authRequired, requireRole("COO"));

// Nurses only join the `station:<id>` socket room, not `overview` — these
// helpers let mutation routes target the right nurse station(s) so an Admin's
// edit is visible on the nurse's dashboard too, not just the Admin's.
async function stationIdForWard(wardId: number): Promise<number | undefined> {
  const row = await db.prepare("SELECT station_id FROM wards WHERE id=?")
    .get<{ station_id: number | null }>(wardId);
  return row?.station_id ?? undefined;
}
async function stationIdForBed(bedId: number): Promise<number | undefined> {
  const row = await db.prepare(
    "SELECT w.station_id FROM bed_details bd JOIN wards w ON w.id=bd.ward_id WHERE bd.id=?"
  ).get<{ station_id: number | null }>(bedId);
  return row?.station_id ?? undefined;
}
async function stationIdsForNurse(nurseId: number): Promise<number[] | undefined> {
  const rows = await db.prepare("SELECT station_id FROM nurse_stations WHERE nurse_id=?")
    .all<{ station_id: number }>(nurseId);
  return rows.length ? rows.map(r => r.station_id) : undefined;
}

// ── KPIs ──────────────────────────────────────────────────────────────────────

router.get("/kpis", asyncH(async (_req, res) => {
  // total/census/non_census are raw inventory (no operational_status filter —
  // matches Hospital Snapshot's totalBeds/censusBeds/nonCensusBeds). The
  // vacant/vacant_reserved/occupied state counts all require bd.operational_status
  // consistently — a bed pulled out of service isn't available capacity, so it
  // shouldn't register as vacant OR occupied (same rule as the Occupancy Board).
  // Ward-level operational is filtered too — a bed inside a shut-down ward is
  // never counted anywhere else in the app, so it shouldn't inflate this one either.
  const row = await db.prepare(`
    SELECT
      COUNT(*)::int                                                            AS total,
      COUNT(*) FILTER (WHERE w.bed_type = 'Census' OR w.bed_type IS NULL)::int  AS census,
      COUNT(*) FILTER (WHERE w.bed_type = 'Non-Census')::int                  AS non_census,
      COUNT(*) FILTER (WHERE bd.operational_status)::int                      AS operational,
      COUNT(*) FILTER (WHERE NOT bd.operational_status)::int                  AS non_operational,
      COUNT(*) FILTER (WHERE bd.physical_status = 'VACANT'
                         AND bd.reservation_status = 'NONE'
                         AND bd.operational_status)::int                      AS vacant,
      COUNT(*) FILTER (WHERE bd.physical_status = 'VACANT'
                         AND bd.reservation_status = 'RESERVED'
                         AND bd.operational_status)::int                      AS vacant_reserved,
      COUNT(*) FILTER (WHERE bd.physical_status = 'OCCUPIED'
                         AND bd.operational_status)::int                      AS occupied
    FROM bed_details bd
    JOIN wards w ON w.id = bd.ward_id
    WHERE w.operational = true AND NOT w.is_discharge_lounge
  `).get<Record<string, number>>();
  const occupiedTotal = row?.occupied ?? 0;
  const operational   = row?.operational ?? 0;
  res.json({
    ...row,
    occupancy_pct: operational > 0 ? Math.round((occupiedTotal / operational) * 100) : 0,
    census_occupancy_pct: (row?.census ?? 0) > 0
      ? Math.round((occupiedTotal / row!.census) * 100) : 0,
  });
}));

// ── building blocks ───────────────────────────────────────────────────────────

router.get("/building-blocks", asyncH(async (_req, res) => {
  res.json({ blocks: await listBuildingBlocks() });
}));

router.post("/building-blocks", asyncH(async (req, res) => {
  const { name, label } = z.object({
    name:  z.string().min(1).max(10),
    label: z.string().optional(),
  }).parse(req.body);
  const result = await createBuildingBlock({ name, label, managerId: req.user!.id });
  emitUpdate("bed:update", { blockId: result.id });
  res.status(201).json(result);
}));

router.put("/building-blocks/:id", asyncH(async (req, res) => {
  const { name, label, sortOrder } = z.object({
    name:      z.string().optional(),
    label:     z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
  }).parse(req.body);
  const blockId = Number(req.params.id);
  const result = await editBuildingBlock({
    blockId, name, label: label ?? undefined, sortOrder, managerId: req.user!.id,
  });
  emitUpdate("bed:update", { blockId });
  res.json(result);
}));

router.delete("/building-blocks/:id", asyncH(async (req, res) => {
  const blockId = Number(req.params.id);
  const result = await deleteBuildingBlock(blockId, req.user!.id);
  emitUpdate("bed:update", { blockId });
  res.json(result);
}));

// ── floors ────────────────────────────────────────────────────────────────────

router.get("/floors", asyncH(async (_req, res) => {
  res.json({ floors: await listFloors() });
}));

router.post("/floors", asyncH(async (req, res) => {
  const { name, buildingBlockId } = z.object({
    name:            z.string().min(1).max(60),
    buildingBlockId: z.number().int(),
  }).parse(req.body);
  const result = await createFloor({ name, buildingBlockId, managerId: req.user!.id });
  emitUpdate("bed:update", { floorId: result.id });
  res.status(201).json(result);
}));

router.put("/floors/:id", asyncH(async (req, res) => {
  const { name } = z.object({ name: z.string().min(1).max(60) }).parse(req.body);
  const floorId = Number(req.params.id);
  const result = await editFloor({ floorId, name, managerId: req.user!.id });
  emitUpdate("bed:update", { floorId });
  res.json(result);
}));

router.delete("/floors/:id", asyncH(async (req, res) => {
  const floorId = Number(req.params.id);
  const result = await deleteFloor(floorId, req.user!.id);
  emitUpdate("bed:update", { floorId });
  res.json(result);
}));

// ── wards ─────────────────────────────────────────────────────────────────────

router.get("/unit-types", asyncH(async (_req, res) => {
  const rows = await db.prepare(
    "SELECT DISTINCT unit_type FROM wards WHERE unit_type IS NOT NULL AND unit_type <> '' ORDER BY unit_type"
  ).all<{ unit_type: string }>();
  res.json({ unitTypes: rows.map((r) => r.unit_type) });
}));

router.get("/wards", asyncH(async (_req, res) => {
  const wards = await db.prepare(
    `SELECT w.id, w.name, w.floor_id, w.total_beds,
            w.nursing_station, w.station_id, w.unit_type, w.room_type,
            w.bed_type, w.operational,
            ns.name  AS station_name,
            f.name AS floor_name,
            bb.id    AS block_id,    bb.name AS block_name,
            dbw.doctor_block_id AS doctor_block_id, db.name AS doctor_block_name,
            (SELECT COUNT(*)::int FROM bed_details bd WHERE bd.ward_id = w.id) AS bed_count
     FROM wards w
     LEFT JOIN floors f ON f.id = w.floor_id
     LEFT JOIN building_blocks bb ON bb.id = f.building_block_id
     LEFT JOIN nursing_stations ns ON ns.id = w.station_id
     LEFT JOIN doctor_block_wards dbw ON dbw.ward_id = w.id
     LEFT JOIN doctor_blocks db ON db.id = dbw.doctor_block_id
     ORDER BY bb.sort_order, bb.name, f.sort_order, f.name, w.name`
  ).all();
  res.json({ wards });
}));

router.post("/wards", asyncH(async (req, res) => {
  const b = z.object({
    name:        z.string().min(1),
    floorId:     z.number().int(),
    totalBeds:   z.number().int().min(0).max(500, "A ward can have at most 500 beds. Create it, then add more beds individually."),
    stationId:   z.number().int().nullable().optional(),
    unitType:    z.string().optional(),
    roomType:    z.string().optional(),
    bedType:     z.enum(["Census", "Non-Census"]).optional(),
    operational: z.boolean().optional(),
  }).parse(req.body);
  const result = await createWard({ ...b, managerId: req.user!.id });
  emitUpdate("bed:update", { wardId: result.id }, b.stationId ? { stationId: b.stationId } : undefined);
  res.status(201).json(result);
}));

router.put("/wards/:id", asyncH(async (req, res) => {
  const b = z.object({
    name:        z.string().optional(),
    totalBeds:   z.number().int().min(0).optional(),
    floorId:     z.number().int().optional(),
    stationId:   z.number().int().nullable().optional(),
    unitType:    z.string().nullable().optional(),
    roomType:    z.string().nullable().optional(),
    bedType:     z.enum(["Census", "Non-Census"]).nullable().optional(),
    operational: z.boolean().nullable().optional(),
  }).parse(req.body);
  const wardId = Number(req.params.id);
  const prevStationId = await stationIdForWard(wardId);
  const result = await editWard({ wardId, ...b, managerId: req.user!.id });
  const newStationId = b.stationId !== undefined ? (b.stationId ?? undefined) : prevStationId;
  const stationIds = [...new Set([prevStationId, newStationId].filter((v): v is number => v != null))];
  emitUpdate("bed:update", { wardId }, stationIds.length ? { stationId: stationIds } : undefined);
  if (b.operational != null) {
    const blocks = await db.prepare(
      "SELECT pre_block_id FROM pre_block_wards WHERE ward_id=?"
    ).all<{ pre_block_id: number }>(wardId);
    emitUpdate("ward:operational", { wardId, operational: b.operational }, {
      pre: blocks.map(r => String(r.pre_block_id)),
    });
  }
  res.json(result);
}));

router.delete("/wards/:id", asyncH(async (req, res) => {
  const wardId = Number(req.params.id);
  const stationId = await stationIdForWard(wardId);
  const result = await deleteWard(wardId, req.user!.id);
  emitUpdate("bed:update", { wardId }, stationId ? { stationId } : undefined);
  res.json(result);
}));

// ── users list ────────────────────────────────────────────────────────────────

router.get("/users", asyncH(async (_req, res) => {
  const users = await db.prepare(
    `SELECT u.id, u.username, u.role, u.name, u.status, u.remarks,
            u.station_id, u.nursing_station,
            ns.name AS station_name,
            COALESCE(upb.pre_block_ids,   ARRAY[]::int[])  AS pre_block_ids,
            COALESCE(upb.pre_block_names, ARRAY[]::text[]) AS pre_block_names,
            COALESCE(st.station_ids,   ARRAY[]::int[])  AS station_ids,
            COALESCE(st.station_names, ARRAY[]::text[]) AS station_names,
            COALESCE(dbk.block_ids,   ARRAY[]::int[])  AS block_ids,
            COALESCE(dbk.block_names, ARRAY[]::text[]) AS block_names
     FROM users u
     LEFT JOIN nursing_stations ns ON ns.id = u.station_id
     LEFT JOIN LATERAL (
       SELECT array_agg(upb2.pre_block_id ORDER BY pb.name) AS pre_block_ids,
              array_agg(pb.name           ORDER BY pb.name) AS pre_block_names
       FROM user_pre_blocks upb2
       JOIN pre_blocks pb ON pb.id = upb2.pre_block_id
       WHERE upb2.user_id = u.id
     ) upb ON true
     LEFT JOIN LATERAL (
       SELECT array_agg(nst.station_id ORDER BY ns2.name) AS station_ids,
              array_agg(ns2.name      ORDER BY ns2.name) AS station_names
       FROM nurse_stations nst
       JOIN nursing_stations ns2 ON ns2.id = nst.station_id
       WHERE nst.nurse_id = u.id
     ) st ON true
     LEFT JOIN LATERAL (
       SELECT array_agg(dbu.doctor_block_id ORDER BY db2.name) AS block_ids,
              array_agg(db2.name           ORDER BY db2.name) AS block_names
       FROM doctor_block_users dbu
       JOIN doctor_blocks db2 ON db2.id = dbu.doctor_block_id
       WHERE dbu.user_id = u.id
     ) dbk ON true
     ORDER BY u.role, u.username`
  ).all();
  res.json({ users });
}));

// ── PRE users ─────────────────────────────────────────────────────────────────

router.post("/pre", asyncH(async (req, res) => {
  const b = z.object({
    username:     z.string().min(1, "Username is required.").max(40, "Username must be 40 characters or less."),
    password:     z.string().min(8, "Password must be at least 8 characters.").max(72, "Password is too long."),
    name:         z.string().min(1, "Display name is required.").max(80, "Display name is too long."),
    preBlockIds:  z.array(z.number().int()).optional(),
  }).parse(req.body);
  res.status(201).json(await createPre({ ...b, managerId: req.user!.id }));
}));

router.put("/pre/:id", asyncH(async (req, res) => {
  const b = z.object({
    name:         z.string().min(1, "Display name is required.").max(80, "Display name is too long.").optional(),
    password:     z.string().min(8, "Password must be at least 8 characters.").max(72, "Password is too long.").optional(),
    preBlockIds:  z.array(z.number().int()).optional(),
  }).parse(req.body);
  res.json(await editPre({ userId: Number(req.params.id), ...b, managerId: req.user!.id }));
}));

router.delete("/pre/:id", asyncH(async (req, res) => {
  res.json(await deletePre(Number(req.params.id), req.user!.id));
}));

// ── Nurse In-Charge users ─────────────────────────────────────────────────────

const nurseProfileFields = {
  stationIds: z.array(z.number().int().positive()).optional(),
  employeeId: z.string().max(50).optional(),
  phone:      z.string().max(30).optional(),
  email:      z.string().max(120).optional(),
};

router.post("/nurses", asyncH(async (req, res) => {
  const b = z.object({
    username: z.string().min(1, "Username is required.").max(40, "Username must be 40 characters or less."),
    password: z.string().min(8, "Password must be at least 8 characters.").max(72, "Password is too long."),
    name:     z.string().min(1, "Display name is required.").max(80, "Display name is too long."),
    ...nurseProfileFields,
  }).parse(req.body);
  res.status(201).json(await createNurse({ ...b, managerId: req.user!.id }));
}));

router.put("/nurses/:id", asyncH(async (req, res) => {
  const b = z.object({
    name:     z.string().min(1, "Display name is required.").max(80, "Display name is too long.").optional(),
    password: z.string().min(8, "Password must be at least 8 characters.").max(72, "Password is too long.").optional(),
    ...nurseProfileFields,
  }).parse(req.body);
  res.json(await editNurse({ userId: Number(req.params.id), ...b, managerId: req.user!.id }));
}));

router.delete("/nurses/:id", asyncH(async (req, res) => {
  res.json(await deleteNurse(Number(req.params.id), req.user!.id));
}));

router.post("/nurses/:id/stations", asyncH(async (req, res) => {
  const { stationId } = z.object({ stationId: z.number().int().positive() }).parse(req.body);
  const result = await addNurseStation(Number(req.params.id), stationId, req.user!.id);
  emitUpdate("bed:update", { nurseId: Number(req.params.id) }, { stationId });
  res.status(201).json(result);
}));

router.delete("/nurses/:id/stations/:stationId", asyncH(async (req, res) => {
  const result = await removeNurseStation(Number(req.params.id), Number(req.params.stationId), req.user!.id);
  emitUpdate("bed:update", { nurseId: Number(req.params.id) }, { stationId: Number(req.params.stationId) });
  res.json(result);
}));

// ── Doctor users ──────────────────────────────────────────────────────────────
// Same rule as every other role: just a minimum length, no forced letter/number/symbol mix.
const doctorPassword = z.string()
  .min(8, "Password must be at least 8 characters.")
  .max(72, "Password is too long.");

router.post("/doctors", asyncH(async (req, res) => {
  const b = z.object({
    username: z.string().min(1, "Username is required.").max(40, "Username must be 40 characters or less."),
    password: doctorPassword,
    name:     z.string().min(1, "Display name is required.").max(80, "Display name is too long."),
    status:   z.enum(["active", "inactive"]).optional(),
    remarks:  z.string().max(500).optional(),
  }).parse(req.body);
  const created = await createDoctor({ ...b, adminId: req.user!.id });
  emitRefDataChanged("doctors");
  res.status(201).json(created);
}));

router.put("/doctors/:id", asyncH(async (req, res) => {
  const b = z.object({
    name:     z.string().min(1, "Display name is required.").max(80, "Display name is too long.").optional(),
    password: doctorPassword.optional(),
    status:   z.enum(["active", "inactive"]).optional(),
    remarks:  z.string().max(500).nullable().optional(),
  }).parse(req.body);
  const edited = await editDoctor({ userId: Number(req.params.id), ...b, adminId: req.user!.id });
  emitRefDataChanged("doctors");
  res.json(edited);
}));

router.delete("/doctors/:id", asyncH(async (req, res) => {
  const removed = await deleteDoctor(Number(req.params.id), req.user!.id);
  emitRefDataChanged("doctors");
  res.json(removed);
}));

// ── bed details ───────────────────────────────────────────────────────────────

router.get("/wards/:id/beds", asyncH(async (req, res) => {
  const wardId = Number(req.params.id);
  const physicalStatus    = req.query.physical_status    as string | undefined;
  const reservationStatus = req.query.reservation_status as string | undefined;
  res.json({ beds: await listBeds(wardId, physicalStatus, reservationStatus) });
}));

router.post("/wards/:id/generate-beds", asyncH(async (req, res) => {
  // bedType is never accepted here — beds always inherit the ward's current
  // type (Census/Non-Census is ward-level only, see bedDetailService.ts).
  const { bedNames, operationalStatus, acStatus } = z.object({
    bedNames:          z.array(z.string().min(1)).min(1).max(500),
    operationalStatus: z.boolean().optional(),
    acStatus:          z.boolean().optional(),
  }).parse(req.body);
  const wardId = Number(req.params.id);
  const result = await generateBeds({ wardId, bedNames, operationalStatus, acStatus, userId: req.user!.id });
  const stationId = await stationIdForWard(wardId);
  emitUpdate("bed:update", { wardId }, stationId ? { stationId } : undefined);
  res.status(201).json(result);
}));

router.post("/wards/:id/beds", asyncH(async (req, res) => {
  const { bedName, operationalStatus, acStatus } = z.object({
    bedName:           z.string().min(1),
    operationalStatus: z.boolean().optional(),
    acStatus:          z.boolean().optional(),
  }).parse(req.body);
  const wardId = Number(req.params.id);
  const result = await addSingleBed({ wardId, bedName, operationalStatus, acStatus, userId: req.user!.id });
  const stationId = await stationIdForWard(wardId);
  emitUpdate("bed:update", { wardId }, stationId ? { stationId } : undefined);
  res.status(201).json(result);
}));

router.patch("/beds/:id/name", asyncH(async (req, res) => {
  const { bedName } = z.object({ bedName: z.string().min(1) }).parse(req.body);
  res.json(await renameBed({ bedId: Number(req.params.id), newBedName: bedName, userId: req.user!.id }));
}));

router.patch("/beds/:id/master", asyncH(async (req, res) => {
  // bedType removed — see generate-beds comment above.
  const { operationalStatus, acStatus } = z.object({
    operationalStatus: z.boolean().optional(),
    acStatus:          z.boolean().optional(),
  }).parse(req.body);
  const bedId = Number(req.params.id);
  const stationId = await stationIdForBed(bedId);
  const result = await updateBedMaster({
    bedId, operationalStatus, acStatus, userId: req.user!.id,
  });
  emitUpdate("bed:update", { bedId }, stationId ? { stationId } : undefined);
  res.json(result);
}));

router.delete("/beds/:id", asyncH(async (req, res) => {
  const bedId = Number(req.params.id);
  const stationId = await stationIdForBed(bedId);
  const result = await deleteBed({ bedId, userId: req.user!.id });
  emitUpdate("bed:update", { bedId }, stationId ? { stationId } : undefined);
  res.json(result);
}));

// ── nursing stations ──────────────────────────────────────────────────────────

router.get("/nursing-stations", asyncH(async (_req, res) => {
  res.json({ stations: await listNursingStations() });
}));

router.post("/nursing-stations", asyncH(async (req, res) => {
  const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
  const result = await createNursingStation({ name, managerId: req.user!.id });
  emitUpdate("bed:update", { stationId: result.id });
  res.status(201).json(result);
}));

router.put("/nursing-stations/:id", asyncH(async (req, res) => {
  const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
  const stationId = Number(req.params.id);
  const result = await editNursingStation({ stationId, name, managerId: req.user!.id });
  emitUpdate("bed:update", { stationId }, { stationId });
  res.json(result);
}));

router.put("/nursing-stations/:id/wards", asyncH(async (req, res) => {
  const { wardIds } = z.object({ wardIds: z.array(z.number().int()).min(0) }).parse(req.body);
  const stationId = Number(req.params.id);
  const result = await assignWardsToStation(stationId, wardIds, req.user!.id);
  emitUpdate("bed:update", { stationId }, { stationId });
  res.json(result);
}));

router.delete("/nursing-stations/:id", asyncH(async (req, res) => {
  const stationId = Number(req.params.id);
  const result = await deleteNursingStation(stationId, req.user!.id);
  emitUpdate("bed:update", { stationId }, { stationId });
  res.json(result);
}));

router.get("/stations/:id/coverage", asyncH(async (req, res) => {
  const stationId = Number(req.params.id);

  // Wards assigned to this station
  const wards = await db.prepare(
    "SELECT w.id, w.name FROM wards w WHERE w.station_id=? ORDER BY w.name"
  ).all<{ id: number; name: string }>(stationId);

  // Nurses in this station (via the multi-station membership table)
  const nurses = await db.prepare(
    `SELECT u.id, u.name, u.username, u.employee_id, u.phone, u.email
     FROM nurse_stations nst
     JOIN users u ON u.id = nst.nurse_id
     WHERE nst.station_id=? AND u.role='NURSE' ORDER BY u.name`
  ).all<{ id: number; name: string; username: string; employee_id: string | null; phone: string | null; email: string | null }>(stationId);

  const nurseIds  = nurses.map(n => n.id);
  const wardIds   = wards.map(w => w.id);

  // Active assignments for station's nurses on station's wards
  const assignments = nurseIds.length > 0 && wardIds.length > 0
    ? await db.prepare(
        `SELECT nurse_id, ward_id, access_type, bed_names
         FROM nurse_access_assignments
         WHERE nurse_id = ANY(?) AND ward_id = ANY(?) AND status='active'`
      ).all<{ nurse_id: number; ward_id: number; access_type: string; bed_names: string }>(nurseIds, wardIds)
    : [];

  // Per-ward coverage
  const wardCoverage = await Promise.all(wards.map(async (w) => {
    const allBeds = (await db.prepare(
      "SELECT bed_name FROM bed_details WHERE ward_id=?"
    ).all<{ bed_name: string }>(w.id)).map(b => b.bed_name);

    const wardAssignments = assignments.filter(a => a.ward_id === w.id);
    const coveredSet = new Set<string>();
    let hasFullAccess = false;

    for (const a of wardAssignments) {
      if (a.access_type === "FULL") {
        hasFullAccess = true;
        for (const b of allBeds) coveredSet.add(b);
        break;
      } else {
        let beds: string[] = [];
        try { beds = JSON.parse(a.bed_names || "[]"); } catch { /* skip */ }
        for (const b of beds) coveredSet.add(b);
      }
    }

    const unassigned = allBeds.filter(b => !coveredSet.has(b));
    const total = allBeds.length;
    const assigned = total - unassigned.length;
    return {
      ward_id: w.id, ward_name: w.name,
      total_beds: total, assigned_beds: assigned,
      unassigned_beds: unassigned,
      has_full_access: hasFullAccess,
      coverage_pct: total > 0 ? Math.round((assigned / total) * 100) : 0,
    };
  }));

  // Nurse workload
  const nurseWorkload = nurses.map(n => {
    const myAssignments = assignments.filter(a => a.nurse_id === n.id);
    let bedCount = 0;
    for (const a of myAssignments) {
      if (a.access_type === "FULL") {
        const w = wardCoverage.find(wc => wc.ward_id === a.ward_id);
        bedCount += w?.total_beds ?? 0;
      } else {
        try { bedCount += JSON.parse(a.bed_names || "[]").length; } catch { /* skip */ }
      }
    }
    return {
      ...n,
      ward_count: myAssignments.length,
      bed_count: bedCount,
    };
  });

  res.json({ wards: wardCoverage, nurses: nurseWorkload });
}));

// ── Nurse Access Assignments ──────────────────────────────────────────────────

function parseQueryId(val: unknown, name: string): number | undefined {
  if (val === undefined) return undefined;
  if (Array.isArray(val)) throw new HttpError(400, `${name} must be a single value`);
  const n = Number(val);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} must be a positive integer`);
  return n;
}

router.get("/nurse-access", asyncH(async (req, res) => {
  const nurseId = parseQueryId(req.query.nurseId, "nurseId");
  const wardId  = parseQueryId(req.query.wardId, "wardId");
  const status  = req.query.status ? String(req.query.status) : undefined;
  res.json({ assignments: await listNurseAccess({ nurseId, wardId, status }) });
}));

router.post("/nurse-access", asyncH(async (req, res) => {
  const body = z.object({
    nurseId:    z.number().int().positive(),
    wardId:     z.number().int().positive(),
    accessType: z.enum(["FULL", "BEDS"]),
    bedNames:   z.array(z.string()).optional().default([]),
  }).parse(req.body);
  const result = await createNurseAccess({ ...body, managerId: req.user!.id });
  const stationId = await stationIdsForNurse(body.nurseId);
  emitUpdate("bed:update", { nurseId: body.nurseId, wardId: body.wardId }, stationId ? { stationId } : undefined);
  res.status(201).json(result);
}));

router.put("/nurse-access/:id", asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const body = z.object({
    accessType: z.enum(["FULL", "BEDS"]).optional(),
    bedNames:   z.array(z.string()).optional(),
    status:     z.enum(["active", "inactive"]).optional(),
  }).parse(req.body);
  const row = await db.prepare("SELECT nurse_id, ward_id FROM nurse_access_assignments WHERE id=?")
    .get<{ nurse_id: number; ward_id: number }>(id);
  const result = await editNurseAccess({ id, ...body, managerId: req.user!.id });
  const stationId = row ? await stationIdsForNurse(row.nurse_id) : undefined;
  emitUpdate("bed:update", { nurseId: row?.nurse_id, wardId: row?.ward_id }, stationId ? { stationId } : undefined);
  res.json(result);
}));

router.delete("/nurse-access/:id", asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const row = await db.prepare("SELECT nurse_id, ward_id FROM nurse_access_assignments WHERE id=?")
    .get<{ nurse_id: number; ward_id: number }>(id);
  const result = await deleteNurseAccess(id, req.user!.id);
  const stationId = row ? await stationIdsForNurse(row.nurse_id) : undefined;
  emitUpdate("bed:update", { nurseId: row?.nurse_id, wardId: row?.ward_id }, stationId ? { stationId } : undefined);
  res.json(result);
}));

// ── history ───────────────────────────────────────────────────────────────────

router.get("/history/dates", asyncH(async (_req, res) => {
  res.json({ dates: await availableDates() });
}));

router.get("/history/census-dates", asyncH(async (_req, res) => {
  res.json({ dates: await censusDates() });
}));

router.get("/history", asyncH(async (req, res) => {
  const date = String(req.query.date || "");
  // preBlockId is the current filter; floorId kept as a legacy alias
  const preBlockId = req.query.preBlockId ? Number(req.query.preBlockId)
                   : req.query.floorId    ? Number(req.query.floorId)
                   : undefined;
  if (!date) return res.json({ rounds: [], census: null });
  res.json({
    rounds: await historyForDate(date, preBlockId),
    census: await midnightCensusFor(date),
  });
}));

// ── PRE Blocks ────────────────────────────────────────────────────────────────

router.get("/pre-blocks", asyncH(async (_req, res) => {
  res.json({ blocks: await listPreBlocks() });
}));

router.get("/pre-blocks/:id", asyncH(async (req, res) => {
  res.json(await getPreBlock(Number(req.params.id)));
}));

router.post("/pre-blocks", asyncH(async (req, res) => {
  const { name, description, wardIds } = z.object({
    name:        z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    wardIds:     z.array(z.number().int()).min(1),
  }).parse(req.body);
  const result = await createPreBlock({ name, description, wardIds, managerId: req.user!.id });
  emitUpdate("bed:update", { preBlockId: result.id }, { pre: String(result.id) });
  res.status(201).json(result);
}));

router.put("/pre-blocks/:id", asyncH(async (req, res) => {
  const { name, description, wardIds } = z.object({
    name:        z.string().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    wardIds:     z.array(z.number().int()).min(1).optional(),
  }).parse(req.body);
  const blockId = Number(req.params.id);
  const result = await editPreBlock({
    blockId, name,
    description: description ?? undefined, wardIds, managerId: req.user!.id,
  });
  emitUpdate("bed:update", { preBlockId: blockId }, { pre: String(blockId) });
  res.json(result);
}));

router.patch("/pre-blocks/:id/status", asyncH(async (req, res) => {
  const { status } = z.object({ status: z.enum(["active", "inactive"]) }).parse(req.body);
  const blockId = Number(req.params.id);
  const result = await setPreBlockStatus(blockId, status, req.user!.id);
  emitUpdate("bed:update", { preBlockId: blockId, status }, { pre: String(blockId) });
  res.json(result);
}));

router.delete("/pre-blocks/:id", asyncH(async (req, res) => {
  const blockId = Number(req.params.id);
  const result = await deletePreBlock(blockId, req.user!.id);
  emitUpdate("bed:update", { preBlockId: blockId }, { pre: String(blockId) });
  res.json(result);
}));

// ── Doctor Blocks ───────────────────────────────────────────────────────────────

router.get("/doctor-blocks", asyncH(async (_req, res) => {
  res.json({ blocks: await listDoctorBlocks() });
}));

router.get("/doctor-blocks/:id", asyncH(async (req, res) => {
  res.json(await getDoctorBlock(Number(req.params.id)));
}));

router.post("/doctor-blocks", asyncH(async (req, res) => {
  const { name, description, wardIds, doctorIds } = z.object({
    name:        z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    wardIds:     z.array(z.number().int()).optional(),
    doctorIds:   z.array(z.number().int()).optional(),
  }).parse(req.body);
  const result = await createDoctorBlock({ name, description, wardIds, doctorIds, adminId: req.user!.id });
  emitUpdate("bed:update", { doctorBlockId: result.id }, { wardId: wardIds ?? [] });
  res.status(201).json(result);
}));

router.put("/doctor-blocks/:id", asyncH(async (req, res) => {
  const { name, description, wardIds, doctorIds } = z.object({
    name:        z.string().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    wardIds:     z.array(z.number().int()).optional(),
    doctorIds:   z.array(z.number().int()).optional(),
  }).parse(req.body);
  const blockId = Number(req.params.id);
  // Ward rooms before AND after the edit must be notified (a ward could be removed).
  const before = await wardIdsForDoctorBlock(blockId);
  const result = await editDoctorBlock({
    blockId, name, description: description ?? undefined, wardIds, doctorIds, adminId: req.user!.id,
  });
  const after = await wardIdsForDoctorBlock(blockId);
  emitUpdate("bed:update", { doctorBlockId: blockId }, { wardId: [...new Set([...before, ...after])] });
  res.json(result);
}));

router.patch("/doctor-blocks/:id/status", asyncH(async (req, res) => {
  const { status } = z.object({ status: z.enum(["active", "inactive"]) }).parse(req.body);
  const blockId = Number(req.params.id);
  const wardIds = await wardIdsForDoctorBlock(blockId);
  const result = await setDoctorBlockStatus(blockId, status, req.user!.id);
  emitUpdate("bed:update", { doctorBlockId: blockId, status }, { wardId: wardIds });
  res.json(result);
}));

router.delete("/doctor-blocks/:id", asyncH(async (req, res) => {
  const blockId = Number(req.params.id);
  const wardIds = await wardIdsForDoctorBlock(blockId);
  const result = await deleteDoctorBlock(blockId, req.user!.id);
  emitUpdate("bed:update", { doctorBlockId: blockId }, { wardId: wardIds });
  res.json(result);
}));

// ── Payer Types ───────────────────────────────────────────────────────────────
router.get("/payer-types", asyncH(async (_req, res) => {
  res.json({ payerTypes: await listPayerTypes() });
}));

router.post("/payer-types", asyncH(async (req, res) => {
  const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
  const result = await createPayerType({ name, userId: req.user!.id });
  emitUpdate("bed:update", { payerTypeId: result.id });
  res.status(201).json(result);
}));

router.put("/payer-types/:id", asyncH(async (req, res) => {
  const { name, active } = z.object({
    name:   z.string().min(1).max(100).optional(),
    active: z.boolean().optional(),
  }).parse(req.body);
  const id = Number(req.params.id);
  const result = await updatePayerType({ id, name, active, userId: req.user!.id });
  emitUpdate("bed:update", { payerTypeId: id });
  res.json(result);
}));

router.patch("/payer-types/:id/order", asyncH(async (req, res) => {
  const { direction } = z.object({ direction: z.enum(["up", "down"]) }).parse(req.body);
  const id = Number(req.params.id);
  const result = await reorderPayerType({ id, direction, userId: req.user!.id });
  emitUpdate("bed:update", { payerTypeId: id });
  res.json(result);
}));

router.delete("/payer-types/:id", asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const result = await deletePayerType({ id, userId: req.user!.id });
  emitUpdate("bed:update", { payerTypeId: id });
  res.json(result);
}));

// ── Destinations ──────────────────────────────────────────────────────────────
router.get("/destinations", asyncH(async (_req, res) => {
  res.json({ destinations: await listDestinations() });
}));

router.post("/destinations", asyncH(async (req, res) => {
  const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
  const result = await createDestination({ name, userId: req.user!.id });
  emitUpdate("bed:update", { destinationId: result.id });
  res.status(201).json(result);
}));

router.put("/destinations/:id", asyncH(async (req, res) => {
  const { name, active } = z.object({
    name:   z.string().min(1).max(100).optional(),
    active: z.boolean().optional(),
  }).parse(req.body);
  const id = Number(req.params.id);
  const result = await updateDestination({ id, name, active, userId: req.user!.id });
  emitUpdate("bed:update", { destinationId: id });
  res.json(result);
}));

router.patch("/destinations/:id/order", asyncH(async (req, res) => {
  const { direction } = z.object({ direction: z.enum(["up", "down"]) }).parse(req.body);
  const id = Number(req.params.id);
  const result = await reorderDestination({ id, direction, userId: req.user!.id });
  emitUpdate("bed:update", { destinationId: id });
  res.json(result);
}));

router.delete("/destinations/:id", asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const result = await deleteDestination({ id, userId: req.user!.id });
  emitUpdate("bed:update", { destinationId: id });
  res.json(result);
}));

// ── Departments & Doctors (master data) — admin-only. Deliberately separate from
// the ward/floor/building-block hierarchy: a doctor/department is not a physical
// place, so none of this touches wards/beds/floors. ────────────────────────────

router.get("/departments", asyncH(async (_req, res) => {
  res.json({ departments: await listDepartments(false) });
}));

router.post("/departments", asyncH(async (req, res) => {
  const { name } = z.object({ name: z.string().min(1).max(150) }).parse(req.body);
  const department = await createDepartment(name);
  emitRefDataChanged("departments");
  res.json({ department });
}));

router.put("/departments/:id", asyncH(async (req, res) => {
  const { name, active } = z.object({
    name:   z.string().min(1).max(150).optional(),
    active: z.boolean().optional(),
  }).parse(req.body);
  const id = Number(req.params.id);
  const updated = await updateDepartment({ id, name, active, userId: req.user!.id });
  emitRefDataChanged("departments");
  res.json(updated);
}));

router.delete("/departments/:id", asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const removed = await deleteDepartment({ id, userId: req.user!.id });
  emitRefDataChanged("departments");
  res.json(removed);
}));

// Read-only — still needed by the Consultant Groups member picker. Creating/
// editing/deleting a doctor now happens only via /consultants below, since a
// doctor never exists without its consultant login (created together, see
// consultantUserService.ts).
router.get("/doctors-master", asyncH(async (_req, res) => {
  res.json({ doctors: await listDoctorsWithDepartments(false) });
}));

// ── Consultant Groups — joint-ownership bundles (e.g. "Vijay / Kumari") for
// patients admitted under more than one consultant at once. Separate entity
// from doctors_master, never merged with it. ───────────────────────────────

router.get("/consultant-groups", asyncH(async (_req, res) => {
  res.json({ groups: await listGroupsWithDetails(false) });
}));

router.post("/consultant-groups", asyncH(async (req, res) => {
  const { name, doctor_ids, department_ids } = z.object({
    name: z.string().min(1).max(150),
    doctor_ids: z.array(z.number().int().positive()).min(2),
    department_ids: z.array(z.number().int().positive()).min(1),
  }).parse(req.body);
  const group = await createConsultantGroup({ name, doctorIds: doctor_ids, departmentIds: department_ids, userId: req.user!.id });
  emitRefDataChanged("consultant-groups");
  res.json({ group });
}));

router.put("/consultant-groups/:id", asyncH(async (req, res) => {
  const { name, active, doctor_ids, department_ids } = z.object({
    name:           z.string().min(1).max(150).optional(),
    active:         z.boolean().optional(),
    doctor_ids:     z.array(z.number().int().positive()).min(2).optional(),
    department_ids: z.array(z.number().int().positive()).min(1).optional(),
  }).parse(req.body);
  const id = Number(req.params.id);
  const updated = await updateConsultantGroup({ id, name, active, doctorIds: doctor_ids, departmentIds: department_ids, userId: req.user!.id });
  emitRefDataChanged("consultant-groups");
  res.json(updated);
}));

router.delete("/consultant-groups/:id", asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const removed = await deleteConsultantGroup({ id, userId: req.user!.id });
  emitRefDataChanged("consultant-groups");
  res.json(removed);
}));

// ── Discharge Lounge — a virtual holding ward, set up once by an admin. Lives
// outside the floor/building-block hierarchy (no floorId) and never counts toward
// hospital total/Census/Non-Census beds anywhere in the app. ───────────────────

router.get("/discharge-lounge", asyncH(async (_req, res) => {
  res.json(await getDischargeLounge());
}));

router.post("/discharge-lounge", asyncH(async (req, res) => {
  const { name, initial_beds } = z.object({
    name: z.string().min(1).max(150),
    initial_beds: z.number().int().min(0).max(200),
  }).parse(req.body);
  const result = await setupDischargeLounge({ name, initialBeds: initial_beds, managerId: req.user!.id });
  res.status(201).json(result);
}));

router.put("/discharge-lounge", asyncH(async (req, res) => {
  const { name } = z.object({ name: z.string().min(1).max(150) }).parse(req.body);
  res.json(await renameDischargeLounge({ name, managerId: req.user!.id }));
}));

// Bulk range disable/enable, e.g. "beds 51 to 300 are no longer in service" —
// far cheaper than editing 250 beds one at a time, and those beds can't be
// deleted anyway once they've ever held a patient (bed_details is referenced
// ON DELETE RESTRICT by patient_admissions/bed_transfer_history).
router.patch("/discharge-lounge/beds/bulk-operational", asyncH(async (req, res) => {
  const { fromNum, toNum, operationalStatus } = z.object({
    fromNum: z.number().int().min(0),
    toNum: z.number().int().min(0),
    operationalStatus: z.boolean(),
  }).refine((v) => v.fromNum <= v.toNum, { message: "'From' bed number must be less than or equal to 'To'." }).parse(req.body);

  const ward = await getDischargeLoungeWard();
  if (!ward) throw new HttpError(404, "Discharge Lounge is not configured yet");

  const result = await bulkSetBedOperational({
    wardId: ward.id, fromNum, toNum, operationalStatus, userId: req.user!.id,
  });
  emitUpdate("bed:update", { wardId: ward.id });
  res.json(result);
}));

// ── Consultant Users — created as one unit (login + doctors_master identity),
// same pattern as PRE/Nurse/Doctor user management. Departments are assigned as
// a follow-up edit, not required at creation. ──────────────────────────────────

router.get("/consultants", asyncH(async (_req, res) => {
  res.json({ consultants: await listConsultantUsers() });
}));

router.post("/consultants", asyncH(async (req, res) => {
  const { name, username, password, department_ids } = z.object({
    name: z.string().min(1).max(150),
    username: z.string().min(1).max(60),
    password: z.string().min(8).max(72),
    department_ids: z.array(z.number().int().positive()).optional(),
  }).parse(req.body);
  const consultant = await createConsultantUser({ name, username, password, departmentIds: department_ids, userId: req.user!.id });
  emitRefDataChanged("doctors");
  res.status(201).json({ consultant });
}));

router.put("/consultants/:id", asyncH(async (req, res) => {
  const { name, username, password, active, department_ids } = z.object({
    name:           z.string().min(1).max(150).optional(),
    username:       z.string().min(1).max(60).optional(),
    password:       z.string().min(8).max(72).optional(),
    active:         z.boolean().optional(),
    department_ids: z.array(z.number().int().positive()).optional(),
  }).parse(req.body);
  const id = Number(req.params.id);
  const updated = await updateConsultantUser({ id, name, username, password, active, departmentIds: department_ids, userId: req.user!.id });
  emitRefDataChanged("doctors");
  res.json(updated);
}));

router.delete("/consultants/:id", asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const removed = await deleteConsultantUser({ id, userId: req.user!.id });
  emitRefDataChanged("doctors");
  res.json(removed);
}));

// ── Discharge Phase SLAs ─────────────────────────────────────────────────────
// The COO sets expected duration per phase; these are the hospital's SLAs and
// drive deadline/delay detection and the ETA shown to every role. Phase keys are
// fixed (they map to discharge_tracking columns) — only label, department and
// duration are editable, so there is no create/delete here.

router.get("/discharge-phases", asyncH(async (_req, res) => {
  res.json({ phases: await listPhaseConfig() });
}));

router.put("/discharge-phases/:id", asyncH(async (req, res) => {
  const { label, department, expected_minutes } = z.object({
    label:            z.string().min(1).max(100).optional(),
    department:       z.string().max(100).nullable().optional(),
    expected_minutes: z.number().int().min(0).max(1440).optional(),
  }).parse(req.body);
  const result = await updatePhaseConfig({
    id: Number(req.params.id), label, department,
    expectedMinutes: expected_minutes, userId: req.user!.id,
  });
  emitUpdate("discharge:update", { type: "phase-config" });
  res.json(result);
}));

router.patch("/discharge-phases/:id/order", asyncH(async (req, res) => {
  const { direction } = z.object({ direction: z.enum(["up", "down"]) }).parse(req.body);
  const result = await reorderPhaseConfig({ id: Number(req.params.id), direction, userId: req.user!.id });
  emitUpdate("discharge:update", { type: "phase-config" });
  res.json(result);
}));

// ── Payer TAT config ─────────────────────────────────────────────────────────

router.get("/payer-tat", asyncH(async (_req, res) => {
  res.json({ rows: await listPayerTatConfig() });
}));

router.post("/payer-tat", asyncH(async (req, res) => {
  const { payer_type, phase_key, target_minutes } = z.object({
    payer_type:     z.string().min(1).max(100),
    phase_key:      z.string().max(50).nullable().optional().default(null),
    target_minutes: z.number().int().min(0).max(1440),
  }).parse(req.body);

  const pk = phase_key ?? null;
  const existing = pk
    ? await db.prepare("SELECT id FROM payer_tat_config WHERE payer_type=? AND phase_key=?").get<{ id: number }>(payer_type, pk)
    : await db.prepare("SELECT id FROM payer_tat_config WHERE payer_type=? AND phase_key IS NULL").get<{ id: number }>(payer_type);
  if (existing) throw new HttpError(409, "A config already exists for this payer / step combination");

  const now = Date.now();
  const r = await db.prepare(
    "INSERT INTO payer_tat_config (payer_type, phase_key, target_minutes, created_at, updated_at) VALUES (?,?,?,?,?) RETURNING id"
  ).run(payer_type, pk, target_minutes, now, now);
  invalidatePayerTatCache();
  res.status(201).json({ ok: true, id: r.lastInsertRowid });
}));

router.put("/payer-tat/:id", asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const { target_minutes } = z.object({
    target_minutes: z.number().int().min(0).max(1440),
  }).parse(req.body);
  const row = await db.prepare("SELECT id FROM payer_tat_config WHERE id=?").get<{ id: number }>(id);
  if (!row) throw new HttpError(404, "Payer TAT config not found");
  await db.prepare("UPDATE payer_tat_config SET target_minutes=?, updated_at=? WHERE id=?")
    .run(target_minutes, Date.now(), id);
  invalidatePayerTatCache();
  res.json({ ok: true });
}));

router.delete("/payer-tat/:id", asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const row = await db.prepare("SELECT id FROM payer_tat_config WHERE id=?").get<{ id: number }>(id);
  if (!row) throw new HttpError(404, "Payer TAT config not found");
  await db.prepare("DELETE FROM payer_tat_config WHERE id=?").run(id);
  invalidatePayerTatCache();
  res.json({ ok: true });
}));

// ── FC & Pharmacy Logins ────────────────────────────────────────────────────

// PWO joins this set rather than getting its own CRUD: "simple login" here means
// a username/password account with no ward/block/station assignment, which is
// exactly what a Patient Welfare Officer is. Admin gets create / edit / rename /
// enable-disable / reset-password / active-status for free from the existing
// routes and the existing SimpleLoginManager screen — no new Admin page.
const SIMPLE_ROLES = ["FC", "MASTER_FC", "PHARMACY", "MASTER_PHARMACY", "PWO"] as const;
type SimpleRole = (typeof SIMPLE_ROLES)[number];

router.get("/simple-logins", asyncH(async (req, res) => {
  const role = z.enum(SIMPLE_ROLES).parse(req.query.role);
  const rows = await db.prepare(
    `SELECT id, username, name, role, status FROM users WHERE role=? ORDER BY name`
  ).all<{ id: number; username: string; name: string; role: string; status: string }>(role);
  res.json({ logins: rows });
}));

router.post("/simple-logins", asyncH(async (req, res) => {
  const { role, username, password, name } = z.object({
    role:     z.enum(SIMPLE_ROLES),
    username: z.string().min(1).max(60).regex(/^[a-z0-9._-]+$/i, "Invalid username"),
    password: z.string().min(6).max(72),
    name:     z.string().min(1).max(120),
  }).parse(req.body);

  const u = username.trim().toLowerCase();
  const clash = await db.prepare("SELECT id FROM users WHERE username=?").get<{ id: number }>(u);
  if (clash) throw new HttpError(409, "Username already taken");

  const now = Date.now();
  const hash = bcrypt.hashSync(password, 12);
  const row = await db.prepare(
    `INSERT INTO users (username, password_hash, role, name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?) RETURNING id, username, name, role, status`
  ).get<{ id: number; username: string; name: string; role: string; status: string }>(
    u, hash, role, name.trim(), now, now
  );
  res.status(201).json({ login: row });
}));

router.put("/simple-logins/:id", asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const { username, password, name, status } = z.object({
    username: z.string().min(1).max(60).regex(/^[a-z0-9._-]+$/i).optional(),
    password: z.string().min(6).max(72).optional(),
    name:     z.string().min(1).max(120).optional(),
    status:   z.enum(["active", "inactive"]).optional(),
  }).parse(req.body);

  const user = await db.prepare("SELECT id, role FROM users WHERE id=?").get<{ id: number; role: string }>(id);
  if (!user || !(SIMPLE_ROLES as readonly string[]).includes(user.role))
    throw new HttpError(404, "Login not found");

  const now = Date.now();
  if (username) {
    const u = username.trim().toLowerCase();
    const clash = await db.prepare("SELECT id FROM users WHERE username=? AND id<>?").get<{ id: number }>(u, id);
    if (clash) throw new HttpError(409, "Username already taken");
    await db.prepare("UPDATE users SET username=?, updated_at=? WHERE id=?").run(u, now, id);
  }
  if (password) {
    const hash = bcrypt.hashSync(password, 12);
    await db.prepare("UPDATE users SET password_hash=?, updated_at=? WHERE id=?").run(hash, now, id);
  }
  if (name) await db.prepare("UPDATE users SET name=?, updated_at=? WHERE id=?").run(name.trim(), now, id);
  if (status) await db.prepare("UPDATE users SET status=?, updated_at=? WHERE id=?").run(status, now, id);

  const updated = await db.prepare("SELECT id, username, name, role, status FROM users WHERE id=?")
    .get<{ id: number; username: string; name: string; role: string; status: string }>(id);
  res.json({ login: updated });
}));

router.delete("/simple-logins/:id", asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const user = await db.prepare("SELECT id, role FROM users WHERE id=?").get<{ id: number; role: string }>(id);
  if (!user || !(SIMPLE_ROLES as readonly string[]).includes(user.role))
    throw new HttpError(404, "Login not found");
  await db.prepare("DELETE FROM users WHERE id=?").run(id);
  res.json({ ok: true });
}));

export default router;
