import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute = promisify(execFile);
export const ODIFF_VERSION = '4.3.8';

export function isOdiffVersion(output: string): boolean {
  const escapedVersion = ODIFF_VERSION.replaceAll('.', '\\.');
  return new RegExp(`^odiff\\s+${escapedVersion}(?:\\s|$)`).test(output.trim());
}

export async function checkOdiffBinary(command = 'odiff'): Promise<void> {
  const {stdout, stderr} = await execute(command, ['--version'], {timeout: 5_000});
  const output = `${stdout}\n${stderr}`;
  if (!isOdiffVersion(output)) {
    throw new Error(
      `ODiff ${ODIFF_VERSION} is required; received ${output.trim() || 'no version'}.`,
    );
  }
}
