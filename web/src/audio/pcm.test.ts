import { describe, expect, it } from 'vitest'
import { concatFrames, downmix, floatToInt16, resampleLinear, rms, toPcm16k } from './pcm'

describe('语音 PCM 链路(M3 T3)', () => {
  it('线性重采样:48 kHz → 16 kHz 长度按比例缩减,值在原样本之间插值', () => {
    const input = new Float32Array(4800).map((_, i) => i / 4800)
    const out = resampleLinear(input, 48_000, 16_000)
    expect(out.length).toBe(1600)
    expect(out[0]).toBe(0)
    expect(out[800]).toBeCloseTo(0.5, 3)
    expect(resampleLinear(input, 16_000, 16_000)).toBe(input)
    expect(resampleLinear(new Float32Array(0), 48_000, 16_000).length).toBe(0)
    expect(() => resampleLinear(input, 0, 16_000)).toThrow()
  })

  it('i16 量化:四舍五入并钳位到 [-32768, 32767]', () => {
    const out = floatToInt16(new Float32Array([0, 1, -1, 2, -2, 0.5, -0.5, 0.00001]))
    expect(Array.from(out)).toEqual([0, 32767, -32768, 32767, -32768, 16384, -16384, 0])
  })

  it('多声道取平均;拼接与电平', () => {
    const mono = downmix([new Float32Array([1, 0, -1]), new Float32Array([0, 0, 1])])
    expect(Array.from(mono)).toEqual([0.5, 0, 0])
    expect(Array.from(concatFrames([new Float32Array([1, 2]), new Float32Array([3])]))).toEqual([1, 2, 3])
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5, 6)
    expect(rms(new Float32Array(0))).toBe(0)
  })

  it('toPcm16k:任意采样率单声道 → 16 kHz i16', () => {
    const out = toPcm16k(new Float32Array(44_100).fill(0.25), 44_100)
    expect(out.length).toBe(16_000)
    expect(out[10]).toBe(Math.round(0.25 * 32767))
  })
})
