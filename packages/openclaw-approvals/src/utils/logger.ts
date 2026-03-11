export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevelName, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLogLevel(value: string | undefined): LogLevelName {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'debug':
      return 'debug';
    case 'warn':
      return 'warn';
    case 'error':
      return 'error';
    case 'info':
    default:
      return 'info';
  }
}

function resolveLogLevel(): LogLevelName {
  return normalizeLogLevel(
    process.env.PLUGIN_LOG_LEVEL ??
      process.env.OPENCLAW_LOG_LEVEL ??
      process.env.LOG_LEVEL
  );
}

function shouldLog(level: LogLevelName): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[resolveLogLevel()];
}

function write(level: LogLevelName, event: string, data?: Record<string, unknown>) {
  if (!shouldLog(level)) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    level,
    component: 'openclaw-approvals-plugin',
    event,
    ...(data ?? {}),
  };

  const line = JSON.stringify(payload);
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  if (level === 'error') {
    console.error(line);
    return;
  }
  console.log(line);
}

export const logger = {
  debug(event: string, data?: Record<string, unknown>) {
    write('debug', event, data);
  },
  info(event: string, data?: Record<string, unknown>) {
    write('info', event, data);
  },
  warn(event: string, data?: Record<string, unknown>) {
    write('warn', event, data);
  },
  error(event: string, data?: Record<string, unknown>) {
    write('error', event, data);
  },
  getLevel(): LogLevelName {
    return resolveLogLevel();
  },
};
