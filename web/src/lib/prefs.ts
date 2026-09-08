/** 每台设备的 UI 偏好(不是事实源):localStorage 不可用时静默(Node ≥25 的实验性全局为 undefined) */
export function readPref(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function writePref(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // 忽略:偏好丢失只影响是否再次提示
  }
}
