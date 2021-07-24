import { Buffer } from "buffer/";
import { date } from "phpdate";
import {
  flush as flushLogsToNR,
  flushToString as flushLogs,
  logError,
  logInfo,
} from "./newRelic";
import { getSensorData, SensorResults } from "./purpleAir";
// var bindings
declare const SMS_RECIPIENTS: string;
declare const TWILIO_FROM: string;
declare const TWILIO_ACCOUNT_SID: string;
declare const TWILIO_AUTH_TOKEN: string;
declare const SENSOR_IDS: string;
declare const TWILIO_WH_PSK: string;

// kv bindings
declare const STATE: KVNamespace;

function noopResponse(): Response {
  return new Response("", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

function errorResponse(message: string): Response {
  return new Response(`error: ${message}` + "\n", {
    status: 500,
    headers: { "content-type": "text/plain" },
  });
}

async function processRequest(req: Request): Promise<Response> {
  try {
    if (req.method !== "POST") {
      return noopResponse();
    }
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/incoming-message":
        return await incomingMessage(req, url);
    }
    return noopResponse();
  } catch (e) {
    logError("failed to process request", { error: e.message });
    return errorResponse(e.message);
  } finally {
    await flushLogsToNR();
  }
}

async function incomingMessage(req: Request, url: URL): Promise<Response> {
  const psk = url.searchParams.get("psk");
  if (psk !== TWILIO_WH_PSK) {
    return errorResponse("invalid psk");
  }
  const bodyText = await req.text();
  const body = new URLSearchParams(bodyText);
  const from = body.get("From");
  if (!from) {
    return errorResponse("no from");
  }
  // determine if from is from any of the sms recipients
  const fromIsRecipient = SMS_RECIPIENTS.split(",").some(
    (recipient) => recipient === from
  );
  if (!fromIsRecipient) {
    logInfo("message from an unknown number", { from, body });
    return noopResponse();
  }
  logInfo("message from known number", { from, body });
  const contents = body.get("Body");
  if (!contents || contents.trim().length === 0) {
    return noopResponse();
  }
  switch (contents.toLowerCase().trim()) {
    case "report":
      return await generateReport();
  }
  return errorResponse("unknown command");
}

async function generateReport(): Promise<Response> {
  logInfo("generateReport");
  let results = await getSensorData(SENSOR_IDS.split(","));
  let indicator = results.tenMinuteAvg > AQ_THRESHOLD ? "🔴" : "🟢";
  return new Response(
    [
      `📋${indicator} Current Readings (as of ${currentTimestamp()} UTC):`,
      `Realtime PM2.5: ${roundToDecimal(results.realtime, 0)}`,
      `10 min. average: ${roundToDecimal(results.tenMinuteAvg, 0)}`,
    ].join("\n"),
    {
      headers: {
        "Content-Type": "text/plain",
      },
    }
  );
}

function currentTimestamp(): string {
  return date("F j, Y, g:i a");
}

addEventListener("fetch", (event) => {
  event.respondWith(processRequest(event.request));
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
  for (let phoneNumber of SMS_RECIPIENTS.split(",").map((s) => s.trim())) {
    await sendSms(phoneNumber, message);
  }
}

async function sendSms(to: string, message: string): Promise<void> {
  const body = new URLSearchParams();
  body.set("Body", message);
  body.set("From", TWILIO_FROM);
  body.set("To", to);
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        "user-agent": "github.com/nkcmr/aqimon",
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        authorization: twilioAuthHeader(),
      },
      body: body.toString(),
    }
  );
  if (!res.ok) {
    logError("non-ok response body", { body: await res.text() });
    throw new Error(`non-ok status returned from twilio (${res.statusText})`);
  }
}

function twilioAuthHeader(): string {
  return `Basic ${Buffer.from(
    `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`
  ).toString("base64")}`;
}
