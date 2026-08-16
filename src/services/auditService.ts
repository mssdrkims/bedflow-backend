import { db } from "../db/index.js";

const MAX_DETAIL_BYTES = 2048;

export async function audit(userId: number | null, action: string, entity: string | null, detail: unknown) {
  let json = JSON.stringify(detail ?? {});
  if (json.length > MAX_DETAIL_BYTES)
    json = JSON.stringify({ _truncated: true, preview: json.slice(0, 200) });
  await db.prepare(
    "INSERT INTO audit_logs (ts, user_id, action, entity, detail) VALUES (?,?,?,?,?)"
  ).run(Date.now(), userId, action, entity, json);
}

export async function recentAudit(limit = 100) {
  return db.prepare(
    `SELECT a.id, a.ts, a.action, a.entity, a.detail, u.username, u.name
     FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.ts DESC LIMIT ?`
  ).all(limit);
}

// ── Unified activity history (filterable, keyset-paginated) ────────────────────
// Categories group the ~40 raw action strings into a handful of human buckets so
// the UI can offer simple filters. `config` is everything that isn't bed/round/login.
const CATEGORY_ACTIONS: Record<string, string[]> = {
  bed:   ["bed_status_update", "bed_add", "bed_delete", "bed_rename", "beds_generate", "bed_master_edit", "ward_update"],
  round: ["round_submit"],
  login: ["login", "login_failed"],
  config: [
    "ward_create", "ward_edit", "ward_delete",
    "pre_create", "pre_edit", "pre_delete", "pre_shift",
    "pre_block_create", "pre_block_edit", "pre_block_delete", "pre_block_inactive",
    "building_block_create", "building_block_edit", "building_block_delete",
    "floor_create", "floor_edit", "floor_delete",
    "station_create", "station_edit", "station_delete", "station_assign_wards",
    "nurse_create", "nurse_edit", "nurse_delete",
    "nurse_access_create", "nurse_access_edit", "nurse_access_update", "nurse_access_delete",
    "payer_type_create", "payer_type_update", "payer_type_delete",
    "destination_create", "destination_update", "destination_delete",
  ],
  discharge: [
    // admission_update belongs here with the rest of the admission lifecycle. It
    // was missing, so every Patient Information correction — IP number, patient
    // name, date of admission, consultant, department, payer — was written to
    // audit_logs but then dropped out of the activity log the moment anyone
    // applied a category filter. The rows were always there; they just could not
    // be found. (The detail panel still renders nothing for them: enrichActivityRows'
    // old/new branch only knows the bed-status keys. Deliberately left for later —
    // the before/after values are all in audit_logs and queryable meanwhile.)
    "admission_create", "admission_update", "admission_close", "admission_move",
    "discharge_plan", "discharge_reschedule", "discharge_cancel_plan", "discharge_initiate",
    "discharge_cancel", "discharge_step_update", "discharge_complete", "bed_transfer",
    "bed_readmit", "discharge_force_complete",
  ],
};

export interface ActivityQuery {
  from?: number; to?: number;
  roles?: string[];
  userId?: number;
  categories?: string[];
  q?: string;
  page?: number;
  limit?: number;
}

