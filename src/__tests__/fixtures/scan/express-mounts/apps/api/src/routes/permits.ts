import { Router } from "express";

export const permitsRouter: Router = Router();

permitsRouter.post("/", (_req, res) => res.send({}));
permitsRouter.get("/:id", (_req, res) => res.send({}));
