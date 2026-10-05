// Proxys de test : HTTP avec authentification Basic, SOCKS5 avec identifiants.
import http from "node:http";
import net from "node:net";

export interface TestProxy {
  port: number;
  /** Requêtes acceptées (URL absolue pour HTTP, hôte:port pour CONNECT/SOCKS5). */
  requests: string[];
  refused: number;
  close(): void;
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
}

export async function startHttpProxy(user: string, pass: string): Promise<TestProxy> {
  const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  const proxy: TestProxy = { port: 0, requests: [], refused: 0, close: () => undefined };
  const server = http.createServer((request, response) => {
    if (request.headers["proxy-authorization"] !== expected) {
      proxy.refused += 1;
      response.writeHead(407, { "proxy-authenticate": 'Basic realm="whathush-test"' });
      response.end();
      return;
    }
    proxy.requests.push(request.url ?? "");
    const target = new URL(request.url ?? "");
    const { "proxy-authorization": _auth, "proxy-connection": _connection, ...headers } = request.headers;
    const upstream = http.request({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: request.method, headers: { ...headers, host: target.host } }, (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    });
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  server.on("connect", (request, socket, head) => {
    if (request.headers["proxy-authorization"] !== expected) {
      proxy.refused += 1;
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="whathush-test"\r\n\r\n');
      return;
    }
    proxy.requests.push(request.url ?? "");
    const [host = "", port = "443"] = (request.url ?? "").split(":");
    const upstream = net.connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
  });
  proxy.port = await listen(server);
  proxy.close = () => {
    server.closeAllConnections();
    server.close();
  };
  return proxy;
}

/** SOCKS5 amont exigeant utilisateur et mot de passe (RFC 1929), CONNECT IPv4 et nom de domaine. */
export async function startSocksProxy(user: string, pass: string): Promise<TestProxy> {
  const proxy: TestProxy = { port: 0, requests: [], refused: 0, close: () => undefined };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let stage = 0;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      if (stage === 3) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0) {
        if (buffer.length < 2 || buffer.length < 2 + (buffer[1] ?? 0)) return;
        const methods = buffer.subarray(2, 2 + (buffer[1] ?? 0));
        buffer = buffer.subarray(2 + (buffer[1] ?? 0));
        socket.write(Buffer.from([5, methods.includes(2) ? 2 : 0xff]));
        stage = 1;
      }
      if (stage === 1) {
        const ulen = buffer[1] ?? 0;
        if (buffer.length < 3 + ulen || buffer.length < 3 + ulen + (buffer[2 + ulen] ?? 0)) return;
        const plen = buffer[2 + ulen] ?? 0;
        const ok = buffer.subarray(2, 2 + ulen).toString() === user && buffer.subarray(3 + ulen, 3 + ulen + plen).toString() === pass;
        buffer = buffer.subarray(3 + ulen + plen);
        socket.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) {
          proxy.refused += 1;
          socket.end();
          return;
        }
        stage = 2;
      }
      if (stage === 2) {
        if (buffer.length < 5) return;
        const atyp = buffer[3];
        let host = "";
        let offset = 4;
        if (atyp === 1) {
          if (buffer.length < 10) return;
          host = [...buffer.subarray(4, 8)].join(".");
          offset = 8;
        } else if (atyp === 3) {
          const length = buffer[4] ?? 0;
          if (buffer.length < 5 + length + 2) return;
          host = buffer.subarray(5, 5 + length).toString();
          offset = 5 + length;
        } else {
          socket.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const port = buffer.readUInt16BE(offset);
        const rest = buffer.subarray(offset + 2);
        proxy.requests.push(`${host}:${port}`);
        stage = 3;
        const target = net.connect(port, host, () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (rest.length > 0) target.write(rest);
          socket.pipe(target);
          target.pipe(socket);
        });
        target.on("error", () => socket.destroy());
      }
    });
  });
  proxy.port = await listen(server);
  proxy.close = () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  return proxy;
}
