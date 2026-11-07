import { modelConnectionRecord } from './model-connection-validation.js';
import type { ModelConnectionRecord } from './model-connection-ports.js';
import type { ProviderSecretStorePort } from './provider-connection-ports.js';
import { requestCode } from './provider-connection-request.js';
/** Only the persisted intent authorizes private effects, including exact retry recovery. */
export function publishModelSecret(
  record: ModelConnectionRecord,
  key: string | undefined,
  secrets: ProviderSecretStorePort,
): void {
  record = modelConnectionRecord(record);
  const change = record.pendingSecretChange;
  if (record.intent !== 'pending' || change === null) throw Error('provider_unverified');
  try {
    if (change.action === 'replace') {
      if (key === undefined || change.nextRef === null || record.secretRef !== change.nextRef)
        throw Error('provider_unverified');
      if (change.previousRef === null) secrets.write(change.nextRef, key);
      else secrets.replace(change.previousRef, change.nextRef, key);
      const published = secrets.read(change.nextRef);
      if (published.status !== 'ok' || published.key !== key) throw Error('provider_unverified');
    } else {
      if (change.nextRef !== null || record.secretRef !== null) throw Error('provider_unverified');
      if (change.previousRef !== null) {
        secrets.remove(change.previousRef);
        if (secrets.read(change.previousRef).status !== 'absent')
          throw Error('provider_unverified');
      }
    }
  } catch (error) {
    throw Error(requestCode(error, 'provider_write_failed'));
  }
}
