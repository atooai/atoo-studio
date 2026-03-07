/*
 * cuse_serial - CUSE-based virtual serial device with modem control signal support.
 *
 * Creates a /dev/ttyVS<n> character device that behaves like a serial port,
 * including support for TIOCMSET/TIOCMGET ioctls (DTR/RTS signals).
 *
 * Communicates with the parent process via stdin/stdout using a simple
 * framed protocol:
 *
 *   Frame: [type:1][len:2 BE][payload:len]
 *
 *   Child → Parent (stdout):
 *     0x00 = serial data (tool wrote to device)
 *     0x01 = modem signals changed (tool called TIOCMSET/BIS/BIC)
 *     0x02 = device ready (payload = device path)
 *     0x03 = error (payload = message)
 *
 *   Parent → Child (stdin):
 *     0x00 = serial data (available for tool to read)
 *
 * Build: gcc -Wall -O2 cuse_serial.c -o cuse_serial $(pkg-config --cflags --libs fuse3) -lpthread
 * Usage: cuse_serial --name=ttyVS0 -f
 *
 * Requires: /dev/cuse accessible, CAP_SYS_ADMIN capability or root.
 */

#define FUSE_USE_VERSION 31
#define _GNU_SOURCE

#include <cuse_lowlevel.h>
#include <fuse_lowlevel.h>
#include <fuse_opt.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <poll.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <stddef.h>
#include <termios.h>

/* Internal pipe: stdin reader thread writes data here, CUSE read callback reads from here */
static int data_pipe[2] = {-1, -1};

/* Modem control bits (set by tool via TIOCMSET/BIS/BIC, read via TIOCMGET) */
static int modem_bits = 0;
static pthread_mutex_t modem_mutex = PTHREAD_MUTEX_INITIALIZER;

/* Emulated termios (tools may get/set this) */
static struct termios current_termios;

/* FUSE session reference for poll notifications */
static struct fuse_session *g_session = NULL;
static struct fuse_pollhandle *g_poll_ph = NULL;
static pthread_mutex_t poll_mutex = PTHREAD_MUTEX_INITIALIZER;

/* Protect stdout writes (frames sent to parent) */
static pthread_mutex_t stdout_mutex = PTHREAD_MUTEX_INITIALIZER;

/* Device name for the ready message */
static char g_dev_path[256] = "";

/* ---- Frame protocol ---- */

static void send_frame(uint8_t type, const void *data, uint16_t len) {
    uint8_t header[3] = { type, (uint8_t)((len >> 8) & 0xFF), (uint8_t)(len & 0xFF) };
    pthread_mutex_lock(&stdout_mutex);
    (void)!write(STDOUT_FILENO, header, 3);
    if (len > 0 && data) (void)!write(STDOUT_FILENO, data, len);
    pthread_mutex_unlock(&stdout_mutex);
}

static int read_exact(int fd, void *buf, size_t count) {
    size_t got = 0;
    while (got < count) {
        ssize_t r = read(fd, (char *)buf + got, count - got);
        if (r <= 0) return -1;
        got += (size_t)r;
    }
    return 0;
}

/* ---- Poll notification ---- */

static void notify_poll_wakeup(void) {
    pthread_mutex_lock(&poll_mutex);
    if (g_poll_ph) {
        fuse_lowlevel_notify_poll(g_poll_ph);
        fuse_pollhandle_destroy(g_poll_ph);
        g_poll_ph = NULL;
    }
    pthread_mutex_unlock(&poll_mutex);
}

/* ---- Stdin reader thread ---- */

static void *stdin_reader(void *arg) {
    (void)arg;
    uint8_t header[3];

    while (1) {
        if (read_exact(STDIN_FILENO, header, 3) < 0) break;

        uint8_t type = header[0];
        uint16_t len = (uint16_t)((header[1] << 8) | header[2]);

        uint8_t *payload = NULL;
        if (len > 0) {
            payload = malloc(len);
            if (!payload) break;
            if (read_exact(STDIN_FILENO, payload, len) < 0) { free(payload); break; }
        }

        if (type == 0x00 && payload && len > 0) {
            /* Serial data from parent → available for tool to read */
            (void)!write(data_pipe[1], payload, len);
            notify_poll_wakeup();
        }

        free(payload);
    }

    /* stdin closed — exit */
    close(data_pipe[1]);
    if (g_session) fuse_session_exit(g_session);
    return NULL;
}

