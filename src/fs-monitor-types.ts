export type ChangeOperation = 'create' | 'modify' | 'delete' | 'rename';

export interface FileChange {
  changeId: string;
  sessionId: string;
  timestamp: number;
  pid: number;
  operation: ChangeOperation;
  path: string;
  oldPath?: string;        // rename only
  beforeHash: string | null;
  afterHash: string | null;
  fileSize: number;
  isBinary: boolean;
}

/** JSON line event from the LD_PRELOAD shared library */
export interface PreloadEvent {
  session_id: string;
  op: 'write' | 'rename' | 'delete' | 'truncate';
  path: string;
  old_path?: string;
  snapshot?: string;       // path to snapshot file
  file_existed: boolean;
  ts: number;
}
