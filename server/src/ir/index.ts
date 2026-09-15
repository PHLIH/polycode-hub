export * from './types.ts'
export * from './errors.ts'
export * from './codec.ts'

export const PROTOCOLS = ['anthropic-messages', 'openai-completions', 'openai-responses'] as const

export function validProtocol(p: string): boolean {
  return (PROTOCOLS as readonly string[]).includes(p)
}
