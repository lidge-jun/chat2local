import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * macOS Seatbelt profiles for the chat2local worker.
 *
 * Structure and rule selection follow the Codex `codex-rs/sandboxing` crate, which
 * derives its base profile from Chromium's macOS sandbox policies:
 *   https://source.chromium.org/chromium/chromium/src/+/main:sandbox/policy/mac/common.sb
 *
 * Seatbelt is closed-by-default. Everything the worker needs is enumerated here;
 * anything absent is denied by the kernel, not by this process.
 */

/** Closed-by-default core shared by every chat2local Seatbelt profile. */
export const SEATBELT_BASE_POLICY = String.raw`(version 1)

; Closed by default; every capability below is enumerated deliberately.
(deny default)

; Child processes inherit this policy; they cannot escape by spawning.
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))

; Discard writes to /dev/null without granting any other device access.
(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))

; Hardware/OS facts that language runtimes read at startup.
(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.busfrequency_compat")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cacheconfig")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cpufrequency")
  (sysctl-name "hw.cpufrequency_compat")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.model")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels")
  (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.optional.armv8_")
  (sysctl-name "hw.packages")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit")
  (sysctl-name "machdep.cpu.brand_string")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.maxproc")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype")
  (sysctl-name "vm.loadavg")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name-prefix "kern.proc.pgrp.")
  (sysctl-name-prefix "kern.proc.pid."))

(allow iokit-open
  (iokit-registry-entry-class "RootDomainUserClient"))

; User/group lookup performed by libinfo during process startup.
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo"))
`;

/**
 * Read-only system paths required to exec a binary and load dylibs.
 * Mirrors `restricted_read_only_platform_defaults.sbpl` in codex-rs, reduced to
 * what a non-interactive Node/shell worker actually touches.
 */
export const SEATBELT_PLATFORM_DEFAULTS = String.raw`
; Standard system paths readable by the loader and runtime.
(allow file-read* file-test-existence
  (subpath "/Library/Apple")
  (subpath "/Library/Filesystems/NetFSPlugins")
  (subpath "/Library/Preferences")
  (subpath "/private/var/db/timezone")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/var/db")
  (subpath "/private/var/db"))

; Map system frameworks and dylibs for the dynamic loader.
(allow file-map-executable
  (subpath "/Library/Apple/System/Library/Frameworks")
  (subpath "/Library/Apple/System/Library/PrivateFrameworks")
  (subpath "/Library/Apple/usr/lib")
  (subpath "/System/Library/Extensions")
  (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/PrivateFrameworks")
  (subpath "/System/Library/SubFrameworks")
  (subpath "/usr/lib")
  (subpath "/usr/local/lib")
  (subpath "/opt/homebrew/lib"))

(allow file-read* file-test-existence
  (subpath "/Library/Apple/System/Library/Frameworks")
  (subpath "/Library/Apple/System/Library/PrivateFrameworks")
  (subpath "/Library/Apple/usr/lib")
  (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/PrivateFrameworks")
  (subpath "/System/Library/SubFrameworks")
  (subpath "/usr/lib"))

(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall
  (require-all
    (mac-policy-name "Sandbox")
    (mac-syscall-number 67)))

; Resolve standard system symlinks and firmlink ancestors.
(allow file-read-metadata file-test-existence
  (literal "/etc")
  (literal "/tmp")
  (literal "/var")
  (literal "/private/etc/localtime"))
(allow file-read-metadata file-test-existence
  (path-ancestors "/System/Volumes/Data/private"))
(allow file-read-metadata (literal "/System/Volumes") (vnode-type DIRECTORY))
(allow file-read-metadata (literal "/System/Volumes/Data") (vnode-type DIRECTORY))
(allow file-read-metadata (literal "/System/Volumes/Data/Users") (vnode-type DIRECTORY))

; Reading the current working directory.
(allow file-read* file-test-existence (literal "/"))
(allow system-fsctl (fsctl-command FSIOC_CAS_BSDFLAGS))

; Standard special files. /dev/random and /dev/urandom back crypto seeding.
(allow file-read* file-test-existence
  (literal "/dev/autofs_nowait")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (literal "/private/etc/protocols")
  (literal "/private/etc/services"))
(allow file-read* file-test-existence file-write-data
  (literal "/dev/null")
  (literal "/dev/zero"))
(allow file-read-data file-test-existence file-write-data (subpath "/dev/fd"))
(allow file-read* file-test-existence file-write* file-ioctl (literal "/dev/dtracehelper"))

; Minimum executable runtime so the worker can exec an interpreter or shell.
; file-map-executable is separate from file-read*: without it the loader can open
; a binary but not map it, and exec fails with a bare "Operation not permitted".
(allow file-read-data file-read-metadata file-test-existence
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/usr/bin")
  (subpath "/usr/sbin")
  (subpath "/usr/libexec"))
(allow file-map-executable
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/usr/bin")
  (subpath "/usr/sbin")
  (subpath "/usr/libexec"))

; Standard config directories.
(allow file-read* (subpath "/etc"))
(allow file-read* (subpath "/private/etc"))
(allow file-read* file-test-existence
  (literal "/System/Library/CoreServices")
  (literal "/System/Library/CoreServices/.SystemVersionPlatform.plist")
  (literal "/System/Library/CoreServices/SystemVersion.plist"))

; Node aborts at startup if it cannot stat its OpenSSL configuration, so this is
; required for the interpreter to run at all, not an optional convenience.
(allow file-read* file-test-existence
  (subpath "/System/Library/OpenSSL"))
(allow file-read-metadata (subpath "/var"))
(allow file-read-metadata (subpath "/private/var"))

; Standard IO descriptors. No PTY is allocated for chat2local workers.
(allow file-read* (regex #"^/dev/fd/(0|1|2)$"))
(allow file-write* (regex #"^/dev/fd/(1|2)$"))
(allow file-read-metadata (literal "/dev"))
(allow file-read-metadata (regex #"^/dev/.*$"))

; Logging and notification agents contacted by system libraries at startup.
(allow mach-lookup
  (global-name "com.apple.analyticsd")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.diagnosticd")
  (global-name "com.apple.logd")
  (global-name "com.apple.logd.events")
  (global-name "com.apple.system.DirectoryService.libinfo_v1")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.opendirectoryd.membership"))
(allow ipc-posix-shm-read*
  (ipc-posix-name "apple.shm.notification_center"))
`;