/* ---- Modem signal helpers ---- */

static void send_modem_update(int bits) {
    uint8_t sig = 0;
    if (bits & TIOCM_DTR) sig |= 0x01;
    if (bits & TIOCM_RTS) sig |= 0x02;
    send_frame(0x01, &sig, 1);
}

/* ---- CUSE callbacks ---- */

static void serial_open(fuse_req_t req, struct fuse_file_info *fi) {
    fi->nonseekable = 1;
    fi->direct_io = 1;
    fuse_reply_open(req, fi);
}

static void serial_release(fuse_req_t req, struct fuse_file_info *fi) {
    (void)fi;
    fuse_reply_err(req, 0);
}

static void serial_read(fuse_req_t req, size_t size, off_t off,
                         struct fuse_file_info *fi) {
    (void)off;
    char buf[65536];
    size_t to_read = size < sizeof(buf) ? size : sizeof(buf);

    if (fi->flags & O_NONBLOCK) {
        ssize_t n = read(data_pipe[0], buf, to_read);
        if (n <= 0) {
            fuse_reply_err(req, EAGAIN);
        } else {
            fuse_reply_buf(req, buf, (size_t)n);
        }
    } else {
        /* Blocking: wait for data. Multi-threaded FUSE allows blocking here. */
        struct pollfd pfd = { data_pipe[0], POLLIN, 0 };
        int ret = poll(&pfd, 1, 30000); /* 30s timeout to avoid infinite hang */
        if (ret <= 0) {
            fuse_reply_err(req, ret == 0 ? EAGAIN : EIO);
            return;
        }
        ssize_t n = read(data_pipe[0], buf, to_read);
        if (n <= 0) {
            fuse_reply_err(req, EIO);
        } else {
            fuse_reply_buf(req, buf, (size_t)n);
        }
    }
}

static void serial_write(fuse_req_t req, const char *buf, size_t size,
                          off_t off, struct fuse_file_info *fi) {
    (void)off;
    (void)fi;
    /* Forward written data to parent (Node.js → browser → physical device) */
    size_t total = size;
    while (size > 0) {
        uint16_t chunk = size > 65535 ? 65535 : (uint16_t)size;
        send_frame(0x00, buf, chunk);
        buf += chunk;
        size -= chunk;
    }
    fuse_reply_write(req, total);
}

