import { z } from "zod";
import { Env } from "./env";

const purpleAirSensorResponseSchema = z.object({
  data_time_stamp: z.number(),
  sensor: z.object({
    latitude: z.number(),
    longitude: z.number(),
    stats: z.object({
      "pm2.5": z.number(),
      "pm2.5_10minute": z.number(),
      time_stamp: z.number(),
    }),
  }),
});

export type SensorResults = {
  ts: number;
  placeName: string | undefined;
  realtime: number;
  tenMinuteAvg: number;
};

async function getPlaceName(
  env: Env,
  lat: number,
  long: number
): Promise<string> {
  const stateKey = `placename:${lat},${long}`;
  let placeNameResult = await env.STATE.get<{ result: string }>(
    stateKey,
    "json"
  );
  if (!placeNameResult) {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${long}&key=${env.GOOGLE_MAPS_GEOCODING_API_KEY}`
    );
    if (!response.ok) {
      throw new Error(
        `non-ok response returned from google maps geocoding API: ${response.statusText}`
      );
    }
    const data = (await response.json()) as any;
    typeLoop: for (let resultType of [
      "neighborhood",
      "sublocality_level_1",
      "administrative_area_level_2",
      "locality",
    ]) {
      for (let result of data.results) {
        if ((result.types as string[]).includes(resultType)) {
          placeNameResult = { result: result.formatted_address };
          break typeLoop;
        }
      }
    }
    if (!placeNameResult) {
      throw new Error("failed to find suitable formatted address for lat,long");
    }
    await env.STATE.put(stateKey, JSON.stringify(placeNameResult), {
      expirationTtl: 31534272,
    });
  }
  return placeNameResult!.result;
}

export async function getSensorData(
  env: Env,
  sensorID: string
): Promise<SensorResults> {
  let response = await fetch(
    `https://api.purpleair.com/v1/sensors/${sensorID}`,
    {
      headers: {
        "x-api-key": env.PURPLE_AIR_READ_API_KEY,
      },
    }
  );
  if (!response.ok) {
    throw new Error(
      `non-ok status code returned from purple air (${response.statusText})`
    );
  }
  const result = await purpleAirSensorResponseSchema.parseAsync(
    await response.json()
  );
  let placeName: string | undefined;
  try {
    placeName = await getPlaceName(
      env,
      result.sensor.latitude,
      result.sensor.longitude
    );
  } catch {}
  const ts = result.sensor.stats.time_stamp;
  return {
    ts,
    placeName,
    realtime: aqiFromPM(result.sensor.stats["pm2.5"]),
    tenMinuteAvg: aqiFromPM(result.sensor.stats["pm2.5_10minute"]),
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
