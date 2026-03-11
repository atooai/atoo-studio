/*
 * atoo-studio-preload.c — LD_PRELOAD shared library for Copy-on-Write filesystem monitoring.
 *
 * Intercepts libc file operations (open, rename, unlink, truncate) to:
 *   1. Snapshot the original file before modification
 *   2. Report the event to the TypeScript monitor via Unix socket
 *
 * Environment variables:
 *   ATOO_SESSION_ID   — session/tracking identifier
 *   ATOO_SOCKET_PATH  — path to Unix domain socket (default: ~/.atoo-studio/preload.sock)
 *
 * Graceful degradation: if socket or env vars are unavailable, all intercepted
 * functions pass through to real implementations with near-zero overhead.
 */

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

/* ── Real function pointers ─────────────────────────────────────────── */

static int     (*real_open)(const char *, int, ...)           = NULL;
static int     (*real_open64)(const char *, int, ...)         = NULL;
static int     (*real_openat)(int, const char *, int, ...)    = NULL;
static int     (*real_openat64)(int, const char *, int, ...)  = NULL;
static int     (*real_creat)(const char *, mode_t)            = NULL;
static int     (*real_rename)(const char *, const char *)     = NULL;
static int     (*real_renameat)(int, const char *, int, const char *)  = NULL;
static int     (*real_renameat2)(int, const char *, int, const char *, unsigned int) = NULL;
static int     (*real_unlink)(const char *)                   = NULL;
static int     (*real_unlinkat)(int, const char *, int)       = NULL;
static int     (*real_truncate)(const char *, off_t)          = NULL;
static int     (*real_ftruncate)(int, off_t)                  = NULL;

/* ── Global state ───────────────────────────────────────────────────── */

static char         g_session_id[256];
static char         g_socket_path[PATH_MAX];
static char         g_snapshot_dir[PATH_MAX];
static char         g_atoo_dir[PATH_MAX];   /* ~/.atoo-studio/ for exclusion */
static int          g_sock_fd = -1;
static int          g_initialized = 0;
static uint64_t     g_counter = 0;
static pthread_mutex_t g_mutex = PTHREAD_MUTEX_INITIALIZER;

/* Per-thread re-entrancy guard */
static __thread int in_hook = 0;

/* ── Snapshot set (simple open-addressing hash map) ─────────────────── */

#define SET_INIT_CAP 256

typedef struct {
    char **keys;
    int    cap;
    int    count;
} SnapSet;

static SnapSet g_snapped = { NULL, 0, 0 };

static unsigned int hash_str(const char *s) {
    unsigned int h = 5381;
    while (*s) h = h * 33 + (unsigned char)*s++;
    return h;
}

static int set_contains(SnapSet *set, const char *key) {
    if (!set->keys || set->cap == 0) return 0;
    unsigned int idx = hash_str(key) % (unsigned int)set->cap;
    for (int i = 0; i < set->cap; i++) {
        unsigned int pos = (idx + (unsigned int)i) % (unsigned int)set->cap;
        if (!set->keys[pos]) return 0;
        if (strcmp(set->keys[pos], key) == 0) return 1;
    }
    return 0;
}

static void set_grow(SnapSet *set);

static void set_insert(SnapSet *set, const char *key) {
    if (!set->keys) {
        set->cap = SET_INIT_CAP;
        set->keys = (char **)calloc((size_t)set->cap, sizeof(char *));
        if (!set->keys) return;
    }
    if (set->count * 2 >= set->cap) {
        set_grow(set);
    }
    unsigned int idx = hash_str(key) % (unsigned int)set->cap;
    for (int i = 0; i < set->cap; i++) {
        unsigned int pos = (idx + (unsigned int)i) % (unsigned int)set->cap;
        if (!set->keys[pos]) {
            set->keys[pos] = strdup(key);
            set->count++;
            return;
        }
        if (strcmp(set->keys[pos], key) == 0) return; /* already present */
    }
}

static void set_grow(SnapSet *set) {
    int old_cap = set->cap;
    char **old_keys = set->keys;
    set->cap *= 2;
    set->keys = (char **)calloc((size_t)set->cap, sizeof(char *));
    set->count = 0;
    if (!set->keys) {
        set->keys = old_keys;
        set->cap = old_cap;
        return;
    }
    for (int i = 0; i < old_cap; i++) {
        if (old_keys[i]) {
            set_insert(set, old_keys[i]);
            free(old_keys[i]);
        }
    }
    free(old_keys);
}

