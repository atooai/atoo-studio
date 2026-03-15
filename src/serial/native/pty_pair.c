#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <node_api.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <termios.h>
#include <sys/ioctl.h>

// Helper: throw JS error and return NULL
#define NAPI_THROW(env, msg) do { \
  napi_throw_error(env, NULL, msg); \
  return NULL; \
} while (0)

#define NAPI_CHECK(env, status) do { \
  if ((status) != napi_ok) { \
    napi_throw_error(env, NULL, "N-API call failed"); \
    return NULL; \
  } \
} while (0)

// createPtyPair() -> { masterFd: number, slavePath: string }
static napi_value CreatePtyPair(napi_env env, napi_callback_info info) {
  (void)info;

  // Open the PTY master
  int master_fd = posix_openpt(O_RDWR | O_NOCTTY);
  if (master_fd < 0) {
    char buf[256];
    snprintf(buf, sizeof(buf), "posix_openpt failed: %s", strerror(errno));
    NAPI_THROW(env, buf);
  }

  if (grantpt(master_fd) < 0) {
    close(master_fd);
    NAPI_THROW(env, "grantpt failed");
  }

  if (unlockpt(master_fd) < 0) {
    close(master_fd);
    NAPI_THROW(env, "unlockpt failed");
  }

  char *slave_name = ptsname(master_fd);
  if (!slave_name) {
    close(master_fd);
    NAPI_THROW(env, "ptsname failed");
  }

  // Open slave briefly to configure raw mode, then close
  int slave_fd = open(slave_name, O_RDWR | O_NOCTTY);
  if (slave_fd >= 0) {
    struct termios tio;
    if (tcgetattr(slave_fd, &tio) == 0) {
      cfmakeraw(&tio);
      tcsetattr(slave_fd, TCSANOW, &tio);
    }
    close(slave_fd);
  }

  // Also set raw mode on master side
  struct termios mtio;
  if (tcgetattr(master_fd, &mtio) == 0) {
    cfmakeraw(&mtio);
    tcsetattr(master_fd, TCSANOW, &mtio);
  }

  // Set master fd to non-blocking
  int flags = fcntl(master_fd, F_GETFL);
  if (flags >= 0) {
    fcntl(master_fd, F_SETFL, flags | O_NONBLOCK);
  }

  // Build result object
  napi_value result, fd_val, path_val;
  NAPI_CHECK(env, napi_create_object(env, &result));
  NAPI_CHECK(env, napi_create_int32(env, master_fd, &fd_val));
  NAPI_CHECK(env, napi_create_string_utf8(env, slave_name, NAPI_AUTO_LENGTH, &path_val));
  NAPI_CHECK(env, napi_set_named_property(env, result, "masterFd", fd_val));
  NAPI_CHECK(env, napi_set_named_property(env, result, "slavePath", path_val));

  return result;
}

// getModemBits(masterFd: number) -> { dtr: boolean, rts: boolean }
static napi_value GetModemBits(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (argc < 1) NAPI_THROW(env, "getModemBits requires masterFd argument");

  int32_t fd;
  NAPI_CHECK(env, napi_get_value_int32(env, argv[0], &fd));

  int bits = 0;
  if (ioctl(fd, TIOCMGET, &bits) < 0) {
    // PTYs may not support TIOCMGET — return defaults
    bits = 0;
  }

  napi_value result, dtr_val, rts_val;
  NAPI_CHECK(env, napi_create_object(env, &result));
  NAPI_CHECK(env, napi_get_boolean(env, (bits & TIOCM_DTR) != 0, &dtr_val));
  NAPI_CHECK(env, napi_get_boolean(env, (bits & TIOCM_RTS) != 0, &rts_val));
  NAPI_CHECK(env, napi_set_named_property(env, result, "dtr", dtr_val));
  NAPI_CHECK(env, napi_set_named_property(env, result, "rts", rts_val));

  return result;
}

// setModemBits(masterFd: number, dtr: boolean, rts: boolean) -> void
// Used to set modem bits on the master (so slave-side tools see them)
static napi_value SetModemBits(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  NAPI_CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (argc < 3) NAPI_THROW(env, "setModemBits requires (masterFd, dtr, rts)");

  int32_t fd;
  bool dtr, rts;
  NAPI_CHECK(env, napi_get_value_int32(env, argv[0], &fd));
  NAPI_CHECK(env, napi_get_value_bool(env, argv[1], &dtr));
  NAPI_CHECK(env, napi_get_value_bool(env, argv[2], &rts));

  int bits = 0;
  if (dtr) bits |= TIOCM_DTR;
  if (rts) bits |= TIOCM_RTS;

  ioctl(fd, TIOCMSET, &bits);  // May fail on PTYs - that's OK

  return NULL;
}

// readMaster(masterFd: number, buffer: Buffer) -> number (bytes read, 0 if EAGAIN, -1 if closed)
static napi_value ReadMaster(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (argc < 2) NAPI_THROW(env, "readMaster requires (masterFd, buffer)");

  int32_t fd;
  NAPI_CHECK(env, napi_get_value_int32(env, argv[0], &fd));

  void *buf;
  size_t buf_len;
  NAPI_CHECK(env, napi_get_buffer_info(env, argv[1], &buf, &buf_len));

  ssize_t n = read(fd, buf, buf_len);
  int32_t result_val;
  if (n < 0) {
    result_val = (errno == EAGAIN || errno == EWOULDBLOCK) ? 0 : -1;
  } else {
    result_val = (int32_t)n;
  }

  napi_value result;
  NAPI_CHECK(env, napi_create_int32(env, result_val, &result));
  return result;
}

// writeMaster(masterFd: number, buffer: Buffer, length: number) -> number (bytes written)
static napi_value WriteMaster(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  NAPI_CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (argc < 3) NAPI_THROW(env, "writeMaster requires (masterFd, buffer, length)");

  int32_t fd, length;
  NAPI_CHECK(env, napi_get_value_int32(env, argv[0], &fd));

  void *buf;
  size_t buf_len;
  NAPI_CHECK(env, napi_get_buffer_info(env, argv[1], &buf, &buf_len));
  NAPI_CHECK(env, napi_get_value_int32(env, argv[2], &length));

  size_t to_write = (size_t)length < buf_len ? (size_t)length : buf_len;
  ssize_t n = write(fd, buf, to_write);

  napi_value result;
  NAPI_CHECK(env, napi_create_int32(env, n < 0 ? -1 : (int32_t)n, &result));
  return result;
}

// closeFd(fd: number) -> void
static napi_value CloseFd(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  NAPI_CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));

  if (argc < 1) NAPI_THROW(env, "closeFd requires fd argument");

  int32_t fd;
  NAPI_CHECK(env, napi_get_value_int32(env, argv[0], &fd));

  close(fd);
  return NULL;
}

// Module init
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"createPtyPair", NULL, CreatePtyPair, NULL, NULL, NULL, napi_default, NULL},
    {"getModemBits", NULL, GetModemBits, NULL, NULL, NULL, napi_default, NULL},
    {"setModemBits", NULL, SetModemBits, NULL, NULL, NULL, napi_default, NULL},
    {"readMaster", NULL, ReadMaster, NULL, NULL, NULL, napi_default, NULL},
    {"writeMaster", NULL, WriteMaster, NULL, NULL, NULL, napi_default, NULL},
    {"closeFd", NULL, CloseFd, NULL, NULL, NULL, napi_default, NULL},
  };
  NAPI_CHECK(env, napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props));
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
