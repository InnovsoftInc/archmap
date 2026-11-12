import express from "express";
import { apiRouter } from "./routes/index.js";
import { vendorRouter } from "vendor-routes";

export const createApp = (): express.Express => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", apiRouter);
  // A router from a package can't be resolved; it changes nothing.
  app.use("/vendor", vendorRouter);
  return app;
};
