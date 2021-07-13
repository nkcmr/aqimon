import { Buffer } from "buffer/";
import { flushToString as flushLogs, logError, logInfo } from "./newRelic";
import { getSensorData, SensorResults } from "./purpleAir";

// var bindings
declare const SMS_RECIPIENTS: string;
declare const TWILIO_FROM: string;
declare const TWILIO_ACCOUNT_SID: string;
declare const TWILIO_AUTH_TOKEN: string;
declare const SENSOR_IDS: string;

// kv bindings
declare const STATE: KVNamespace;

addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.searchParams.get("debug_mode")) {
    event.respondWith(
      checkAirQuality().then(() => {
        return new Response(flushLogs(), {
          headers: {
            "content-type": "text/plain",
          },
        });
      })
    );
  } else {
    event.respondWith(
      new Response("hello...", {
        headers: { "content-type": "application/json" },
      })
    );
  }
});

addEventListener("scheduled", (event) => {
  event.waitUntil(
    checkAirQuality().then(() => {
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
    let results = await getSensorData(SENSOR_IDS.split(","));
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
  } catch (e) {
    logError("failed to check air quality", {
      error: e.message,
    });
    return;
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
  message += `(avg10_pm2.5: ${roundToDecimal(
    readings.tenMinuteAvg,
    0
  )}, rt_pm2.5: ${roundToDecimal(readings.realtime, 0)})`;

  let allURLParams = new URLSearchParams();
  allURLParams.set("Body", message);
  allURLParams.set("From", TWILIO_FROM);
  for (let phoneNumber of SMS_RECIPIENTS.split(",").map((s) => s.trim())) {
    let urlParams = new URLSearchParams(allURLParams);
    urlParams.set("To", phoneNumber);
    let response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          "user-agent": "github.com/nkcmr/aqimon",
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          authorization: twilioAuthHeader(),
        },
        body: urlParams.toString(),
      }
    );
    if (!response.ok) {
      logError(`non-ok response body`, { body: await response.text() });
      throw new Error(
        `non-ok status returned from twilio (${response.statusText})`
      );
    }
  }
}

function twilioAuthHeader(): string {
  return `Basic ${Buffer.from(
    `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`
  ).toString("base64")}`;
}
