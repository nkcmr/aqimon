import { DateTime } from "luxon";
import { z } from "zod";
import { Env } from "./env";
import { SensorResults, getSensorData } from "./purpleAir";
import { Router } from "./router";

const operationModeSchema = z.union([
  z.literal("daily"),
  z.literal("adhoc"),
  z.literal("interval"),
]);

type OperationMode = z.infer<typeof operationModeSchema>;

async function getAdhocReportReadings(
  env: Env,
  kind: "daily" | "adhoc"
): Promise<SensorResults> {
  const nowUTC = DateTime.utc();
  const nowUnix = nowUTC.toUnixInteger();
  const lastAdhocReport = await previousReadings(env, {
    kind,
    maxAge: duration({ hours: 1 }),
  });
  const ageInSeconds = nowUnix - (lastAdhocReport?.ts || 0);
  if (ageInSeconds > 1800 || !lastAdhocReport) {
    const results = await getSensorData(
      env,
      env.SENSOR_IDS.split(",").shift() || "undefined"
    );
    await storeReadings(env, { ...results, kind });
    return results;
  }
  console.log(
    `ad-hoc report refreshed only ${ageInSeconds} second(s) ago, returning previous data`
  );
  return lastAdhocReport;
}

async function generateReport(
  env: Env,
  kind: Exclude<OperationMode, "interval">
): Promise<string> {
  console.log("generateReport");
  let results = await getAdhocReportReadings(env, kind);
  const timeString = DateTime.fromSeconds(results.ts)
    .setZone(env.LOCAL_IANA_TIME_ZONE)
    .toLocaleString(DateTime.DATETIME_FULL);
  let indicator = results.tenMinuteAvg > AQ_THRESHOLD ? "🔴" : "🟢";
  let forPlace = "";
  if (results.placeName) {
    forPlace = ` for ${results.placeName}`;
  }
  const message = [
    `📋${indicator} Current Readings${forPlace}:`,
    `Data Timestamp: ${timeString}`,
    `Realtime AQI: ${roundToDecimal(results.realtime, 0)}`,
    `10 min. average AQI: ${roundToDecimal(results.tenMinuteAvg, 0)}`,
    results.stale && `(⚠️ data might be stale)`,
  ]
    .filter((v) => !!v)
    .join("\n");
  return message;
}

type DurationUnits = {
  hours?: number;
  minutes?: number;
  seconds?: number;
};

function duration({ hours, minutes, seconds }: DurationUnits): number {
  let result = 0;
  if (hours) {
    result += hours * 3600;
  }
  if (minutes) {
    result += minutes * 60;
  }
  if (seconds) {
    result += seconds;
  }
  return result;
}

async function sendDailyReport(env: Env): Promise<void> {
  const nowLocal = DateTime.now().setZone(env.LOCAL_IANA_TIME_ZONE);
  if (!nowLocal.isValid) {
    throw new Error(
      `invalid timestamp, probably caused by bad time zone setting`
    );
  }
  const nowUnix = nowLocal.toUnixInteger();
  if (nowLocal.hour < 8) {
    return;
  }

  const lastReport = await previousReadings(env, { kind: "daily" });
  if ((lastReport?.ts ?? 0) + duration({ hours: 23 }) < nowUnix) {
    const message = await generateReport(env, "daily");
    await publishPushoverMessage(
      env,
      env.PUSHOVER_APPLICATION_TOKEN,
      env.PUSHOVER_USER_TARGET,
      message
    );
  }
}

// @ts-ignore
import indexhtml from "./index.html";

const r = Router.create<Env>((handle) => {
  handle("GET", "/", async (request, env) => {
    try {
      const message = await generateReport(env, "adhoc");
      return new Response(
        (indexhtml as string).replaceAll("{{message}}", `${message}`),
        {
          headers: {
            "content-type": "text/html",
          },
        }
      );
    } catch (e) {
      return new Response(
        `error: ${e}` + "\n" + ((e as any).stack || "<no stack>"),
        {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        }
      );
    }
  });
});

async function removeOldReadings(env: Env): Promise<void> {
  const nowEpoch = DateTime.utc().toUnixInteger();
  const fourWeeksInSeconds = 2419200;
  const minTs = nowEpoch - fourWeeksInSeconds;
  await env.DB.prepare("DELETE FROM reading WHERE ts <= ?").bind(minTs).run();
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    return r.handle(request, env, ctx);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      Promise.all([
        sendDailyReport(env),
        checkAirQuality(env),
        removeOldReadings(env).catch((e) => {
          console.error("failed to remove old readings", { error: `${e}` });
        }),
      ])
    );
  },
};

const dbResultSchema = z.object({
  ts: z.number(),
  kind: operationModeSchema,
  stale: z.union([z.literal(1), z.literal(0)]),
  place_name: z.string().nullable(),
  realtime: z.number(),
  ten_minute_avg: z.number(),
});

type PreviousReadingsConditions = {
  kind?: OperationMode;
  maxAge?: number;
};

