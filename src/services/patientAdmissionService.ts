import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { ALLOW_FUTURE_ADMISSION_DATE, isValidIsoDate, todayStr } from "../config/domain.js";
import { audit } from "./auditService.js";
import { consultantRoomsFor } from "./consultantGroupService.js";
import { emitConsultantPatientUpdate } from "../websocket/io.js";

export interface PatientAdmission {
  id: number;
  bed_id: number;
  ward_id: number;
  /** Null only for admissions backfilled for beds that were already Occupied
   *  before the discharge module existed — every new admission has one. */
  ip_last6: string | null;
  /** Required on every new admission, but null on any admission created before
   *  this field existed — those stay blank until staff edit them in. Anything
   *  rendering it must handle null rather than assume a name is present. */
  patient_name: string | null;
  /** The date the patient was admitted to the hospital, as typed by the user —
   *  "YYYY-MM-DD", no time, no timezone. Distinct from admitted_at, which is the
   *  server clock at the moment this bed flipped to Occupied. Null on admissions
   *  predating this field, same as patient_name. */
  admission_date: string | null;
  /** Manual free-text entry captured at admission — same "V1 manual, HIS later" pattern as ip_last6. */
  consultant_name: string | null;
  department_name: string | null;
  doctor_id: number | null;
  department_id: number | null;
  /** "DOCTOR" (single consultant, doctor_id set) or "GROUP" (joint Consultant
   *  Group, consultant_group_id set) — never both, enforced by a DB CHECK. */
  owner_type: "DOCTOR" | "GROUP";
  consultant_group_id: number | null;
  /** "IP" | "DAYCARE" — null only for admissions predating this field. */
  admission_type: string | null;
  status: "ACTIVE" | "DISCHARGED";
  admitted_at: number;
  discharged_at: number | null;
  created_by: number | null;
  updated_at: number;
  /** Set the moment the patient is known to have physically left the bed — e.g. a
   *  manual Bed Transfer into the Discharge Lounge before any discharge was planned.
   *  Independent of discharge_tracking, which may not exist yet at that point. */
  physically_left_at: number | null;
}

const IP_LAST6_RE = /^\d{6}$/;
const ADMISSION_TYPES = ["IP", "DAYCARE", "OPD"];

export function validateIpLast6(ipLast6: string | undefined | null): string {
  const trimmed = (ipLast6 ?? "").toString().trim();
  if (!trimmed) throw new HttpError(400, "Last 6 digits of IP Number are required.");
  if (!IP_LAST6_RE.test(trimmed))
    throw new HttpError(400, "IP Number must be exactly 6 digits.");
  return trimmed;
}

export function validateAdmissionType(admissionType: string | undefined | null): string {
  const value = (admissionType ?? "").toString().trim().toUpperCase();
  if (!ADMISSION_TYPES.includes(value)) throw new HttpError(400, "Admission type must be IP, Daycare, or OPD.");
  return value;
}

const PATIENT_NAME_MAX = 120;

/** Patient name as typed by the user. Runs of whitespace are collapsed so
 *  "John   Smith" and "John Smith" don't become two different-looking patients.
 *  Rejects blank — the column is nullable only so that pre-existing rows can stay
 *  blank, never so that a new value may be saved empty. */
export function validatePatientName(patientName: string | undefined | null): string {
  const trimmed = (patientName ?? "").toString().trim().replace(/\s+/g, " ");
  if (!trimmed) throw new HttpError(400, "Patient name is required.");
  if (trimmed.length > PATIENT_NAME_MAX)
    throw new HttpError(400, `Patient name must be ${PATIENT_NAME_MAX} characters or fewer.`);
  return trimmed;
}

/** User-entered date of admission, "YYYY-MM-DD". */
export function validateAdmissionDate(admissionDate: string | undefined | null): string {
  const trimmed = (admissionDate ?? "").toString().trim();
  if (!trimmed) throw new HttpError(400, "Date of admission is required.");
  if (!isValidIsoDate(trimmed))
    throw new HttpError(400, "Date of admission must be a valid date in YYYY-MM-DD format.");
  // Compared as strings on purpose: zero-padded ISO dates sort chronologically,
  // so this is an exact calendar comparison with no Date arithmetic and no
  // timezone to get wrong. todayStr() is IST — using the server's own clock here
  // would reject a legitimately-today date for the 5.5 hours each night that
  // UTC is still on the previous day.
  if (!ALLOW_FUTURE_ADMISSION_DATE && trimmed > todayStr())
    throw new HttpError(400, "Date of admission cannot be in the future.");
  return trimmed;
}