/* ── Helpers ────────────────────────────────────────────────────────── */

static int connect_socket(void) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, g_socket_path, sizeof(addr.sun_path) - 1);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}

static int ensure_socket(void) {
    if (g_sock_fd >= 0) return 0;
    g_sock_fd = connect_socket();
    return g_sock_fd >= 0 ? 0 : -1;
}

static int is_excluded(const char *abspath) {
    /* Skip our own snapshot/object directories */
    if (strncmp(abspath, g_atoo_dir, strlen(g_atoo_dir)) == 0) return 1;
    /* Skip virtual filesystems */
    if (strncmp(abspath, "/proc/", 6) == 0) return 1;
    if (strncmp(abspath, "/sys/", 5) == 0) return 1;
    if (strncmp(abspath, "/dev/", 5) == 0) return 1;
    if (strncmp(abspath, "/tmp/", 5) == 0) return 1;
    return 0;
}

/* Resolve a dirfd + pathname to an absolute path.
 * Returns 0 on success, -1 on failure. Result written to buf. */
static int resolve_path(int dirfd, const char *pathname, char *buf, size_t bufsz) {
    if (!pathname || !pathname[0]) return -1;

    if (pathname[0] == '/') {
        /* Already absolute */
        if (realpath(pathname, buf)) return 0;
        /* realpath fails if file doesn't exist yet — use as-is */
        strncpy(buf, pathname, bufsz - 1);
        buf[bufsz - 1] = '\0';
        return 0;
    }

    if (dirfd == AT_FDCWD) {
        /* Relative to CWD */
        char cwd[PATH_MAX];
        if (!getcwd(cwd, sizeof(cwd))) return -1;
        snprintf(buf, bufsz, "%s/%s", cwd, pathname);
        /* Try to canonicalize */
        char resolved[PATH_MAX];
        if (realpath(buf, resolved)) {
            strncpy(buf, resolved, bufsz - 1);
            buf[bufsz - 1] = '\0';
        }
        return 0;
    }

    /* Relative to dirfd — read link from /proc/self/fd/<dirfd> */
    char fdpath[64];
    snprintf(fdpath, sizeof(fdpath), "/proc/self/fd/%d", dirfd);
    char dirpath[PATH_MAX];
    ssize_t n = readlink(fdpath, dirpath, sizeof(dirpath) - 1);
    if (n < 0) return -1;
    dirpath[n] = '\0';
    snprintf(buf, bufsz, "%s/%s", dirpath, pathname);
    char resolved[PATH_MAX];
    if (realpath(buf, resolved)) {
        strncpy(buf, resolved, bufsz - 1);
        buf[bufsz - 1] = '\0';
    }
    return 0;
}

/* Copy a file using real_open to avoid recursive interception. */
static int copy_file(const char *src, const char *dst) {
    int sfd = real_open(src, O_RDONLY);
    if (sfd < 0) return -1;

    int dfd = real_open(dst, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (dfd < 0) {
        close(sfd);
        return -1;
    }

    char iobuf[65536];
    ssize_t nr;
    while ((nr = read(sfd, iobuf, sizeof(iobuf))) > 0) {
        ssize_t written = 0;
        while (written < nr) {
            ssize_t nw = write(dfd, iobuf + written, (size_t)(nr - written));
            if (nw < 0) {
                close(sfd);
                close(dfd);
                return -1;
            }
            written += nw;
        }
    }

    close(sfd);
    close(dfd);
    return nr < 0 ? -1 : 0;
}

/* Ensure parent directories exist for a given path. */
static void ensure_parent_dirs(const char *filepath) {
    char tmp[PATH_MAX];
    strncpy(tmp, filepath, sizeof(tmp) - 1);
    tmp[sizeof(tmp) - 1] = '\0';

    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            mkdir(tmp, 0755);
            *p = '/';
        }
    }
}

/* Get current timestamp as fractional seconds. */
static double now_ts(void) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

/* Escape a string for JSON (minimal: handle \, ", control chars). */
static int json_escape(const char *src, char *dst, size_t dstsz) {
    size_t di = 0;
    for (const char *s = src; *s && di < dstsz - 6; s++) {
        switch (*s) {
        case '\\': dst[di++] = '\\'; dst[di++] = '\\'; break;
        case '"':  dst[di++] = '\\'; dst[di++] = '"';  break;
        case '\n': dst[di++] = '\\'; dst[di++] = 'n';  break;
        case '\r': dst[di++] = '\\'; dst[di++] = 'r';  break;
        case '\t': dst[di++] = '\\'; dst[di++] = 't';  break;
        default:
            if ((unsigned char)*s < 0x20) {
                di += (size_t)snprintf(dst + di, dstsz - di, "\\u%04x", (unsigned char)*s);
            } else {
                dst[di++] = *s;
            }
        }
    }
    dst[di] = '\0';
    return (int)di;
}