async function previousReadings(
  env: Env,
  cond: PreviousReadingsConditions
): Promise<(SensorResults & { kind: OperationMode }) | null> {
  const conditions = ["1 = 1"];
  const params = [];
  if (cond.kind) {
    conditions.push("kind = ?");
    params.push(cond.kind);
  }
  if (cond.maxAge) {
    conditions.push("ts >= ?");
    const nowUTC = DateTime.utc();
    const minTimestamp = nowUTC.toUnixInteger() - cond.maxAge;
    params.push(minTimestamp);
  }

  const query = `SELECT ts, kind, stale, place_name, realtime, ten_minute_avg FROM reading WHERE ${conditions.join(
    " AND "
  )} ORDER BY id DESC LIMIT 1`;
  console.log({ query });
  const stmt =
    params.length > 0
      ? env.DB.prepare(query).bind(...params)
      : env.DB.prepare(query);
  const result = await stmt.all();
  if (!result.success) {
    throw new Error(`d1_error: ${result.error}`);
  }
  const numResults = result.results?.length ?? 0;
  let record: unknown;
  switch (numResults) {
    case 0:
      return null;
    case 1:
      record = result.results![0];
      break;
    default:
      throw new Error(
        `unexpected number of results returned, expected 1 or 0, got ${numResults}`
      );
  }

  const parsedRecord = dbResultSchema.safeParse(record);
  if (!parsedRecord.success) {
    throw new Error(`unexpected db result structure: ${parsedRecord.error}`);
  }
  return {
    ts: parsedRecord.data.ts,
    placeName: parsedRecord.data.place_name ?? undefined,
    realtime: parsedRecord.data.realtime,
    tenMinuteAvg: parsedRecord.data.ten_minute_avg,
    kind: parsedRecord.data.kind,
    stale: parsedRecord.data.stale === 1,
  };
}

async function storeReadings(
  env: Env,
  r: SensorResults & { kind: OperationMode }
): Promise<void> {
  console.log("storing reading", { reading: r });
  try {
    const stmt = env.DB.prepare(
      `INSERT INTO reading (ts, kind, stale, place_name, realtime, ten_minute_avg) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      r.ts,
      r.kind,
      r.stale ? 1 : 0,
      r.placeName ?? null,
      r.realtime,
      r.tenMinuteAvg
    );
    await stmt.run();
  } catch (e) {
    console.error("failed to write reading", { error: `${e}` });
    throw e;
  }
}

const AQ_THRESHOLD = 65;

async function checkAirQuality(env: Env): Promise<void> {
  try {
    console.log("checkAirQuality");
    let results = await getSensorData(
      env,
      env.SENSOR_IDS.split(",").shift() || "undefined"
    );
    console.log("current_readings", { ...results });
    let lastReadings = await previousReadings(env, {
      kind: "interval",
      maxAge: duration({ hours: 1 }),
    });
    await storeReadings(env, { ...results, kind: "interval" });
    if (!lastReadings) {
      console.log("no previous readings stored, nothing to compare");
      return;
    }
    console.log("last_readings", lastReadings);
    let event: "air_quality_good" | "air_quality_bad";
    if (
      lastReadings.tenMinuteAvg > AQ_THRESHOLD &&
      results.tenMinuteAvg <= AQ_THRESHOLD
    ) {
      event = "air_quality_good";
    } else if (
      lastReadings.tenMinuteAvg <= AQ_THRESHOLD &&
      results.tenMinuteAvg > AQ_THRESHOLD
    ) {
      event = "air_quality_bad";
    } else {
      console.log("nothing to alert about");
      return;
    }
    await notify(env, event, results);
  } catch (e: any) {
    console.log("failed to check air quality", {
      error: e.message,
    });
    throw e;
  }
}

function roundToDecimal(x: number, precision: number): number {
  let pow10 = Math.pow(10, precision);
  return Math.round(x * pow10) / pow10;
}

async function notify(
  env: Env,
  event: "air_quality_good" | "air_quality_bad",
  readings: SensorResults
): Promise<void> {
  let message = "";
  switch (event) {
    case "air_quality_good":
      message =
        "📉👍 Nearby air quality seems to be getting better. Open windows for fresh air.";
      break;
    case "air_quality_bad":
      message =
        "📈👎 Nearby air quality is getting bad. Close any open windows.";
      break;
  }
  message += "\n";
  message += `(avg10_aqi: ${roundToDecimal(
    readings.tenMinuteAvg,
    0
  )}, rt_aqi: ${roundToDecimal(readings.realtime, 0)})`;
  if (readings.stale) {
    message += "\n(⚠️ data might be stale)";
  }
  await publishPushoverMessage(
    env,
    env.PUSHOVER_APPLICATION_TOKEN,
    env.PUSHOVER_USER_TARGET,
    message
  );
}

async function publishPushoverMessage(
  env: Env,
  applicationToken: string,
  to: string,
  message: string
): Promise<void> {
  await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: {
      "user-agent": "github.com/nkcmr/aqimon",
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      token: applicationToken,
      user: to,
      message: message + "\n(Click this message to get a real-time report)",
      priority: -1,
      url: `https://${env.HOSTNAME}/`,
    }),
  });
}
