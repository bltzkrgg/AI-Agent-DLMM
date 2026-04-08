function ts() {
  return new Date().toISOString();
}

function format(level, message, context = {}) {
  return JSON.stringify({
    ts: ts(),
    level,
    message,
    ...context,
  });
}

export function logInfo(message, context = {}) {
  console.log(format('info', message, context));
}

export function logWarn(message, context = {}) {
  console.warn(format('warn', message, context));
}

export function logError(message, context = {}) {
  console.error(format('error', message, context));
}
