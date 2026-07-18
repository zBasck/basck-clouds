/**
 * Factory: dado um ProviderId, devolve a implementação correspondente.
 */
import { GoogleDriveProvider } from './google-drive';
import { OneDriveProvider } from './onedrive';
import { DropboxProvider } from './dropbox';
import { MegaProvider } from './mega';
import { BoxProvider } from './box';
import { WebDavProvider } from './webdav';
import { SftpProvider } from './sftp';
import { LocalFsProvider } from './local-fs';
import { S3CompatibleProvider } from './s3-compatible';
import { GENERIC_PROVIDERS } from './generic-rest';
import type { CloudProvider } from './types';
import type { ProviderId } from '@shared/types';

export function getProvider(id: ProviderId): CloudProvider {
  switch (id) {
    case 'googledrive':
      return new GoogleDriveProvider();
    case 'onedrive':
      return new OneDriveProvider();
    case 'dropbox':
      return new DropboxProvider();
    case 'mega':
      return new MegaProvider();
    case 'box':
      return new BoxProvider();
    case 'webdav':
      return new WebDavProvider();
    case 'sftp':
      return new SftpProvider();
    case 'local':
      return new LocalFsProvider();
    case 's3':
    case 'wasabi':
    case 'backblazeb2':
    case 'gcs':
    case 'azureblob':
    case 'digitalocean':
    case 'cloudflare_r2':
      return new S3CompatibleProvider(id);
    default:
      if (GENERIC_PROVIDERS[id]) return GENERIC_PROVIDERS[id];
      throw new Error(`Provedor não implementado: ${id}`);
  }
}
