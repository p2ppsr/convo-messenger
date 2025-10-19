// utils/curvePointSingleton.ts
import { CurvePoint } from 'curvepoint'
import type { WalletInterface } from '@bsv/sdk'

// console.log("curvePointSingleton.ts loaded");

let curvePoint: CurvePoint | null = null

export function getCurvePoint(wallet: WalletInterface): CurvePoint {
  if (!curvePoint) {
    // console.log("[Singleton] Creating new CurvePoint");
    curvePoint = new CurvePoint(wallet);
  } else {
    // console.log("[Singleton] Reusing CurvePoint");
  }
  return curvePoint;
}
