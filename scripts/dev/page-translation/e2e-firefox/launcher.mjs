import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

export function launchIsolatedWorker({ command, args, env, artifactPath, runId, writeFailure, spawnProcess = spawn, readArtifact = path => readFile(path, 'utf8'), processRef = process, timeoutMs = 210_000, killGraceMs = 1000, finalGraceMs = 3000 }) {
  return new Promise(resolve => {
    let child; let spawnError = null; let settled = false; let deadlineExpired = false; let deadline; let killDeadline;
    const finish = async (code, signal, timedOut = false) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(killDeadline);
      if (spawnError || timedOut || deadlineExpired || code === null) {
        const reason = spawnError ? `Isolated worker spawn failed: ${spawnError.message}` : (timedOut || deadlineExpired) ? 'Isolated worker exceeded its bounded deadline.' : `Isolated worker closed without an exit code (${signal ?? 'unknown signal'}).`;
        try { await writeFailure(reason, spawnError ?? new Error(reason)); } catch { /* Exit remains failure if artifact storage also fails. */ }
        resolve(1); return;
      }
      let artifact;
      try { artifact = JSON.parse(await readArtifact(artifactPath)); }
      catch (error) {
        try { await writeFailure(`Worker did not produce a readable artifact for this run: ${error.message}`, error); } catch { /* Preserve failure status. */ }
        resolve(1); return;
      }
      if (artifact.runId !== runId) {
        const error = new Error(`Artifact belongs to another run (${String(artifact.runId)} != ${runId}).`);
        try { await writeFailure(error.message, error); } catch { /* Preserve failure status. */ }
        resolve(1); return;
      }
      const expectedCode = artifact.status === 'SUPPORTED' ? 0 : artifact.status === 'UNSUPPORTED' ? 2 : 1;
      if (code !== expectedCode) {
        const error = new Error(`Worker exit ${code} disagrees with current artifact status ${artifact.status}.`);
        try { await writeFailure(error.message, error); } catch { /* Preserve failure status. */ }
        resolve(1); return;
      }
      resolve(code);
    };
    try {
      child = spawnProcess(command, args, { stdio: 'inherit', env, detached: true });
      child.once('error', error => { spawnError = error; void finish(null, null); });
      child.once('close', (code, signal) => { void finish(code, signal); });
      deadline = setTimeout(() => {
        deadlineExpired = true;
        try { processRef.kill(-child.pid, 'SIGTERM'); } catch { child.kill?.('SIGTERM'); }
        killDeadline = setTimeout(() => {
          try { processRef.kill(-child.pid, 'SIGKILL'); } catch { child.kill?.('SIGKILL'); }
          killDeadline = setTimeout(() => { void finish(null, 'SIGKILL', true); }, finalGraceMs);
        }, killGraceMs);
      }, timeoutMs);
    } catch (error) {
      spawnError = error;
      void finish(null, null);
    }
  });
}