static void serial_ioctl(fuse_req_t req, int cmd, void *arg,
                          struct fuse_file_info *fi, unsigned flags,
                          const void *in_buf, size_t in_bufsz, size_t out_bufsz) {
    (void)fi;

    if (flags & FUSE_IOCTL_COMPAT) {
        fuse_reply_err(req, ENOSYS);
        return;
    }

    switch (cmd) {

    /* ---- Modem control signals ---- */

    case TIOCMGET:
        if (!out_bufsz) {
            struct iovec iov = { arg, sizeof(int) };
            fuse_reply_ioctl_retry(req, NULL, 0, &iov, 1);
        } else {
            pthread_mutex_lock(&modem_mutex);
            int bits = modem_bits;
            pthread_mutex_unlock(&modem_mutex);
            fuse_reply_ioctl(req, 0, &bits, sizeof(int));
        }
        break;

    case TIOCMSET:
        if (!in_bufsz) {
            struct iovec iov = { arg, sizeof(int) };
            fuse_reply_ioctl_retry(req, &iov, 1, NULL, 0);
        } else {
            int new_bits = *(const int *)in_buf;
            pthread_mutex_lock(&modem_mutex);
            int old_bits = modem_bits;
            modem_bits = new_bits;
            pthread_mutex_unlock(&modem_mutex);
            if (new_bits != old_bits) send_modem_update(new_bits);
            fuse_reply_ioctl(req, 0, NULL, 0);
        }
        break;

    case TIOCMBIS:
        if (!in_bufsz) {
            struct iovec iov = { arg, sizeof(int) };
            fuse_reply_ioctl_retry(req, &iov, 1, NULL, 0);
        } else {
            int set = *(const int *)in_buf;
            pthread_mutex_lock(&modem_mutex);
            int old = modem_bits;
            modem_bits |= set;
            int cur = modem_bits;
            pthread_mutex_unlock(&modem_mutex);
            if (cur != old) send_modem_update(cur);
            fuse_reply_ioctl(req, 0, NULL, 0);
        }
        break;

    case TIOCMBIC:
        if (!in_bufsz) {
            struct iovec iov = { arg, sizeof(int) };
            fuse_reply_ioctl_retry(req, &iov, 1, NULL, 0);
        } else {
            int clr = *(const int *)in_buf;
            pthread_mutex_lock(&modem_mutex);
            int old = modem_bits;
            modem_bits &= ~clr;
            int cur = modem_bits;
            pthread_mutex_unlock(&modem_mutex);
            if (cur != old) send_modem_update(cur);
            fuse_reply_ioctl(req, 0, NULL, 0);
        }
        break;

    /* ---- Termios ---- */

    case TCGETS:
        if (!out_bufsz) {
            struct iovec iov = { arg, sizeof(struct termios) };
            fuse_reply_ioctl_retry(req, NULL, 0, &iov, 1);
        } else {
            fuse_reply_ioctl(req, 0, &current_termios, sizeof(struct termios));
        }
        break;

    case TCSETS:
    case TCSETSW:
    case TCSETSF:
        if (!in_bufsz) {
            struct iovec iov = { arg, sizeof(struct termios) };
            fuse_reply_ioctl_retry(req, &iov, 1, NULL, 0);
        } else {
            memcpy(&current_termios, in_buf, sizeof(struct termios));
            fuse_reply_ioctl(req, 0, NULL, 0);
        }
        break;

    /* ---- Misc ---- */

    case FIONREAD: {
        if (!out_bufsz) {
            struct iovec iov = { arg, sizeof(int) };
            fuse_reply_ioctl_retry(req, NULL, 0, &iov, 1);
        } else {
            int avail = 0;
            ioctl(data_pipe[0], FIONREAD, &avail);
            fuse_reply_ioctl(req, 0, &avail, sizeof(int));
        }
        break;
    }

    case TIOCEXCL:
    case TIOCNXCL:
    case TIOCSBRK:
    case TIOCCBRK:
        fuse_reply_ioctl(req, 0, NULL, 0);
        break;

    default:
        fuse_reply_err(req, ENOTTY);
    }
}

static void serial_poll(fuse_req_t req, struct fuse_file_info *fi,
                         struct fuse_pollhandle *ph) {
    (void)fi;
    unsigned revents = POLLOUT; /* Always writable */

    int avail = 0;
    ioctl(data_pipe[0], FIONREAD, &avail);
    if (avail > 0) revents |= POLLIN;

    if (ph) {
        pthread_mutex_lock(&poll_mutex);
        if (g_poll_ph) fuse_pollhandle_destroy(g_poll_ph);
        g_poll_ph = ph;
        pthread_mutex_unlock(&poll_mutex);
    }

    fuse_reply_poll(req, revents);
}

static void serial_init_done(void *userdata) {
    (void)userdata;
    /* Device is now created in /dev — notify parent */
    send_frame(0x02, g_dev_path, (uint16_t)strlen(g_dev_path));
}

/* ---- CUSE ops ---- */

static const struct cuse_lowlevel_ops serial_ops = {
    .init_done = serial_init_done,
    .open      = serial_open,
    .release   = serial_release,
    .read      = serial_read,
    .write     = serial_write,
    .ioctl     = serial_ioctl,
    .poll      = serial_poll,
};

/* ---- Argument parsing ---- */

struct serial_param {
    unsigned major;
    unsigned minor;
    char *dev_name;
    int is_help;
};

#define OPT(t, p) { t, offsetof(struct serial_param, p), 1 }

