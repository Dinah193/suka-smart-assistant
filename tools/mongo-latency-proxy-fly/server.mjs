import net from "node:net";
import tls from "node:tls";

const LISTEN_HOST = "0.0.0.0";
const LISTEN_PORT = Number(process.env.PORT || 8080);

const UPSTREAM_HOST = process.env.REAL_MONGO_HOST;
const UPSTREAM_PORT = Number(process.env.REAL_MONGO_PORT || 27017);
const UPSTREAM_TLS = String(process.env.UPSTREAM_TLS || "true").toLowerCase() !== "false";

const UP_DELAY_MS = Number(process.env.UP_DELAY_MS || 450);
const DOWN_DELAY_MS = Number(process.env.DOWN_DELAY_MS || 450);

if (!UPSTREAM_HOST) {
  console.error("REAL_MONGO_HOST is required");
  process.exit(1);
}

const server = net.createServer((client) => {
  const upstream = UPSTREAM_TLS
    ? tls.connect({
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        servername: UPSTREAM_HOST,
      })
    : net.createConnection({ host: UPSTREAM_HOST, port: UPSTREAM_PORT });

  if (UPSTREAM_TLS) {
    upstream.on("secureConnect", () => {
      console.log("upstream secureConnect", {
        authorized: upstream.authorized,
        authorizationError: upstream.authorizationError || null,
      });
    });
  }

  client.on("data", (chunk) => setTimeout(() => upstream.write(chunk), UP_DELAY_MS));
  upstream.on("data", (chunk) => setTimeout(() => client.write(chunk), DOWN_DELAY_MS));

  const closeBoth = () => {
    try { client.destroy(); } catch {}
    try { upstream.destroy(); } catch {}
  };

  client.on("error", (err) => {
    console.error("client socket error", String(err?.message || err));
    closeBoth();
  });
  upstream.on("error", (err) => {
    console.error("upstream socket error", String(err?.message || err));
    closeBoth();
  });
  client.on("close", closeBoth);
  upstream.on("close", closeBoth);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`proxy listening ${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`upstream ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  console.log(`upstream tls=${UPSTREAM_TLS}`);
  console.log(`delay up=${UP_DELAY_MS}ms down=${DOWN_DELAY_MS}ms`);
});
