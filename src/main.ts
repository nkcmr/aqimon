import { DateTime } from "luxon";
import { date } from "phpdate";
import { flushToString as flushLogs, logError, logInfo } from "./newRelic";
import { getSensorData, SensorResults } from "./purpleAir";
import { Router } from "./router";
// var bindings
declare const SENSOR_IDS: string;
declare const PUSHOVER_APPLICATION_TOKEN: string;
declare const PUSHOVER_USER_TARGET: string;
declare const LOCAL_IANA_TIME_ZONE: string;
declare const PRIVATE_REPORT_URL: string;
declare const HOSTNAME: string;

// kv bindings
declare const STATE: KVNamespace;

async function getAdhocReportReadings(): Promise<SensorResults> {
  const nowUTC = DateTime.utc();
  const nowUnix = nowUTC.toUnixInteger();
  const lastAdhocReportRefreshStr = await STATE.get(
    "last_adhoc_report_refresh",
    "text"
  );
  const lastAdhocReportRefresh = parseInt(lastAdhocReportRefreshStr ?? "0");
  const secondsSince = nowUnix - lastAdhocReportRefresh;
  const prevReadings = await previousReadings();
  if (secondsSince > 1800 || !prevReadings) {
    const results = await getSensorData(
      SENSOR_IDS.split(",").shift() || "undefined"
    );
    await storeReadings(results);
    await STATE.put("last_adhoc_report_refresh", `${nowUnix}`);
    return results;
  }
  console.log(
    `ad-hoc report refreshed only ${secondsSince} second(s) ago, returning previous data`
  );
  return prevReadings;
}

async function generateReport(): Promise<string> {
  logInfo("generateReport");
  let results = await getAdhocReportReadings();
  const timeString = DateTime.fromSeconds(results.ts)
    .setZone(LOCAL_IANA_TIME_ZONE)
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

async function sendDailyReport(): Promise<void> {
  const nowLocal = DateTime.now().setZone(LOCAL_IANA_TIME_ZONE);
  if (!nowLocal.isValid) {
    throw new Error(
      `invalid timestamp, probably caused by bad time zone setting`
    );
  }
  const nowUnix = nowLocal.toUnixInteger();
  if (nowLocal.hour < 8) {
    return;
  }
  const lastReportStr = await STATE.get<string>("last_successful_daily_report");
  const lastReport = parseInt(lastReportStr ?? "0", 10);
  if (lastReport + 82800 < nowUnix) {
    const message = await generateReport();
    await publishPushoverMessage(
      PUSHOVER_APPLICATION_TOKEN,
      PUSHOVER_USER_TARGET,
      message
    );

    await STATE.put("last_successful_daily_report", `${nowUnix}`);
  }
}

function currentTimestamp(): string {
  return date("F j, Y, g:i a");
}

// @ts-ignore
import indexhtml from "./index.html";

const r = Router.create((handle) => {
  handle("POST", `${PRIVATE_REPORT_URL}/refresh`, async () => {
    return new Response("", {
      status: 302,
      headers: {
        Location: PRIVATE_REPORT_URL,
      },
    });
  });
  handle("GET", PRIVATE_REPORT_URL, async (request) => {
    const message = await generateReport();
    return new Response(
      (indexhtml as string).replaceAll("{{message}}", `${message}`),
      {
        headers: {
          "content-type": "text/html",
        },
      }
    );
  });
});

addEventListener("fetch", (event) => {
  event.respondWith(r.handle(event.request, {}, event));
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
      message: message + "\n(Click this message to get a real-time report)",
      priority: -1,
      url: `https://${HOSTNAME}${PRIVATE_REPORT_URL}`,
    }),
  });
}
