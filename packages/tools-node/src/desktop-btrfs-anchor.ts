import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
/** Fixed Linux x86_64 ABI; receives only an already-open directory at descriptor 3. */
export const desktopBtrfsProgram = `import ctypes,fcntl,json,struct
libc=ctypes.CDLL(None,use_errno=True)
class Handle(ctypes.Structure):
 _fields_=[("size",ctypes.c_uint),("type",ctypes.c_int),("bytes",ctypes.c_ubyte*128)]
h=Handle();h.size=128
mount=ctypes.c_int()
libc.name_to_handle_at.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_void_p,ctypes.POINTER(ctypes.c_int),ctypes.c_int]
if libc.name_to_handle_at(3,b"",ctypes.byref(h),ctypes.byref(mount),0x1000)!=0: raise OSError(ctypes.get_errno())
if not 0<h.size<=128 or h.type<0: raise ValueError("handle")
filesystem=bytearray(1024);fcntl.ioctl(3,0x8400941f,filesystem,True)
subvolume=bytearray(504);fcntl.ioctl(3,0x81f8943c,subvolume,True)
print(json.dumps({"filesystem":bytes(filesystem[16:32]).hex(),"subvolume":bytes(subvolume[296:312]).hex(),"subvolumeId":str(struct.unpack_from("<Q",subvolume)[0]),"type":h.type,"handle":bytes(h.bytes[:h.size]).hex()},separators=(",",":")))
`;
/** Null means an unqualified filesystem: callers retain explicit legacy exact mode. Helper failure never does. */
export function desktopBtrfsAnchor(fd: number): string | null {
  if (process.platform !== 'linux' || process.arch !== 'x64') return null;
  if (Number(fs.statfsSync('/proc/self/fd/' + String(fd)).type) !== 0x9123683e) return null;
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', desktopBtrfsProgram], {
    cwd: '/',
    env: {},
    stdio: ['ignore', 'pipe', 'pipe', fd],
    encoding: 'utf8',
    timeout: 2000,
    killSignal: 'SIGKILL',
    maxBuffer: 4096,
  });
  if (
    result.error ||
    result.status !== 0 ||
    result.signal ||
    result.stderr ||
    !result.stdout ||
    result.stdout.length > 1024
  )
    throw Error('desktop_anchor_unavailable');
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw Error('desktop_anchor_unavailable');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('desktop_anchor_unavailable');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join() !== 'filesystem,handle,subvolume,subvolumeId,type' ||
    !['filesystem', 'subvolume', 'subvolumeId', 'handle'].every(
      (key) => typeof v[key] === 'string',
    ) ||
    !Number.isInteger(v['type'])
  )
    throw Error('desktop_anchor_unavailable');
  return [
    'linux-btrfs-v1',
    v['filesystem'],
    v['subvolume'],
    v['subvolumeId'],
    v['type'],
    v['handle'],
  ].join(':');
}