/* Snapshot a file and send event to the monitor.
 * op: "write", "rename", "delete", "truncate"
 * path: absolute path of the target file
 * old_path: for rename, the source path (NULL otherwise)
 */
static void snapshot_and_report(const char *op, const char *abspath, const char *old_path) {
    if (!g_initialized) {
        fprintf(stderr, "[atoo-studio-preload] SKIP (not initialized): %s %s\n", op, abspath);
        return;
    }
    if (is_excluded(abspath)) {
        fprintf(stderr, "[atoo-studio-preload] SKIP (excluded): %s %s\n", op, abspath);
        return;
    }
    /* Don't exclude based on old_path — atomic writes rename from /tmp/ to final path */

    fprintf(stderr, "[atoo-studio-preload] EVENT: %s %s (old=%s)\n", op, abspath, old_path ? old_path : "none");

    pthread_mutex_lock(&g_mutex);

    /* Check if already snapshotted this path */
    if (set_contains(&g_snapped, abspath)) {
        fprintf(stderr, "[atoo-studio-preload] SKIP (already snapshotted): %s\n", abspath);
        pthread_mutex_unlock(&g_mutex);
        return;
    }

    /* Check if file exists before the operation */
    struct stat st;
    int file_existed = (stat(abspath, &st) == 0 && S_ISREG(st.st_mode));

    /* Snapshot the original if it exists */
    char snap_path[PATH_MAX];
    snap_path[0] = '\0';

    if (file_existed) {
        uint64_t cnt = g_counter++;
        snprintf(snap_path, sizeof(snap_path), "%s/%d_%lu",
                 g_snapshot_dir, (int)getpid(), (unsigned long)cnt);
        ensure_parent_dirs(snap_path);

        if (copy_file(abspath, snap_path) < 0) {
            snap_path[0] = '\0'; /* failed to snapshot */
        }
    }

    /* Mark as snapshotted */
    set_insert(&g_snapped, abspath);

    /* Build JSON event */
    char epath[PATH_MAX * 2], eold[PATH_MAX * 2], esnap[PATH_MAX * 2];
    json_escape(abspath, epath, sizeof(epath));
    if (old_path) json_escape(old_path, eold, sizeof(eold));
    if (snap_path[0]) json_escape(snap_path, esnap, sizeof(esnap));

    char msg[PATH_MAX * 8];
    int len = snprintf(msg, sizeof(msg),
        "{\"session_id\":\"%s\",\"op\":\"%s\",\"path\":\"%s\"",
        g_session_id, op, epath);

    if (old_path) {
        len += snprintf(msg + len, sizeof(msg) - (size_t)len,
            ",\"old_path\":\"%s\"", eold);
    }

    if (snap_path[0]) {
        len += snprintf(msg + len, sizeof(msg) - (size_t)len,
            ",\"snapshot\":\"%s\"", esnap);
    }

    len += snprintf(msg + len, sizeof(msg) - (size_t)len,
        ",\"file_existed\":%s,\"ts\":%.3f}\n",
        file_existed ? "true" : "false", now_ts());

    /* Send to socket */
    if (ensure_socket() == 0) {
        ssize_t wr = write(g_sock_fd, msg, (size_t)len);
        if (wr < 0) {
            fprintf(stderr, "[atoo-studio-preload] SOCKET WRITE FAILED: %s\n", strerror(errno));
            /* Connection lost, close and let next call retry */
            close(g_sock_fd);
            g_sock_fd = -1;
        } else {
            fprintf(stderr, "[atoo-studio-preload] SENT %zd bytes to socket\n", wr);
        }
    }

    pthread_mutex_unlock(&g_mutex);
}

/* ── Constructor ────────────────────────────────────────────────────── */