/** Exactly one of doctorId/consultantGroupId must be set — never both, never
 *  neither. Mirrors the DB's chk_admission_owner CHECK constraint. */
function resolveOwnerType(doctorId: number | null, consultantGroupId: number | null): "DOCTOR" | "GROUP" {
  const hasDoctor = doctorId != null;
  const hasGroup = consultantGroupId != null;
  if (hasDoctor === hasGroup)
    throw new HttpError(400, "Select exactly one consultant or Consultant Group.");
  return hasGroup ? "GROUP" : "DOCTOR";
}

/** Resolves the display-name mirror stored in consultant_name, and — for a
 *  group owner — validates the chosen department actually belongs to that
 *  group (a group can only admit under one of its own mapped departments). */
async function resolveOwnerName(
  ownerType: "DOCTOR" | "GROUP", doctorId: number | null, consultantGroupId: number | null, departmentId: number,
): Promise<string> {
  if (ownerType === "DOCTOR") {
    const row = await db.prepare("SELECT name FROM doctors_master WHERE id=?").get<{ name: string }>(doctorId);
    if (!row) throw new HttpError(400, "Selected consultant not found.");
    return row.name;
  }
  const row = await db.prepare("SELECT name FROM consultant_groups WHERE id=?").get<{ name: string }>(consultantGroupId);
  if (!row) throw new HttpError(400, "Selected Consultant Group not found.");
  const deptOk = await db.prepare(
    "SELECT 1 FROM consultant_group_departments WHERE group_id=? AND department_id=?"
  ).get(consultantGroupId, departmentId);
  if (!deptOk) throw new HttpError(400, "Selected department is not associated with this Consultant Group.");
  return row.name;
}

export async function getActiveAdmissionByBed(bedId: number): Promise<PatientAdmission | undefined> {
  return db.prepare(
    "SELECT * FROM patient_admissions WHERE bed_id=? AND status='ACTIVE'"
  ).get<PatientAdmission>(bedId);
}

/** Same row shape as GET /consultant/my-patients, for exactly one admission —
 *  reused by every real-time emit site so a targeted socket event carries enough
 *  to patch that one row on the receiving MyPatientsPage without a refetch. */
export async function getMyPatientsRow(admissionId: number): Promise<Record<string, unknown> | undefined> {
  return db.prepare(
    `SELECT
       bd.id AS bed_id, bd.bed_name, bd.ward_id, w.name AS ward_name,
       bd.physical_status, bd.reservation_status, bd.destination, bd.reservation_note,
       bd.operational_status, bd.updated_at, bd.payer_type,
       pa.id AS admission_id, pa.consultant_name, pa.department_name,
       pa.owner_type, pa.doctor_id, pa.consultant_group_id,
       pa.ip_last6, pa.patient_name, pa.admission_date, pa.admission_type, pa.admitted_at,
       row_to_json(dt.*) AS discharge_tracking
     FROM patient_admissions pa
     JOIN bed_details bd ON bd.id = pa.bed_id
     JOIN wards w ON w.id = bd.ward_id
     LEFT JOIN discharge_tracking dt ON dt.admission_id = pa.id
     WHERE pa.id = ?`
  ).get<Record<string, unknown>>(admissionId);
}

export async function getAdmissionById(admissionId: number): Promise<PatientAdmission | undefined> {
  return db.prepare("SELECT * FROM patient_admissions WHERE id=?").get<PatientAdmission>(admissionId);
}

/** Creates a fresh admission for a bed that just went Vacant → Occupied. Called from the
 *  bedDetailService post-commit hook — never call this directly from a route. */