static const struct fuse_opt serial_opts[] = {
    OPT("-M %u",       major),
    OPT("--maj=%u",    major),
    OPT("-m %u",       minor),
    OPT("--min=%u",    minor),
    OPT("-n %s",       dev_name),
    OPT("--name=%s",   dev_name),
    FUSE_OPT_KEY("-h",     0),
    FUSE_OPT_KEY("--help", 0),
    FUSE_OPT_END
};

static int opt_proc(void *data, const char *arg, int key,
                    struct fuse_args *outargs) {
    struct serial_param *p = data;
    (void)arg;
    if (key == 0) {
        p->is_help = 1;
        fprintf(stderr,
            "Usage: cuse_serial [options]\n"
            "  --name=NAME|-n NAME   device name (e.g. ttyVS0) [mandatory]\n"
            "  --maj=MAJ|-M MAJ      device major number\n"
            "  --min=MIN|-m MIN      device minor number\n"
            "  -f                    foreground\n"
            "  -d                    debug\n");
        return fuse_opt_add_arg(outargs, "-ho");
    }
    return 1;
}

/* ---- Main ---- */

int main(int argc, char **argv) {
    struct fuse_args args = FUSE_ARGS_INIT(argc, argv);
    struct serial_param param = { 0, 0, NULL, 0 };
    int ret = 1;

    if (fuse_opt_parse(&args, &param, serial_opts, opt_proc)) {
        fprintf(stderr, "Failed to parse options\n");
        goto out;
    }

    if (param.is_help) { ret = 0; goto out; }

    if (!param.dev_name) {
        fprintf(stderr, "Error: device name required (--name=ttyVS0)\n");
        goto out;
    }

    /* Build device path for ready message */
    snprintf(g_dev_path, sizeof(g_dev_path), "/dev/%s", param.dev_name);

    /* Initialize emulated termios to raw mode, 115200 baud */
    memset(&current_termios, 0, sizeof(current_termios));
    cfmakeraw(&current_termios);
    cfsetispeed(&current_termios, B115200);
    cfsetospeed(&current_termios, B115200);

    /* Create internal data pipe (non-blocking read end) */
    if (pipe(data_pipe) < 0) {
        perror("pipe");
        goto out;
    }
    fcntl(data_pipe[0], F_SETFL, O_NONBLOCK);
    /* Set pipe buffer size large enough */
    fcntl(data_pipe[0], F_SETPIPE_SZ, 1048576);

    /* Make stdin blocking (should already be, but be safe) */
    fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) & ~O_NONBLOCK);

    /* Start stdin reader thread */
    pthread_t reader_tid;
    if (pthread_create(&reader_tid, NULL, stdin_reader, NULL) != 0) {
        perror("pthread_create");
        goto out;
    }
    pthread_detach(reader_tid);

    /* Set up CUSE device */
    char dev_info_str[256];
    snprintf(dev_info_str, sizeof(dev_info_str), "DEVNAME=%s", param.dev_name);
    const char *dev_info_argv[] = { dev_info_str };

    struct cuse_info ci;
    memset(&ci, 0, sizeof(ci));
    ci.dev_major = param.major;
    ci.dev_minor = param.minor;
    ci.dev_info_argc = 1;
    ci.dev_info_argv = dev_info_argv;
    ci.flags = CUSE_UNRESTRICTED_IOCTL;

    /* Use cuse_lowlevel_setup so we can get the session handle */
    int multithreaded;
    g_session = cuse_lowlevel_setup(args.argc, args.argv,
                                     &ci, &serial_ops, &multithreaded, NULL);
    if (!g_session) {
        send_frame(0x03, "CUSE setup failed", 17);
        goto out;
    }

    /* Run the FUSE event loop */
    if (multithreaded)
        ret = fuse_session_loop_mt(g_session, 0);
    else
        ret = fuse_session_loop(g_session);

    cuse_lowlevel_teardown(g_session);

out:
    if (data_pipe[0] >= 0) close(data_pipe[0]);
    if (data_pipe[1] >= 0) close(data_pipe[1]);
    free(param.dev_name);
    fuse_opt_free_args(&args);
    return ret;
}
