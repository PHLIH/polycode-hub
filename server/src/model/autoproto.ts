// 协议自动识别事实缓存（对齐 Go internal/model/autoproto.go）。
// Provider 协议留空时逐个试候选协议，首个成功者缓存于此，后续请求直达不再试错。
// 进程内缓存的理由：重启后重探成本仅一次请求（扫描会把结果持久化到模型目录）。

import type { Protocol } from '../ir/index.ts'

const autoProto = new Map<string, Protocol>()

const key = (providerID: string, modelID: string) => `${providerID}\x00${modelID}`

export function rememberProtocol(providerID: string, modelID: string, p: Protocol): void {
  if (!providerID || !modelID || !p) return
  autoProto.set(key(providerID, modelID), p)
}

export function autoProtocol(providerID: string, modelID: string): Protocol | undefined {
  return autoProto.get(key(providerID, modelID))
}

// 丢弃探测结果：modelID 为空 = 清整 Provider（协议可能因上游调整而变，扫描/纠偏后重探）。
export function forgetProtocol(providerID: string, modelID: string): void {
  if (!modelID) {
    const prefix = `${providerID}\x00`
    for (const k of autoProto.keys()) {
      if (k.startsWith(prefix)) autoProto.delete(k)
    }
  } else {
    autoProto.delete(key(providerID, modelID))
  }
}