export async function queryActivity(opts: ActivityQuery) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.from != null) { where.push("a.ts >= ?"); params.push(opts.from); }
  if (opts.to   != null) { where.push("a.ts <= ?"); params.push(opts.to); }
  if (opts.roles && opts.roles.length) { where.push("u.role = ANY(?)"); params.push(opts.roles); }
  if (opts.userId != null) { where.push("a.user_id = ?"); params.push(opts.userId); }

  if (opts.categories && opts.categories.length) {
    const actions = [...new Set(opts.categories.flatMap(c => CATEGORY_ACTIONS[c] ?? []))];
    if (actions.length) { where.push("a.action = ANY(?)"); params.push(actions); }
  }

  if (opts.q && opts.q.trim()) {
    const like = `%${opts.q.trim()}%`;
    where.push("(u.name ILIKE ? OR u.username ILIKE ? OR a.entity ILIKE ? OR a.action ILIKE ?)");
    params.push(like, like, like, like);
  }

  // Build the filter clause once; reuse for both the page query and the count.
  const filterSql = where.length ? "WHERE " + where.join(" AND ") : "";

  // Numbered (offset) pagination — newest first.
  const page   = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * limit;

  const rows = await db.prepare(
    `SELECT a.id, a.ts, a.action, a.entity, a.detail, a.user_id,
            u.username, u.name, u.role
     FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     ${filterSql}
     ORDER BY a.ts DESC, a.id DESC
     LIMIT ? OFFSET ?`
  ).all<{
    id: number; ts: number; action: string; entity: string | null; detail: string | null;
    user_id: number | null; username: string | null; name: string | null; role: string | null;
  }>(...params, limit, offset);

  const countRow = await db.prepare(
    `SELECT COUNT(*) AS n FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ${filterSql}`
  ).get<{ n: number }>(...params);
  const total = Number(countRow?.n ?? 0);

  return { rows: await enrichActivityRows(rows), page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
}

