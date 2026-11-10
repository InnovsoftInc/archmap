import Fastify from "fastify";

const fastify = Fastify();
fastify.get("/ping", async () => "pong");
fastify.post("/accounts", async () => ({}));