/**
 * Network denial is inherited from `(deny default)`; this profile never opts in.
 * Codex adds an allow-list profile for proxy-routed sessions. chat2local has no
 * such mode: the worker is offline, matching `--network=none` in the Docker backend.
 */
export const SEATBELT_NETWORK_DENIED = String.raw`
; No network policy is added, so (deny default) denies every socket operation.
; Syslog is deliberately NOT allowed; it is a unix-socket write path out of the sandbox.
`;

/**
 * Seatbelt matches the RESOLVED path, so a policy naming `/tmp/x` never matches a
 * process working in `/private/tmp/x`. `/tmp`, `/var` and `/etc` are all symlinks
 * on macOS, which makes this the default case rather than an edge case. Resolve
 * eagerly; a not-yet-created leaf keeps its own name under a resolved parent.
 */
function realRoot(path: string): string {
  try { return realpathSync.native(path); } catch { /* fall through */ }
  const parent = dirname(path);
  if (parent === path) return path;
  try { return join(realpathSync.native(parent), basename(path)); } catch { return path; }
}

/** Seatbelt `-D` parameter name for the i-th writable root. */
export function writableRootParam(index: number): string {
  return `CHAT2LOCAL_WRITABLE_ROOT_${index}`;
}

/** Seatbelt `-D` parameter name for the i-th readable root. */
export function readableRootParam(index: number): string {
  return `CHAT2LOCAL_READABLE_ROOT_${index}`;
}

export interface SeatbeltProfileOptions {
  /** Absolute paths the worker may read. */
  readableRoots: string[];
  /** Absolute paths the worker may write. */
  writableRoots: string[];
}

/**
 * Build a complete `.sbpl` profile plus the `-D` parameter bindings it references.
 *
 * Paths are passed as Seatbelt parameters rather than interpolated into the policy
 * text, so a directory name containing policy syntax cannot alter the profile.
 */
export function buildSeatbeltProfile(options: SeatbeltProfileOptions): { policy: string; params: Array<[string, string]> } {
  const params: Array<[string, string]> = [];
  const sections = [SEATBELT_BASE_POLICY, SEATBELT_PLATFORM_DEFAULTS, SEATBELT_NETWORK_DENIED];

  const readFilters = options.readableRoots.map((root, index) => {
    const name = readableRootParam(index);
    params.push([name, realRoot(root)]);
    return `(subpath (param "${name}"))`;
  });
  if (readFilters.length) {
    sections.push(`; operator-selected readable roots\n(allow file-read* file-test-existence\n  ${readFilters.join('\n  ')})`);
    // An interpreter under a readable root must also be mappable to execute.
    sections.push(`(allow file-map-executable\n  ${readFilters.join('\n  ')})`);
  }

  const writeFilters = options.writableRoots.map((root, index) => {
    const name = writableRootParam(index);
    params.push([name, realRoot(root)]);
    return `(subpath (param "${name}"))`;
  });
  if (writeFilters.length) {
    sections.push(`; operator-selected writable roots\n(allow file-write*\n  ${writeFilters.join('\n  ')})`);
    // A sandboxed process must not delete the root that anchors its own policy.
    sections.push(options.writableRoots.map((_, index) =>
      `(deny file-write-unlink (require-all (literal (param "${writableRootParam(index)}")) (vnode-type DIRECTORY)))`).join('\n'));
  }

  return { policy: sections.join('\n'), params };
}

/**
 * Only `/usr/bin/sandbox-exec` is ever used. Resolving through PATH would let a
 * planted binary impersonate the sandbox; if this absolute path is compromised the
 * attacker already has root. This mirrors `MACOS_PATH_TO_SEATBELT_EXECUTABLE` in codex-rs.
 */
export const SEATBELT_EXECUTABLE = '/usr/bin/sandbox-exec';

/** Compose `sandbox-exec` argv: `-p <policy> -D<key>=<value> ... -- <command>`. */
export function seatbeltArgs(policy: string, params: Array<[string, string]>, command: string[]): string[] {
  for (const [, value] of params) {
    // Seatbelt has no escape syntax for -D values; reject rather than truncate.
    if (value.includes('\n') || value.includes('\0')) throw new Error('Sandbox root path contains an unsupported character');
  }
  return ['-p', policy, ...params.map(([key, value]) => `-D${key}=${value}`), '--', ...command];
}