export async function createAdmission(opts: {
  bedId: number; wardId: number; ipLast6: string; admissionType: string; userId: number;
  patientName: string; admissionDate: string;
  departmentName?: string | null;
  doctorId?: number | null; departmentId?: number | null;
  consultantGroupId?: number | null;
}): Promise<PatientAdmission> {
  const ipLast6 = validateIpLast6(opts.ipLast6);
  const admissionType = validateAdmissionType(opts.admissionType);
  // Required on every new admission — unlike the edit path, there is no
  // "pre-existing blank" case to accommodate here.
  const patientName = validatePatientName(opts.patientName);
  const admissionDate = validateAdmissionDate(opts.admissionDate);
  const departmentName = opts.departmentName?.toString().trim() || null;
  const departmentId = opts.departmentId ?? null;
  if (!departmentId) throw new HttpError(400, "Department is required.");

  const doctorId = opts.doctorId ?? null;
  const consultantGroupId = opts.consultantGroupId ?? null;
  const ownerType = resolveOwnerType(doctorId, consultantGroupId);
  const consultantName = await resolveOwnerName(ownerType, doctorId, consultantGroupId, departmentId);

  const existing = await getActiveAdmissionByBed(opts.bedId);
  if (existing) throw new HttpError(409, "This bed already has an active patient admission.");

  const dupIp = await db.prepare(
    "SELECT bed_id FROM patient_admissions WHERE ip_last6=? AND status='ACTIVE' LIMIT 1"
  ).get<{ bed_id: number }>(ipLast6);
  if (dupIp) {
    const dupBed = await db.prepare("SELECT bed_name FROM bed_details WHERE id=?").get<{ bed_name: string }>(dupIp.bed_id);
    throw new HttpError(409, `IP ${ipLast6} is already admitted on bed ${dupBed?.bed_name ?? dupIp.bed_id}. Discharge or transfer the existing admission first.`);
  }

  const now = Date.now();
  const row = await db.prepare(
    `INSERT INTO patient_admissions (bed_id, ward_id, ip_last6, patient_name, admission_date, admission_type, consultant_name, department_name, doctor_id, department_id, owner_type, consultant_group_id, status, admitted_at, created_by, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?) RETURNING id`
  ).run(
    opts.bedId, opts.wardId, ipLast6, patientName, admissionDate, admissionType, consultantName, departmentName,
    ownerType === "DOCTOR" ? doctorId : null, departmentId, ownerType, ownerType === "GROUP" ? consultantGroupId : null,
    now, opts.userId, now,
  );
  const admission = await getAdmissionById(Number(row.lastInsertRowid));

  await audit(opts.userId, "admission_create", String(opts.bedId), { ipLast6, patientName, admissionDate, admissionType, wardId: opts.wardId, consultantName, departmentName, ownerType, doctorId, consultantGroupId, departmentId });

  const rooms = consultantRoomsFor({ owner_type: ownerType, doctor_id: doctorId, consultant_group_id: consultantGroupId });
  if (rooms.length) {
    const row = await getMyPatientsRow(admission!.id);
    if (row) emitConsultantPatientUpdate(rooms, { type: "ADMITTED", action: "UPSERT", ...row });
  }

  return admission!;
}

/** Corrects details captured at admission time (typo in IP number, wrong consultant
 *  picked, etc.) on the bed's currently active admission. Unlike createAdmission this
 *  never changes bed_details.physical_status — the bed stays Occupied throughout, only
 *  the patient_admissions row is touched. Every field is optional/independent so a
 *  caller can send only what changed; omitted fields keep their current value. */
