import { Router } from "express";

// Never mounted: keeps its own path.
export const orphanRouter = Router();
orphanRouter.options("/orphan", (_req, res) => res.send({}));
