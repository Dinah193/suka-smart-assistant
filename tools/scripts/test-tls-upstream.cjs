"use strict";

const tls = require("node:tls");

const host = process.env.TARGET_HOST || "ac-icavjqq-shard-00-00.jfmksyd.mongodb.net";
const port = Number(process.env.TARGET_PORT || 27017);

const socket = tls.connect({ host, port, servername: host }, () => {
  console.log(JSON.stringify({ ok: true, authorized: socket.authorized, authorizationError: socket.authorizationError || null }));
  socket.end();
});

socket.setTimeout(10000, () => {
  console.error(JSON.stringify({ ok: false, error: "timeout" }));
  socket.destroy();
  process.exit(1);
});

socket.on("error", (err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  process.exit(1);
});
