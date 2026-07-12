import process from 'node:process';

export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseTimerDelay(value, name) {
  const parsed = parsePositiveInteger(value, name);
  if (parsed > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name} must not exceed ${MAX_TIMER_DELAY_MS}`);
  }
  return parsed;
}

export function killProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    if (process.platform === 'win32') {
      child.kill('SIGKILL');
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}