export async function updateActiveAdmission(opts: {
  bedId: number; userId: number;
  ipLast6?: string; admissionType?: string;
  patientName?: string; admissionDate?: string;
  departmentName?: string | null;
  doctorId?: number | null; departmentId?: number | null;
  consultantGroupId?: number | null;
  payerType?: string | null;
}): Promise<PatientAdmission> {
  const admission = await getActiveAdmissionByBed(opts.bedId);
  if (!admission) throw new HttpError(404, "No active admission on this bed.");

  const ipLast6 = opts.ipLast6 !== undefined ? validateIpLast6(opts.ipLast6) : admission.ip_last6;

  // Same invariant createAdmission() enforces on a fresh Vacant→Occupied admit
  // (one ACTIVE admission per IP number) — re-checked here because Edit Patient
  // Information can change ip_last6 on an already-Occupied bed without ever
  // going through createAdmission. Excludes this admission's own id so
  // re-saving the same IP (or editing an unrelated field) never self-conflicts.
  if (opts.ipLast6 !== undefined && ipLast6 !== admission.ip_last6) {
    const dupIp = await db.prepare(
      "SELECT bed_id FROM patient_admissions WHERE ip_last6=? AND status='ACTIVE' AND id<>? LIMIT 1"
    ).get<{ bed_id: number }>(ipLast6, admission.id);
    if (dupIp) {
      const dupBed = await db.prepare("SELECT bed_name FROM bed_details WHERE id=?").get<{ bed_name: string }>(dupIp.bed_id);
      throw new HttpError(409, `IP ${ipLast6} is already admitted on bed ${dupBed?.bed_name ?? dupIp.bed_id}. Discharge or transfer the existing admission first.`);
    }
  }

  const admissionType = opts.admissionType !== undefined ? validateAdmissionType(opts.admissionType) : admission.admission_type;

  // Patient name / date of admission are required on create but only conditionally
  // here, and the condition is "was this field sent at all". The client diffs the
  // edit form against a snapshot and sends only what the user actually touched, so
  // `undefined` means untouched — the stored value is kept verbatim, including the
  // null carried by every admission that predates these two columns. That is what
  // lets FC fix a payer type on an old bed without being forced to invent a name
  // and an admission date for a patient admitted weeks ago. The moment either
  // field IS sent it goes through the same validator create uses, so a touched
  // field can never be saved blank or malformed — staff fill these in over time,
  // and each one that gets filled in is fully validated.
  const patientName = opts.patientName !== undefined ? validatePatientName(opts.patientName) : admission.patient_name;
  const admissionDate = opts.admissionDate !== undefined ? validateAdmissionDate(opts.admissionDate) : admission.admission_date;

  const departmentId = opts.departmentId !== undefined ? opts.departmentId : admission.department_id;
  const departmentName = opts.departmentName !== undefined ? (opts.departmentName?.toString().trim() || null) : admission.department_name;
  if (!departmentId) throw new HttpError(400, "Department is required.");

  // Changing the owner requires sending both fields together (even if one is
  // explicitly null) — the caller always knows the full new owner state, so a
  // half-sent pair would mean a client bug, not a legitimate partial update.
  const ownerChanging = opts.doctorId !== undefined || opts.consultantGroupId !== undefined;
  if (ownerChanging && (opts.doctorId === undefined || opts.consultantGroupId === undefined))
    throw new HttpError(400, "doctorId and consultantGroupId must be sent together when changing the consultant.");

  const doctorId = ownerChanging ? (opts.doctorId ?? null) : admission.doctor_id;
  const consultantGroupId = ownerChanging ? (opts.consultantGroupId ?? null) : admission.consultant_group_id;
  const ownerType = ownerChanging ? resolveOwnerType(doctorId, consultantGroupId) : admission.owner_type;
  // Department membership (for a group owner) is re-validated every time, not
  // just when the owner changes — it's an invariant that must always hold,
  // including when only the department itself changes on an existing group admission.
  const consultantName = ownerType === "GROUP" || ownerChanging
    ? await resolveOwnerName(ownerType, doctorId, consultantGroupId, departmentId)
    : admission.consultant_name;

  const now = Date.now();
  await db.transaction(async () => {
    const r = await db.prepare(
      `UPDATE patient_admissions
       SET ip_last6=?, patient_name=?, admission_date=?, admission_type=?, consultant_name=?, department_name=?, doctor_id=?, department_id=?, owner_type=?, consultant_group_id=?, updated_at=?
       WHERE id=? AND status='ACTIVE' AND updated_at=?`
    ).run(ipLast6, patientName, admissionDate, admissionType, consultantName, departmentName, doctorId, departmentId, ownerType, consultantGroupId, now, admission.id, admission.updated_at);
    if (r.changes === 0) throw new HttpError(409, "Patient info was just updated by someone else. Please refresh and try again.");

    if (opts.payerType !== undefined) {
      await db.prepare(
        "UPDATE bed_details SET payer_type=?, updated_at=? WHERE id=?"
      ).run(opts.payerType, now, opts.bedId);
    }

    await audit(opts.userId, "admission_update", String(opts.bedId), {
      old: {
        ipLast6: admission.ip_last6, admissionType: admission.admission_type,
        patientName: admission.patient_name, admissionDate: admission.admission_date,
        consultantName: admission.consultant_name, departmentName: admission.department_name,
        ownerType: admission.owner_type, doctorId: admission.doctor_id, consultantGroupId: admission.consultant_group_id,
        departmentId: admission.department_id,
        payerType: opts.payerType !== undefined ? undefined : "(unchanged)",
      },
      new: { ipLast6, patientName, admissionDate, admissionType, consultantName, departmentName, ownerType, doctorId, consultantGroupId, departmentId,
             ...(opts.payerType !== undefined ? { payerType: opts.payerType } : {}) },
    });
  });

  // Ownership change: the old owner's rooms get a REMOVE (they no longer see this
  // patient), the new owner's rooms get an UPSERT (add if new to them, patch if
  // somehow already visible) — the room split itself decides add vs remove, so
  // the receiving page never has to reason about "is this still mine". A
  // non-owner change (IP fix, department correction, etc.) only reaches the
  // unchanged current owner as a plain UPSERT.
  const oldRooms = ownerChanging ? consultantRoomsFor({ owner_type: admission.owner_type, doctor_id: admission.doctor_id, consultant_group_id: admission.consultant_group_id }) : [];
  const newRooms = consultantRoomsFor({ owner_type: ownerType, doctor_id: doctorId, consultant_group_id: consultantGroupId });
  const removedRooms = oldRooms.filter((r) => !newRooms.includes(r));
  if (removedRooms.length) {
    emitConsultantPatientUpdate(removedRooms, { type: "OWNERSHIP_CHANGED", action: "REMOVE", admission_id: admission.id, bed_id: admission.bed_id });
  }
  if (newRooms.length) {
    const row = await getMyPatientsRow(admission.id);
    if (row) emitConsultantPatientUpdate(newRooms, { type: ownerChanging ? "OWNERSHIP_CHANGED" : "UPDATED", action: "UPSERT", ...row });
  }

  return (await getAdmissionById(admission.id))!;
}

