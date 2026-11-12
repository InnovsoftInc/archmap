import { Router } from "express";

const adminRoutes = Router();
const reports = Router();

reports.get("/daily", (_req, res) => res.send({}));
adminRoutes.use("/reports", reports);
adminRoutes.delete("/cache", (_req, res) => res.send({}));

export default adminRoutes;
