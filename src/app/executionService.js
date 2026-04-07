import { createOperationLog, updateOperationLog } from '../db/database.js';
import { validateExecutionPolicy } from './executionPolicy.js';

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
  validateExecutionPolicy({
    operationType,
    entityId,
    ...policy,
  });

  const log = createOperationLog({
    operationType,
    entityId,
    payload,
    metadata,
    status: 'pending',
  });
  const operationId = log.lastInsertRowid;

  updateOperationLog(operationId, { status: 'in_progress', metadata });

  try {
    const result = await execute();
    updateOperationLog(operationId, {
      status: 'success',
      result,
      metadata,
      txHashes: extractTxHashes(result),
    });
    return { operationId, result };
  } catch (error) {
    updateOperationLog(operationId, {
      status: 'failed',
      errorMessage: error.message,
      metadata,
    });
    throw error;
  }
}