// Turn raw audit rows into fully human-readable rows: every id (bed, ward, nurse,
// station, floor, block, payer, PRE block) is resolved to a name, internal-only
// fields are dropped, and each row gets a `target` (what was acted on) plus an
// `info` list of {label,value} pairs for the detail panel. No raw ids leak to the UI.
async function enrichActivityRows(rows: Array<{
  id: number; ts: number; action: string; entity: string | null; detail: string | null;
  user_id: number | null; username: string | null; name: string | null; role: string | null;
}>) {
  const parsed = rows.map(r => ({
    ...r,
    d: (() => { try { return r.detail ? JSON.parse(r.detail) : {}; } catch { return {}; } })() as any,
  }));

  const numEntity = (r: typeof parsed[0]) => /^\d+$/.test(String(r.entity ?? "")) ? Number(r.entity) : null;

  // ── collect ids to resolve ──────────────────────────────────────────────────
  const bedIds = new Set<number>(), wardIds = new Set<number>(), userIds = new Set<number>();
  const stationIds = new Set<number>(), floorIds = new Set<number>(), blockIds = new Set<number>();
  const payerIds = new Set<number>(), preBlockIds = new Set<number>();
  const destinationIds = new Set<number>();
  const BED_ENTITY = new Set(["bed_status_update", "bed_master_edit", "bed_rename", "bed_delete"]);

  for (const r of parsed) {
    const d = r.d || {};
    if (BED_ENTITY.has(r.action) && numEntity(r) != null) bedIds.add(numEntity(r)!);
    if (typeof d.wardId === "number") wardIds.add(d.wardId);
    if (Array.isArray(d.wardIds)) for (const w of d.wardIds) if (typeof w === "number") wardIds.add(w);
    if (typeof d.nurseId === "number") userIds.add(d.nurseId);
    if (typeof d.userId === "number") userIds.add(d.userId);
    if (typeof d.stationId === "number") stationIds.add(d.stationId);
    if (typeof d.floorId === "number") floorIds.add(d.floorId);
    if (typeof d.blockId === "number") blockIds.add(d.blockId);
    if (r.action.startsWith("payer_type") && numEntity(r) != null) payerIds.add(numEntity(r)!);
    if (r.action.startsWith("destination") && numEntity(r) != null) destinationIds.add(numEntity(r)!);
    if (r.action === "round_submit") { const m = /^pb(\d+)$/.exec(String(r.entity ?? "")); if (m) preBlockIds.add(Number(m[1])); }
  }

  const loadMap = async (sql: string, ids: Set<number>) => {
    const map = new Map<number, string>();
    if (!ids.size) return map;
    const rs = await db.prepare(sql).all<{ id: number; label: string }>([...ids]);
    for (const x of rs) map.set(Number(x.id), x.label);
    return map;
  };
  const bedMap = new Map<number, { bed_name: string; ward_id: number }>();
  if (bedIds.size) {
    const bd = await db.prepare("SELECT id, bed_name, ward_id FROM bed_details WHERE id = ANY(?)")
      .all<{ id: number; bed_name: string; ward_id: number }>([...bedIds]);
    for (const b of bd) { bedMap.set(Number(b.id), { bed_name: b.bed_name, ward_id: Number(b.ward_id) }); wardIds.add(Number(b.ward_id)); }
  }
  const [wardMap, userMap, stationMap, floorMap, blockMap, payerMap, preBlockMap, destinationMap] = await Promise.all([
    loadMap("SELECT id, name AS label FROM wards WHERE id = ANY(?)", wardIds),
    loadMap("SELECT id, name AS label FROM users WHERE id = ANY(?)", userIds),
    loadMap("SELECT id, name AS label FROM nursing_stations WHERE id = ANY(?)", stationIds),
    loadMap("SELECT id, name AS label FROM floors WHERE id = ANY(?)", floorIds),
    loadMap("SELECT id, name AS label FROM building_blocks WHERE id = ANY(?)", blockIds),
    loadMap("SELECT id, name AS label FROM payer_types WHERE id = ANY(?)", payerIds),
    loadMap("SELECT id, name AS label FROM pre_blocks WHERE id = ANY(?)", preBlockIds),
    loadMap("SELECT id, name AS label FROM destinations WHERE id = ANY(?)", destinationIds),
  ]);

  const minToClock = (m: number) => {
    const h = Math.floor(m / 60) % 24, mm = m % 60, ap = h < 12 ? "AM" : "PM", hr = ((h + 11) % 12) + 1;
    return `${hr}:${String(mm).padStart(2, "0")} ${ap}`;
  };
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  // turn a detail key/value into a friendly {label,value}; return null to drop it
  const DROP = new Set(["id", "managerId", "userId", "roundKey", "wardId", "nurseId", "stationId", "floorId", "blockId"]);
  const field = (k: string, v: any): { label: string; value: string } | null => {
    if (v == null) return null;
    switch (k) {
      case "accessType":  return { label: "Access", value: v === "FULL" ? "All beds" : "Selected beds" };
      case "status":      return { label: "Status", value: cap(String(v)) };
      case "name":        return { label: "Name", value: String(v) };
      case "username":    return { label: "Username", value: "@" + v };
      case "totalBeds":   return { label: "Beds", value: String(v) };
      case "wardCount":   return { label: "Wards", value: String(v) };
      case "reason":      return { label: "Reason", value: String(v) };
      case "bedType":     return { label: "Bed type", value: String(v) };
      case "operational": return { label: "Operational", value: v ? "Yes" : "No" };
      case "label":       return { label: "Label", value: String(v) };
      case "from":        return { label: "From", value: String(v) };
      case "to":          return { label: "To", value: String(v) };
      case "count":       return { label: "Count", value: String(v) };
      case "wardIds":     return { label: "Wards", value: (Array.isArray(v) && v.length) ? v.map((w: number) => wardMap.get(w) ?? `#${w}`).join(", ") : "None" };
      default:            return null;
    }
  };

  return parsed.map(r => {
    const d = r.d || {};
    const bed = numEntity(r) != null ? bedMap.get(numEntity(r)!) : undefined;
    const wardId = bed?.ward_id ?? (typeof d.wardId === "number" ? d.wardId : null);
    const bedName = bed?.bed_name ?? null;
    const wardName = wardId != null ? (wardMap.get(Number(wardId)) ?? null) : null;
    const nurseName   = typeof d.nurseId === "number" ? userMap.get(d.nurseId) ?? null : null;
    const userName    = typeof d.userId === "number" ? userMap.get(d.userId) ?? null : null;
    const stationName = typeof d.stationId === "number" ? stationMap.get(d.stationId) ?? null : null;
    const floorName   = typeof d.floorId === "number" ? floorMap.get(d.floorId) ?? null : null;
    const blockName   = typeof d.blockId === "number" ? blockMap.get(d.blockId) ?? null : null;

    // friendly target (what was acted on) — never a raw id
    let target: string | null = bedName;
    const a = r.action;
    if (!target) {
      if (a === "round_submit") { const m = /^pb(\d+)$/.exec(String(r.entity ?? "")); target = m ? (preBlockMap.get(Number(m[1])) ?? null) : null; }
      else if (a.startsWith("nurse_access")) target = nurseName;
      else if (a === "nurse_create" || a === "nurse_edit" || a === "nurse_delete" || a === "pre_create" || a === "pre_edit" || a === "pre_delete") target = userName ?? d.name ?? null;
      else if (a.startsWith("payer_type")) target = d.name ?? (numEntity(r) != null ? payerMap.get(numEntity(r)!) ?? null : null);
      else if (a.startsWith("destination")) target = d.name ?? (numEntity(r) != null ? destinationMap.get(numEntity(r)!) ?? null : null);
      else if (a.startsWith("ward")) target = wardName ?? d.name ?? null;
      else if (a.startsWith("station")) target = stationName ?? (numEntity(r) == null ? r.entity : null);
      else if (a.startsWith("floor")) target = floorName ?? (numEntity(r) == null ? r.entity : null);
      else if (a.startsWith("building_block")) target = blockName ?? (numEntity(r) == null ? r.entity : null);
      else if (a.startsWith("pre_block")) target = (numEntity(r) == null ? r.entity : null);
      else if (a === "login" || a === "login_failed") target = null;
      else target = (numEntity(r) == null && r.entity !== "user") ? r.entity : null;
    }

    // info rows for the detail panel — fully resolved, no ids
    const info: Array<{ label: string; value: string }> = [];
    if (d.old && d.new) {
      if (bedName) info.push({ label: "Bed", value: bedName });
      if (wardName) info.push({ label: "Ward", value: wardName });
      for (const [lbl, key] of [["Physical", "physical"], ["Reservation", "reservation"], ["Payer", "payer"], ["Destination", "destination"], ["Note", "note"]] as const) {
        const ov = d.old[key], nv = d.new[key];
        if (ov != null || nv != null) info.push({ label: lbl, value: `${ov ?? "—"} → ${nv ?? "—"}` });
      }
    } else {
      if (nurseName)   info.push({ label: "Nurse", value: nurseName });
      if (userName)    info.push({ label: "User", value: userName });
      if (wardName && !a.startsWith("ward")) info.push({ label: "Ward", value: wardName });
      if (stationName) info.push({ label: "Station", value: stationName });
      if (floorName)   info.push({ label: "Floor", value: floorName });
      if (blockName)   info.push({ label: "Block", value: blockName });
      if (a === "round_submit" && typeof d.roundKey === "string") {
        const p = d.roundKey.split("|");
        if (p[1]) info.push({ label: "Shift", value: cap(p[1]) });
        if (p[3] != null && !isNaN(Number(p[3]))) info.push({ label: "Round", value: minToClock(Number(p[3])) });
      }
      for (const [k, v] of Object.entries(d)) {
        if (DROP.has(k)) continue;
        const f = field(k, v);
        if (f) info.push(f);
      }
    }

    const change = (d.old && d.new)
      ? { from: { physical: d.old.physical, reservation: d.old.reservation },
          to:   { physical: d.new.physical, reservation: d.new.reservation } }
      : null;

    // A bed leaving OCCUPIED+RESERVED tells a complete story on its own: the
    // patient either came back to this bed, or didn't — surface that in plain
    // language instead of making the reader infer it from raw status codes.
    let note: string | null = null;
    if (change && d.old.physical === "OCCUPIED" && d.old.reservation === "RESERVED") {
      const dest = d.new.destination || d.old.destination;
      if (change.to.physical === "OCCUPIED" && change.to.reservation === "NONE") {
        note = dest ? `Patient returned from ${dest}` : "Patient returned";
      } else if (change.to.physical === "VACANT") {
        note = dest ? `Patient did not return from ${dest}` : "Patient did not return";
      }
    }

    return {
      id: r.id, ts: Number(r.ts), action: r.action,
      target, bedName, wardName, info, change, note,
      userId: r.user_id, username: r.username, name: r.name, role: r.role,
    };
  });
}
