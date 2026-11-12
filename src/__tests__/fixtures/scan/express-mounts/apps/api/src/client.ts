// Not a server: an HTTP client's get is not a route.
import { api } from "./api-client.js";

export const load = () => api.get("/users");
