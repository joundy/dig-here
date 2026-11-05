import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type StubCall = { method: string; params: any };
type Answer = (call: StubCall) => unknown | Promise<unknown>;

/** A stand-in for the RPC node, so tests can count reads and sends without a coin or a request leaving this machine. */
export async function startStubRpc(answer: Answer): Promise<{ url: string; calls: StubCall[]; server: Server }> {
  const calls: StubCall[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const call = { method: body.method, params: body.params };
    calls.push(call);
    let reply: object;
    try {
      reply = { jsonrpc: '2.0', id: body.id, result: await answer(call) };
    } catch (e) {
      reply = { jsonrpc: '2.0', id: body.id, error: { name: 'HANDLER_ERROR', cause: { name: (e as Error).message }, message: (e as Error).message } };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, server };
}

export const viewResult = (value: unknown) => ({ result: [...Buffer.from(JSON.stringify(value))] });
export const methodOf = (call: StubCall) => call.params?.method_name ?? call.params?.request_type ?? call.method;
export const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
