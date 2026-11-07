export interface ReleaseBundleRecord {
  readonly adapter: string;
  readonly entry: string;
  readonly integrity: string;
  readonly integritySha256: string;
  readonly files: Readonly<Record<string, string>>;
  readonly identities: Readonly<Record<string, string>>;
}
export interface ReleaseManifest {
  readonly format: 1;
  readonly version: string;
  readonly revision: string;
  readonly node: string;
  readonly platform: 'linux';
  readonly arch: 'x64';
  readonly lockfileSha256: string;
  readonly files: Readonly<Record<string, { sha256: string; mode: number }>>;
  /** Present when the archive ships a modern or supported historical adapter bundle. */
  readonly bundle?: ReleaseBundleRecord;
}
