import { createOperationLog, updateOperationLog } from '../db/database.js';
import { validateExecutionPolicy } from './executionPolicy.js';
import { logError, logInfo } from '../utils/logger.js';

function extractTxHashes(result) {
  if (!result) return [];
  if (Array.isArray(result.txHashes)) return result.txHashes;
  if (result.txHash) return [result.txHash];
  return [];
}

export async function executeControlledOperation({
  operationType,
  entityId = null,
  payload = null,
  metadata = null,
  policy = {},
  execute,
}) {
  const safeEntityId = entityId;
  validateExecutionPolicy({
    operationType,
    entityId: safeEntityId,
    ...policy,
  });

  let log;
  try {
    log = await createOperationLog({
      operationType,
      entityId: safeEntityId,
      payload,
      metadata,
      status: 'pending',
    });
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE constraint failed')) {
      throw new Error(`Operasi ${operationType} masih berjalan. Coba lagi setelah selesai.`);
    }
    throw error;
  }
  const operationId = log.lastInsertRowid;

  await updateOperationLog(operationId, { status: 'in_progress', metadata });
  logInfo('operation_started', { operationType, entityId: safeEntityId, operationId });

  try {
    const result = await execute();
    await updateOperationLog(operationId, {
      status: 'success',
      result,
      metadata,
      txHashes: extractTxHashes(result),
    });
    logInfo('operation_succeeded', { operationType, entityId: safeEntityId, operationId });
    return { operationId, result };
  } catch (error) {
    await updateOperationLog(operationId, {
      status: 'failed',
      errorMessage: error.message,
      metadata,
    });
    logError('operation_failed', {
      operationType,
      entityId: safeEntityId,
      operationId,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}
