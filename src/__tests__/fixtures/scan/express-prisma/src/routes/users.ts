import { Router } from "express";

export const router = Router();
router.get("/users", list);
router.post("/users", create);
router.delete('/users/:id', remove);
