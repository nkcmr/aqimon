declare const PURPLE_AIR_READ_API_KEY: string;
const STALE_THRESHOLD = 1000 * 60 * 10;

export type SensorResults = {
  realtime: number;
  tenMinuteAvg: number;
  stale: boolean;
};

export async function getSensorData(sensorID: string): Promise<SensorResults> {
  let response = await fetch(
    `https://api.purpleair.com/v1/sensors/${sensorID}`,
    {
      headers: {
        "x-api-key": PURPLE_AIR_READ_API_KEY,
      },
    }
  );
  if (!response.ok) {
    throw new Error(
      `non-ok status code returned from purple air (${response.statusText})`
    );
  }
  let result = (await response.json()) as PurpleAir;
  return {
    realtime: aqiFromPM(result.sensor.stats["pm2.5"]),
    tenMinuteAvg: aqiFromPM(result.sensor.stats["pm2.5_10minute"]),
    stale: Date.now() - result.sensor.stats.time_stamp * 1000 > STALE_THRESHOLD,
  };
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
  if (nums.length === 0) {
    return NaN;
  }
  return nums.reduce((acc, n) => acc + n, 0) / nums.length;
}

export interface PurpleAir {
  sensor: {
    stats: {
      "pm2.5": number;
      "pm2.5_10minute": number;
      time_stamp: number;
    };
  };
}
