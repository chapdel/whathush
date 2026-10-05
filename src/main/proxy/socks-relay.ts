// Relais SOCKS5 local. Chromium ne sait pas s'authentifier auprès d'un proxy
// SOCKS5 : il parle à ce relais sans authentification, sur 127.0.0.1 et un port
// aléatoire ; le relais s'authentifie (RFC 1929) auprès du proxy amont et transmet.
// Seuls les clients du même utilisateur système sont acceptés (un processus du même
// utilisateur pourrait de toute façon lire la mémoire de l'application). Le relais
// s'arrête avec l'application. Module net de Node, sans Electron : testable seul.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";

export interface Upstream {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface RelayOptions {
  upstream: Upstream;
  /** Vérifie le client ; par défaut, même utilisateur système (Linux). */
  isAllowedClient?: (socket: net.Socket) => Promise<boolean>;
  timeoutMs?: number;
}

const VERSION = 0x05;
const REPLY = { succeeded: 0x00, failure: 0x01, notAllowed: 0x02, hostUnreachable: 0x04, refused: 0x05, commandNotSupported: 0x07 } as const;

/** Lecture exacte d'octets sur un socket, pour les échanges de négociation. */
class Reader {
  private buffer = Buffer.alloc(0);
  private waiting: { size: number; resolve: (data: Buffer) => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;

  constructor(private readonly socket: net.Socket) {
    socket.on("data", this.onData);
    socket.once("close", () => this.fail(new Error("connexion fermée")));
    socket.once("error", (error) => this.fail(error));
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.flush();
  };

  private fail(error: Error): void {
    this.failure = error;
    if (this.waiting) {
      this.waiting.reject(error);
      this.waiting = null;
    }
  }

  private flush(): void {
    if (!this.waiting || this.buffer.length < this.waiting.size) return;
    const { size, resolve } = this.waiting;
    this.waiting = null;
    const data = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    resolve(Buffer.from(data));
  }

  read(size: number): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { size, resolve, reject };
      this.flush();
    });
  }

  /**
   * Fin de la négociation : le flux est mis en pause (pipe() le relancera, rien n'est
   * perdu entre-temps) et ce qui a déjà été lu en trop est rendu.
   */
  release(): Buffer {
    this.socket.off("data", this.onData);
    this.socket.pause();
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return rest;
  }
}

/** Adresse de destination d'une requête SOCKS5 (ATYP + adresse + port), telle quelle. */
async function readAddress(reader: Reader): Promise<Buffer> {
  const [atyp] = await reader.read(1);
  if (atyp === 0x01) return Buffer.concat([Buffer.from([atyp]), await reader.read(4 + 2)]);
  if (atyp === 0x04) return Buffer.concat([Buffer.from([atyp]), await reader.read(16 + 2)]);
  if (atyp === 0x03) {
    const length = await reader.read(1);
    return Buffer.concat([Buffer.from([atyp]), length, await reader.read((length[0] ?? 0) + 2)]);
  }
  throw new Error(`type d'adresse inconnu : ${atyp}`);
}

