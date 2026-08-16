import { Router } from "express";
import { z } from "zod";
import { authRequired } from "../middleware/auth.js";
import { asyncH } from "../middleware/error.js";
import { saveSubscription } from "../services/pushService.js";
import { pushEnabled, env } from "../config/env.js";
import { COO_REMINDERS, ALLOW_FUTURE_ADMISSION_DATE, todayStr } from "../config/domain.js";
import { listDepartments, listDoctors, listDoctorsWithDepartments } from "../services/doctorDeptService.js";
import { listGroupsWithDetails } from "../services/consultantGroupService.js";

const router = Router();

router.get("/meta", (_req, res) => {
  res.json({ cooReminders: COO_REMINDERS,
    pushEnabled, vapidPublic: env.VAPID_PUBLIC || null,
    // Drives the date-of-admission picker's max bound. Shipped from here rather
    // than duplicated client-side so the picker and the server validator are
    // always reading the same constant — the API rejects a future date whatever
    // the client allows, and this keeps the UI from offering one it will refuse.
    allowFutureAdmissionDate: ALLOW_FUTURE_ADMISSION_DATE,
    // Server's "today" in IST. The browser's own clock is the user's timezone and
    // may be wrong or deliberately shifted; the boundary the server enforces is
    // the only one that matters, so the picker uses this rather than a local Date.
    todayIST: todayStr() });
});

router.get("/departments", authRequired, asyncH(async (_req, res) => {
  res.json({ departments: await listDepartments(true) });
}));

router.get("/doctors", authRequired, asyncH(async (req, res) => {
  const deptId = req.query.department_id ? Number(req.query.department_id) : undefined;
  if (deptId) {
    res.json({ doctors: await listDoctors(deptId, true) });
  } else {
    res.json({ doctors: await listDoctorsWithDepartments(true) });
  }
}));

router.get("/consultant-groups", authRequired, asyncH(async (_req, res) => {
  res.json({ groups: await listGroupsWithDetails(true) });
}));

router.post("/push/subscribe", authRequired, asyncH(async (req, res) => {
  const { subscription } = z.object({ subscription: z.object({ endpoint: z.string() }).passthrough() }).parse(req.body);
  await saveSubscription(req.user!.id, subscription as { endpoint: string });
  res.json({ ok: true });
}));

export default router;
