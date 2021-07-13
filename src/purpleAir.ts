import { logInfo } from "./newRelic";

const STALE_THRESHOLD = 1000 * 60 * 10;

export type SensorResults = {
  realtime: number;
  tenMinuteAvg: number;
};

export async function getSensorData(
  sensorIDs: string[]
): Promise<SensorResults> {
  SENSOR_ITER: for (let sensorID of sensorIDs) {
    let response = await fetch(
      `https://www.purpleair.com/json?show=${sensorID}`,
      { headers: { "user-agent": "github.com/nkcmr/aqimon" } }
    );
    if (!response.ok) {
      throw new Error(
        `non-ok status code returned from purple air (${response.statusText})`
      );
    }
    let result = (await response.json()) as PurpleAir;
    if (result.results.length === 0) {
      logInfo("purple air sensor returned zero results", { sensorID });
      continue;
    }
    const rtPM25Readings: number[] = [];
    const tenmPM25Readings: number[] = [];
    for (let subResult of result.results) {
      const lastSeen = new Date(subResult.LastSeen * 1000);
      if (Date.now() - subResult.LastSeen * 1000 > STALE_THRESHOLD) {
        logInfo("stale data coming from sensor", { sensorID, lastSeen });
        continue SENSOR_ITER;
      }
      try {
        const stats = JSON.parse(subResult.Stats);
        if (typeof stats.v !== "number" || typeof stats.v1 !== "number") {
          throw new Error(`unexpected structure/data for result.stats`);
        }
        rtPM25Readings.push(stats.v);
        tenmPM25Readings.push(stats.v1);
      } catch (e) {
        throw new Error(
          `failed to json decode results stats: ${e.message} ${result}`
        );
      }
    }
    return {
      realtime: aqiFromPM(avg(rtPM25Readings)),
      tenMinuteAvg: aqiFromPM(avg(tenmPM25Readings)),
    };
  }
  throw new Error("all sensors returned unusable results");
}

function aqiFromPM(pm: number): number {
  if (isNaN(pm)) {
    return NaN;
  }
  if (pm < 0) {
    return pm;
  }
  if (pm > 1000) {
    return NaN;
  }
  /*
    Good                            0 - 50         0.0 - 15.0         0.0 – 12.0
    Moderate                        51 - 100           >15.0 - 40        12.1 – 35.4
    Unhealthy for Sensitive Groups  101 – 150     >40 – 65          35.5 – 55.4
    Unhealthy                       151 – 200         > 65 – 150       55.5 – 150.4
    Very Unhealthy                  201 – 300 > 150 – 250     150.5 – 250.4
    Hazardous                       301 – 400         > 250 – 350     250.5 – 350.4
    Hazardous                       401 – 500         > 350 – 500     350.5 – 500
  */
  if (pm > 350.5) {
    return calcAQI(pm, 500, 401, 500, 350.5);
  } else if (pm > 250.5) {
    return calcAQI(pm, 400, 301, 350.4, 250.5);
  } else if (pm > 150.5) {
    return calcAQI(pm, 300, 201, 250.4, 150.5);
  } else if (pm > 55.5) {
    return calcAQI(pm, 200, 151, 150.4, 55.5);
  } else if (pm > 35.5) {
    return calcAQI(pm, 150, 101, 55.4, 35.5);
  } else if (pm > 12.1) {
    return calcAQI(pm, 100, 51, 35.4, 12.1);
  } else if (pm >= 0) {
    return calcAQI(pm, 50, 0, 12, 0);
  }
  return NaN;
}

function calcAQI(
  Cp: number,
  Ih: number,
  Il: number,
  BPh: number,
  BPl: number
): number {
  const a = Ih - Il;
  const b = BPh - BPl;
  const c = Cp - BPl;
  return Math.round((a / b) * c + Il);
}

function avg(nums: number[]): number {
  let total = 0;
  for (let n of nums) {
    total += n;
  }
  return total / nums.length;
}

export interface PurpleAir {
  results: Result[];
}

export interface Result {
  LastSeen: number;
  Stats: string;
}
