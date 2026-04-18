import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Menjalankan perintah shell dan mengembalikan output stdout.
 * @param {string} command Perintah yang akan dijalankan
 * @param {string} cwd Directory tempat menjalankan perintah
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function runCommand(command, cwd = process.cwd()) {
  try {
    console.log(`🐚 [shell] Executing: ${command}`);
    const { stdout, stderr } = await execAsync(command, { cwd });
    if (stderr && !stderr.includes('already up to date') && !stderr.includes('npm notice')) {
      console.warn(`🐚 [shell] Warning for ${command}:`, stderr);
    }
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    console.error(`🐚 [shell] ERROR executing ${command}:`, error.message);
    throw new Error(`Command failed: ${command}\n${error.message}`);
  }
}

/**
 * Melakukan sinkronisasi kode dari GitHub (Git Pull).
 */
export async function performGitPull() {
  const { stdout } = await runCommand('git pull');
  return stdout;
}

/**
 * Melakukan instalasi dependensi (NPM Install).
 */
export async function performNpmInstall() {
  const { stdout } = await runCommand('npm install --no-audit --no-fund');
  return stdout;
}

/**
 * Jalankan health checks minimal sebelum restart pasca-update.
 * Return output gabungan untuk dilaporkan ke Telegram.
 */
export async function performPostUpdateChecks() {
  const hardChecks = [
    'node --test tests/deploy-readiness.test.js tests/config.test.js',
  ];
  const outputs = [];
  for (const cmd of hardChecks) {
    const { stdout } = await runCommand(cmd);
    outputs.push(`$ ${cmd}\n${stdout}`);
  }
  // Lint bersifat advisory (non-blocking) karena beberapa debt lama bisa membuat
  // /system_update terkunci walau runtime core sudah sehat.
  try {
    const { stdout } = await runCommand('npm run lint');
    outputs.push(`$ npm run lint\n${stdout}`);
  } catch (e) {
    outputs.push(`$ npm run lint\nWARNING (non-blocking): ${e.message}`);
  }
  return outputs.join('\n\n');
}