function reply(code: number): Buffer {
  return Buffer.from([VERSION, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

export class Socks5Relay extends EventEmitter<{ "auth-failed": []; error: [Error] }> {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private upstream: Upstream;
  private readonly timeoutMs: number;

  constructor(private readonly options: RelayOptions) {
    super();
    this.upstream = options.upstream;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** Nouveau proxy amont : les tunnels ouverts vers l'ancien sont coupés. */
  setUpstream(upstream: Upstream): void {
    this.upstream = upstream;
    this.dropConnections();
  }

  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  /** Démarre sur 127.0.0.1, port choisi par le système ; renvoie le port. */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => void this.handle(socket));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        server.on("error", (error) => this.emit("error", error));
        this.server = server;
        resolve((server.address() as net.AddressInfo).port);
      });
    });
  }

  stop(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server?.close();
    this.server = null;
  }

  private track(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  private async handle(client: net.Socket): Promise<void> {
    this.track(client);
    client.setTimeout(this.timeoutMs, () => client.destroy());
    client.on("error", () => client.destroy());
    const allowed = await (this.options.isAllowedClient ?? sameUserClient)(client).catch(() => false);
    if (!allowed) {
      client.destroy();
      return;
    }
    const reader = new Reader(client);
    let upstream: net.Socket | null = null;
    try {
      // 1. Négociation côté Chromium : sans authentification.
      const [version, methodCount = 0] = await reader.read(2);
      const methods = await reader.read(methodCount);
      if (version !== VERSION || !methods.includes(0x00)) {
        client.end(Buffer.from([VERSION, 0xff]));
        return;
      }
      client.write(Buffer.from([VERSION, 0x00]));

      // 2. Requête : seul CONNECT est relayé.
      const [requestVersion, command] = await reader.read(3);
      const address = await readAddress(reader);
      if (requestVersion !== VERSION || command !== 0x01) {
        client.end(reply(REPLY.commandNotSupported));
        return;
      }

      // 3. Proxy amont, avec identifiants ; sa réponse est transmise à Chromium telle quelle.
      const connected = await this.connectUpstream(address);
      upstream = connected.socket;
      const rest = reader.release();
      client.setTimeout(0);
      upstream.setTimeout(0);
      client.write(connected.reply);
      if (rest.length > 0) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      upstream.on("error", () => client.destroy());
      upstream.once("close", () => client.destroy());
      client.once("close", () => upstream?.destroy());
    } catch (error) {
      const code = (error as { socksReply?: number }).socksReply ?? REPLY.failure;
      if (!client.destroyed) client.end(reply(code));
      upstream?.destroy();
    }
  }

  private async connectUpstream(address: Buffer): Promise<{ socket: net.Socket; reply: Buffer }> {
    const { host, port, username, password } = this.upstream;
    const socket = net.connect({ host, port });
    this.track(socket);
    socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error("délai dépassé")));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const reader = new Reader(socket);
    socket.write(Buffer.from([VERSION, 0x01, 0x02]));
    const [version, method] = await reader.read(2);
    if (version !== VERSION || method !== 0x02) throw Object.assign(new Error("méthode refusée par le proxy"), { socksReply: REPLY.notAllowed });

    const user = Buffer.from(username, "utf8");
    const pass = Buffer.from(password, "utf8");
    if (user.length > 255 || pass.length > 255) throw Object.assign(new Error("identifiants trop longs"), { socksReply: REPLY.notAllowed });
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
    const [, status] = await reader.read(2);
    if (status !== 0x00) {
      this.emit("auth-failed");
      throw Object.assign(new Error("identifiants refusés"), { socksReply: REPLY.notAllowed });
    }

    socket.write(Buffer.concat([Buffer.from([VERSION, 0x01, 0x00]), address]));
    const head = await reader.read(3);
    const bound = await readAddress(reader);
    if (head[1] !== REPLY.succeeded) {
      socket.destroy();
      throw Object.assign(new Error(`connexion refusée (${head[1]})`), { socksReply: head[1] });
    }
    // Octets déjà reçus après la réponse : remis dans le flux, en pause jusqu'au pipe().
    const rest = reader.release();
    if (rest.length > 0) socket.unshift(rest);
    return { socket, reply: Buffer.concat([head, bound]) };
  }
}

/**
 * Le client appartient-il au même utilisateur ? On cherche, dans /proc/net/tcp*, la
 * connexion dont le port local est le port distant vu par le relais, et son uid.
 */
export async function sameUserClient(socket: net.Socket): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined || !socket.remotePort || !socket.localPort) return false;
  const target = socket.remotePort.toString(16).toUpperCase().padStart(4, "0");
  const peer = socket.localPort.toString(16).toUpperCase().padStart(4, "0");
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let content: string;
    try {
      content = await fs.promises.readFile(file, "utf8");
    } catch {
      continue;
    }
    const owner = ownerOfConnection(content, target, peer);
    if (owner !== null) return owner === uid;
  }
  return false;
}

/** uid du socket local:<localPort> → distant:<remotePort> dans un tableau /proc/net/tcp. */
export function ownerOfConnection(table: string, localPortHex: string, remotePortHex: string): number | null {
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const local = fields[1]?.split(":")[1];
    const remote = fields[2]?.split(":")[1];
    if (local === localPortHex && remote === remotePortHex) return Number(fields[7]);
  }
  return null;
}
