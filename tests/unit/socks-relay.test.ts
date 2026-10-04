import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ownerOfConnection, sameUserClient, Socks5Relay } from "../../src/main/proxy/socks-relay";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
}

/** Serveur cible : renvoie ce qu'il reçoit, préfixé. */
async function echoServer(): Promise<number> {
  const server = net.createServer((socket) => socket.on("data", (data: Buffer) => socket.write(Buffer.concat([Buffer.from("echo:"), data]))));
  cleanups.push(() => server.close());
  return listen(server);
}

/** Proxy SOCKS5 amont minimal qui exige utilisateur et mot de passe (RFC 1929). */
async function upstreamProxy(user: string, pass: string): Promise<{ port: number; connections: string[] }> {
  const connections: string[] = [];
  const server = net.createServer((socket) => {
    let stage = 0;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 2 + (buffer[1] ?? 0)) {
        const methods = buffer.subarray(2, 2 + (buffer[1] ?? 0));
        buffer = buffer.subarray(2 + (buffer[1] ?? 0));
        socket.write(Buffer.from([5, methods.includes(2) ? 2 : 0xff]));
        stage = 1;
      }
      if (stage === 1 && buffer.length >= 2) {
        const ulen = buffer[1] ?? 0;
        if (buffer.length < 3 + ulen) return;
        const plen = buffer[2 + ulen] ?? 0;
        if (buffer.length < 3 + ulen + plen) return;
        const okUser = buffer.subarray(2, 2 + ulen).toString() === user;
        const okPass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString() === pass;
        buffer = buffer.subarray(3 + ulen + plen);
        socket.write(Buffer.from([1, okUser && okPass ? 0 : 1]));
        if (!(okUser && okPass)) return void socket.end();
        stage = 2;
      }
      if (stage === 2 && buffer.length >= 10) {
        // CONNECT 127.0.0.1:<port> (IPv4)
        const port = buffer.readUInt16BE(8);
        buffer = buffer.subarray(10);
        connections.push(`127.0.0.1:${port}`);
        const target = net.connect({ host: "127.0.0.1", port }, () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          socket.removeAllListeners("data");
          socket.pipe(target);
          target.pipe(socket);
          if (buffer.length > 0) target.write(buffer);
        });
        stage = 3;
      }
    });
  });
  cleanups.push(() => server.close());
  return { port: await listen(server), connections };
}

/** Client SOCKS5 sans authentification, comme Chromium. */
function socksRequest(relayPort: number, targetPort: number, payload: string): Promise<{ reply: number; data: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: relayPort });
    let stage = 0;
    let buffer = Buffer.alloc(0);
    let reply = -1;
    socket.on("connect", () => socket.write(Buffer.from([5, 1, 0])));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 2) {
        buffer = buffer.subarray(2);
        const request = Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 0]);
        request.writeUInt16BE(targetPort, 8);
        socket.write(request);
        stage = 1;
      }
      if (stage === 1 && buffer.length >= 10) {
        reply = buffer[1] ?? -1;
        buffer = buffer.subarray(10);
        stage = 2;
        if (reply === 0) socket.write(payload);
        else resolve({ reply, data: "" });
      }
      if (stage === 2 && buffer.length > 0) {
        resolve({ reply, data: buffer.toString() });
        socket.end();
      }
    });
    socket.on("close", () => resolve({ reply, data: buffer.toString() }));
    socket.on("error", reject);
  });
}

describe("relais SOCKS5 local (F9)", () => {
  it("relaie une connexion en s'authentifiant auprès du proxy amont", async () => {
    const target = await echoServer();
    const upstream = await upstreamProxy("alice", "s3cr3t");
    const relay = new Socks5Relay({ upstream: { host: "127.0.0.1", port: upstream.port, username: "alice", password: "s3cr3t" } });
    cleanups.push(() => relay.stop());
    const port = await relay.start();
    const result = await socksRequest(port, target, "bonjour");
    expect(result).toEqual({ reply: 0, data: "echo:bonjour" });
    expect(upstream.connections).toEqual([`127.0.0.1:${target}`]);
  });

  it("refuse proprement et le signale quand le proxy amont rejette les identifiants", async () => {
    const target = await echoServer();
    const upstream = await upstreamProxy("alice", "s3cr3t");
    const relay = new Socks5Relay({ upstream: { host: "127.0.0.1", port: upstream.port, username: "alice", password: "faux" } });
    cleanups.push(() => relay.stop());
    let failures = 0;
    relay.on("auth-failed", () => failures++);
    const port = await relay.start();
    const result = await socksRequest(port, target, "bonjour");
    expect(result.reply).toBe(2);
    expect(failures).toBe(1);
  });

  it("refuse un client qui n'est pas autorisé, sans lui répondre", async () => {
    const target = await echoServer();
    const upstream = await upstreamProxy("alice", "s3cr3t");
    const relay = new Socks5Relay({ upstream: { host: "127.0.0.1", port: upstream.port, username: "alice", password: "s3cr3t" }, isAllowedClient: async () => false });
    cleanups.push(() => relay.stop());
    const port = await relay.start();
    expect((await socksRequest(port, target, "x")).reply).toBe(-1);
    expect(upstream.connections).toEqual([]);
  });

  it("n'écoute que sur l'interface locale", async () => {
    const relay = new Socks5Relay({ upstream: { host: "127.0.0.1", port: 1, username: "a", password: "b" } });
    cleanups.push(() => relay.stop());
    await relay.start();
    expect(((relay as unknown as { server: net.Server }).server.address() as net.AddressInfo).address).toBe("127.0.0.1");
  });

  it("reconnaît un client du même utilisateur dans /proc/net/tcp", async () => {
    const server = net.createServer();
    cleanups.push(() => server.close());
    const port = await listen(server);
    const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
    const client = net.connect({ host: "127.0.0.1", port });
    cleanups.push(() => client.destroy());
    expect(await sameUserClient(await accepted)).toBe(true);
  });

  it("lit l'uid d'une connexion dans un tableau /proc/net/tcp", () => {
    const table = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:9C40 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 20 4 30 10 -1",
      "   1: 0100007F:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1001        0 123457 1 0000000000000000 20 4 30 10 -1"
    ].join("\n");
    expect(ownerOfConnection(table, "9C40", "1F90")).toBe(1000);
    expect(ownerOfConnection(table, "1F90", "9C40")).toBe(1001);
    expect(ownerOfConnection(table, "AAAA", "1F90")).toBeNull();
  });
});
