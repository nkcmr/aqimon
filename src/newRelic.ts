type LogMessage = {
  timestamp: number; // unix epoch (milliseconds)
  message: string;
};

class NRLogger {
  constructor() {}

  private buffer: LogMessage[] = [];

  info(message: string, attributes: Record<string, any> = {}): void {
    this.addLog("info", message, attributes);
  }

  error(message: string, attributes: Record<string, any> = {}): void {
    this.addLog("error", message, attributes);
  }

  private addLog(
    level: "info" | "error",
    message: string,
    attributes: Record<string, any> = {}
  ) {
    attributes["log_level"] = level;
    attributes["message"] = message;
    this.buffer.push({
      timestamp: Date.now(),
      message: JSON.stringify(attributes),
    });
  }

  private unixmsToRFC(unixms: number): string {
    const d = new Date(unixms);
    return d.toJSON();
  }

  flushToString(): string {
    let log: LogMessage | undefined;
    const nl = "\n";
    let out = "";
    while ((log = this.buffer.shift())) {
      out += `${this.unixmsToRFC(log.timestamp)}: ${log.message}${nl}`;
    }
    return out;
  }

  async flush(): Promise<void> {
    return;
  }
}

const globalLogger = new NRLogger();

export function logInfo(
  message: string,
  attributes: Record<string, any> = {}
): void {
  return globalLogger.info(message, attributes);
}

export function logError(
  message: string,
  attributes: Record<string, any>
): void {
  return globalLogger.error(message, attributes);
}

export function flush(): Promise<void> {
  return globalLogger.flush();
}

export function flushToString(): string {
  return globalLogger.flushToString();
}
