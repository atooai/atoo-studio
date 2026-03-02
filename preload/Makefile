CC = gcc
CFLAGS = -shared -fPIC -Wall -Wextra -O2 -D_GNU_SOURCE
LDFLAGS = -ldl -lpthread
TARGET = ccproxy-preload.so

$(TARGET): ccproxy-preload.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

clean:
	rm -f $(TARGET)

.PHONY: clean
