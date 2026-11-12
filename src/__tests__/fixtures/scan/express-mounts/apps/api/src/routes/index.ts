import express, { Router } from "express";
import { healthcheckRouter } from "./healthcheck.js";
import { permitsRouter } from "./permits.js";
import admin from "./admin.js";

export const apiRouter: Router = Router();

apiRouter.use(express.json({ limit: "10mb" }));
apiRouter.use("/healthcheck", healthcheckRouter);
apiRouter.use("/permits", permitsRouter);
apiRouter.use("/admin", admin);
apiRouter.get("/version", (_req, res) => res.send("1"));