__attribute__((constructor))
static void preload_init(void) {
    /* Resolve real functions */
    real_open       = dlsym(RTLD_NEXT, "open");
    real_open64     = dlsym(RTLD_NEXT, "open64");
    real_openat     = dlsym(RTLD_NEXT, "openat");
    real_openat64   = dlsym(RTLD_NEXT, "openat64");
    real_creat      = dlsym(RTLD_NEXT, "creat");
    real_rename     = dlsym(RTLD_NEXT, "rename");
    real_renameat   = dlsym(RTLD_NEXT, "renameat");
    real_renameat2  = dlsym(RTLD_NEXT, "renameat2");
    real_unlink     = dlsym(RTLD_NEXT, "unlink");
    real_unlinkat   = dlsym(RTLD_NEXT, "unlinkat");
    real_truncate   = dlsym(RTLD_NEXT, "truncate");
    real_ftruncate  = dlsym(RTLD_NEXT, "ftruncate");

    /* Read config from environment */
    const char *sid = getenv("ATOO_SESSION_ID");
    if (!sid || !sid[0]) return; /* Not configured — pass through */

    strncpy(g_session_id, sid, sizeof(g_session_id) - 1);

    const char *sock = getenv("ATOO_SOCKET_PATH");
    if (sock && sock[0]) {
        strncpy(g_socket_path, sock, sizeof(g_socket_path) - 1);
    } else {
        const char *home = getenv("HOME");
        if (!home) return;
        snprintf(g_socket_path, sizeof(g_socket_path), "%s/.atoo-studio/preload.sock", home);
    }

    /* Set up atoo-studio dir for exclusion */
    const char *home = getenv("HOME");
    if (home) {
        snprintf(g_atoo_dir, sizeof(g_atoo_dir), "%s/.atoo-studio/", home);
    }

    /* Set up snapshot directory */
    snprintf(g_snapshot_dir, sizeof(g_snapshot_dir), "%s/.atoo-studio/snapshots/%s",
             home ? home : "/tmp", g_session_id);

    /* Create snapshot directory (best effort) */
    in_hook = 1;
    ensure_parent_dirs(g_snapshot_dir);
    mkdir(g_snapshot_dir, 0755);
    in_hook = 0;

    /* Try to connect (non-fatal if fails) */
    g_sock_fd = connect_socket();

    g_initialized = 1;
    fprintf(stderr, "[atoo-studio-preload] INIT pid=%d session=%s socket=%s connected=%d\n",
            (int)getpid(), g_session_id, g_socket_path, g_sock_fd >= 0);
}

/* ── Intercepted functions ──────────────────────────────────────────── */

int open(const char *pathname, int flags, ...) {
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }

    if (!in_hook && g_initialized && (flags & (O_WRONLY | O_RDWR | O_TRUNC | O_CREAT))) {
        in_hook = 1;
        char abspath[PATH_MAX];
        if (pathname && resolve_path(AT_FDCWD, pathname, abspath, sizeof(abspath)) == 0) {
            snapshot_and_report("write", abspath, NULL);
        }
        in_hook = 0;
    }

    return real_open(pathname, flags, mode);
}

int openat(int dirfd, const char *pathname, int flags, ...) {
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }

    if (!in_hook && g_initialized && (flags & (O_WRONLY | O_RDWR | O_TRUNC | O_CREAT))) {
        in_hook = 1;
        char abspath[PATH_MAX];
        if (pathname && resolve_path(dirfd, pathname, abspath, sizeof(abspath)) == 0) {
            snapshot_and_report("write", abspath, NULL);
        }
        in_hook = 0;
    }

    return real_openat(dirfd, pathname, flags, mode);
}

int open64(const char *pathname, int flags, ...) {
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }

    if (!in_hook && g_initialized && (flags & (O_WRONLY | O_RDWR | O_TRUNC | O_CREAT))) {
        in_hook = 1;
        char abspath[PATH_MAX];
        if (resolve_path(AT_FDCWD, pathname, abspath, sizeof(abspath)) == 0) {
            snapshot_and_report("write", abspath, NULL);
        }
        in_hook = 0;
    }

    return real_open64 ? real_open64(pathname, flags, mode) : real_open(pathname, flags, mode);
}

int openat64(int dirfd, const char *pathname, int flags, ...) {
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }

    if (!in_hook && g_initialized && (flags & (O_WRONLY | O_RDWR | O_TRUNC | O_CREAT))) {
        in_hook = 1;
        char abspath[PATH_MAX];
        if (resolve_path(dirfd, pathname, abspath, sizeof(abspath)) == 0) {
            snapshot_and_report("write", abspath, NULL);
        }
        in_hook = 0;
    }

    return real_openat64 ? real_openat64(dirfd, pathname, flags, mode) : real_openat(dirfd, pathname, flags, mode);
}