/** Closes an admission — either a normal discharge completion or a manual/unexpected vacate. */
export async function closeAdmission(admissionId: number, userId: number | null): Promise<void> {
  const now = Date.now();
  const admission = await getAdmissionById(admissionId);
  const r = await db.prepare(
    "UPDATE patient_admissions SET status='DISCHARGED', discharged_at=?, updated_at=? WHERE id=? AND status='ACTIVE'"
  ).run(now, now, admissionId);
  await audit(userId, "admission_close", String(admissionId), {});

  if (r.changes > 0 && admission) {
    const rooms = consultantRoomsFor(admission);
    if (rooms.length) emitConsultantPatientUpdate(rooms, { type: "DISCHARGED", action: "REMOVE", admission_id: admissionId, bed_id: admission.bed_id });
  }
}

/** Moves an admission (and thus its discharge workflow) to a new bed/ward — used by bed transfer. */
export async function moveAdmission(opts: {
  admissionId: number; newBedId: number; newWardId: number; userId: number;
}): Promise<void> {
  const now = Date.now();
  await db.prepare(
    "UPDATE patient_admissions SET bed_id=?, ward_id=?, updated_at=? WHERE id=?"
  ).run(opts.newBedId, opts.newWardId, now, opts.admissionId);
  await audit(opts.userId, "admission_move", String(opts.admissionId), {
    newBedId: opts.newBedId, newWardId: opts.newWardId,
  });

  const admission = await getAdmissionById(opts.admissionId);
  const rooms = admission ? consultantRoomsFor(admission) : [];
  if (rooms.length) {
    const row = await getMyPatientsRow(opts.admissionId);
    if (row) emitConsultantPatientUpdate(rooms, { type: "TRANSFERRED", action: "UPSERT", ...row });
  }
}
