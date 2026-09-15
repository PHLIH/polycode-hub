import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'

export function startOneShot(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      resolve({ server, base })
    })
  })
}
