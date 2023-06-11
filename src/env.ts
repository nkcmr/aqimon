export interface Env {
  DB: D1Database;
  STATE: KVNamespace;

  SENSOR_IDS: string;
  PUSHOVER_APPLICATION_TOKEN: string;
  PUSHOVER_USER_TARGET: string;
  LOCAL_IANA_TIME_ZONE: string;
  HOSTNAME: string;
  PURPLE_AIR_READ_API_KEY: string;
  GOOGLE_MAPS_GEOCODING_API_KEY: string;
}
