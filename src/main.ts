import { date } from "phpdate";
import { flushToString as flushLogs, logError, logInfo } from "./newRelic";
import { getSensorData, SensorResults } from "./purpleAir";
// var bindings
declare const SENSOR_IDS: string;
declare const PUSHOVER_APPLICATION_TOKEN: string;
declare const PUSHOVER_USER_TARGET: string;

// kv bindings
declare const STATE: KVNamespace;

function noopResponse(): Response {
  return new Response("404 page not found", {
    status: 404,
    headers: { "content-type": "text/plain" },
  });
}

async function generateReport(): Promise<void> {
  logInfo("generateReport");
  let results = await getSensorData(
    SENSOR_IDS.split(",").shift() || "undefined"
  );
  let indicator = results.tenMinuteAvg > AQ_THRESHOLD ? "🔴" : "🟢";
  const message = [
    `📋${indicator} Current Readings (as of ${currentTimestamp()} UTC):`,
    `Realtime AQI: ${roundToDecimal(results.realtime, 0)}`,
    `10 min. average AQI: ${roundToDecimal(results.tenMinuteAvg, 0)}`,
    results.stale && `(⚠️ data might be stale)`,
  ]
    .filter((v) => !!v)
    .join("\n");
  await publishPushoverMessage(
    PUSHOVER_APPLICATION_TOKEN,
    PUSHOVER_USER_TARGET,
    message
  );
}

async function sendDailyReport(): Promise<void> {
  const now = new Date();
  const nowUnix = Math.round(now.getTime() / 1_000);
  if (now.getHours() < 12) {
    return;
  }
  const lastReportStr = await STATE.get<string>("last_successful_daily_report");
  const lastReport = parseInt(lastReportStr ?? "0", 10);
  if (lastReport + 82800 < nowUnix) {
    await generateReport();
    await STATE.put("last_successful_daily_report", `${nowUnix}`);
  }
}

function currentTimestamp(): string {
  return date("F j, Y, g:i a");
}

addEventListener("fetch", (event) => {
  event.respondWith(noopResponse());
});

addEventListener("scheduled", (event) => {
  event.waitUntil(
    Promise.all([sendDailyReport(), checkAirQuality()]).finally(() => {
      return flushLogs();
    })
  );
});

function previousReadings(): Promise<SensorResults | null> {
  return STATE.get<SensorResults>("last_readings", "json");
}

function storeReadings(r: SensorResults): Promise<void> {
  return STATE.put("last_readings", JSON.stringify(r), {
    expirationTtl: 3600, // 1 hour
  });
}

const AQ_THRESHOLD = 65;

async function checkAirQuality(): Promise<void> {
  try {
    logInfo("checkAirQuality");
    let results = await getSensorData(
      SENSOR_IDS.split(",").shift() || "undefined"
    );
    logInfo("current_readings", { ...results });
    let lastReadings = await previousReadings();
    await storeReadings(results);
    if (!lastReadings) {
      logInfo("no previous readings stored, nothing to compare");
      return;
    }
    logInfo("last_readings", lastReadings);
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
      logInfo("nothing to alert about");
      return;
    }
    await notify(event, results);
  } catch (e: any) {
    logError("failed to check air quality", {
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
    PUSHOVER_APPLICATION_TOKEN,
    PUSHOVER_USER_TARGET,
    message
  );
}

async function publishPushoverMessage(
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
      message,
      priority: -1,
    }),
  });
}
