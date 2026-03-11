CC = gcc
CFLAGS = -shared -fPIC -Wall -Wextra -O2 -D_GNU_SOURCE
LDFLAGS = -ldl -lpthread
TARGET = atoo-studio-preload.so

$(TARGET): atoo-studio-preload.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

clean:
	rm -f $(TARGET)

.PHONY: clean