int creat(const char *pathname, mode_t mode) {
    if (!in_hook && g_initialized) {
        in_hook = 1;
        char abspath[PATH_MAX];
        if (pathname && resolve_path(AT_FDCWD, pathname, abspath, sizeof(abspath)) == 0) {
            snapshot_and_report("write", abspath, NULL);
        }
        in_hook = 0;
    }

    return real_creat(pathname, mode);
}

int rename(const char *oldpath, const char *newpath) {
    if (!in_hook && g_initialized) {
        in_hook = 1;
        char abs_new[PATH_MAX];
        char abs_old[PATH_MAX];
        int new_ok = newpath && resolve_path(AT_FDCWD, newpath, abs_new, sizeof(abs_new)) == 0;
        int old_ok = oldpath && resolve_path(AT_FDCWD, oldpath, abs_old, sizeof(abs_old)) == 0;
        if (new_ok) {
            snapshot_and_report("rename", abs_new, old_ok ? abs_old : NULL);
        }
        in_hook = 0;
    }

    return real_rename(oldpath, newpath);
}

int renameat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath) {
    if (!in_hook && g_initialized) {
        in_hook = 1;
        char abs_new[PATH_MAX];
        char abs_old[PATH_MAX];
        int new_ok = newpath && resolve_path(newdirfd, newpath, abs_new, sizeof(abs_new)) == 0;
        int old_ok = oldpath && resolve_path(olddirfd, oldpath, abs_old, sizeof(abs_old)) == 0;
        if (new_ok) {
            snapshot_and_report("rename", abs_new, old_ok ? abs_old : NULL);
        }
        in_hook = 0;
    }

    return real_renameat(olddirfd, oldpath, newdirfd, newpath);
}

int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags) {
    if (!in_hook && g_initialized && real_renameat2) {
        in_hook = 1;
        char abs_new[PATH_MAX];
        char abs_old[PATH_MAX];
        int new_ok = newpath && resolve_path(newdirfd, newpath, abs_new, sizeof(abs_new)) == 0;
        int old_ok = oldpath && resolve_path(olddirfd, oldpath, abs_old, sizeof(abs_old)) == 0;
        if (new_ok) {
            snapshot_and_report("rename", abs_new, old_ok ? abs_old : NULL);
        }
        in_hook = 0;
    }

    if (real_renameat2) return real_renameat2(olddirfd, oldpath, newdirfd, newpath, flags);
    /* Fallback if renameat2 not available */
    errno = ENOSYS;
    return -1;
}

int unlink(const char *pathname) {
    if (!in_hook && g_initialized) {
        in_hook = 1;
        char abspath[PATH_MAX];
        if (pathname && resolve_path(AT_FDCWD, pathname, abspath, sizeof(abspath)) == 0) {
            snapshot_and_report("delete", abspath, NULL);
        }
        in_hook = 0;
    }

    return real_unlink(pathname);
}

int unlinkat(int dirfd, const char *pathname, int flags) {
    if (!in_hook && g_initialized && !(flags & AT_REMOVEDIR)) {
        in_hook = 1;
        char abspath[PATH_MAX];
        if (pathname && resolve_path(dirfd, pathname, abspath, sizeof(abspath)) == 0) {
            snapshot_and_report("delete", abspath, NULL);
        }
        in_hook = 0;
    }

    return real_unlinkat(dirfd, pathname, flags);
}

int truncate(const char *path, off_t length) {
    if (!in_hook && g_initialized) {
        in_hook = 1;
        char abspath[PATH_MAX];
        if (path && resolve_path(AT_FDCWD, path, abspath, sizeof(abspath)) == 0) {
            snapshot_and_report("truncate", abspath, NULL);
        }
        in_hook = 0;
    }

    return real_truncate(path, length);
}

int ftruncate(int fd, off_t length) {
    if (!in_hook && g_initialized) {
        in_hook = 1;
        /* Resolve fd to path via /proc/self/fd/<fd> */
        char fdlink[64];
        char abspath[PATH_MAX];
        snprintf(fdlink, sizeof(fdlink), "/proc/self/fd/%d", fd);
        ssize_t n = readlink(fdlink, abspath, sizeof(abspath) - 1);
        if (n > 0) {
            abspath[n] = '\0';
            snapshot_and_report("truncate", abspath, NULL);
        }
        in_hook = 0;
    }

    return real_ftruncate(fd, length);
}
