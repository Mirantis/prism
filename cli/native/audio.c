/* IPC: one type byte, four-byte little-endian length, then payload.
 * Input: 1 PCM, 2 clear, 3 mute (one byte), 4 stop.
 * Output: 1 captured PCM, 2 ready. EOF releases the devices.
 */
#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#define MA_NO_GENERATION
#define MA_NO_NULL
#define MINIAUDIO_IMPLEMENTATION
#include "vendor/miniaudio.h"
#include <stdio.h>
#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#endif

#define RATE 24000
#define FRAME 480
#define CAPACITY RATE
static ma_mutex lock;
static ma_int16 capture[CAPACITY], playback[CAPACITY];
static unsigned cr, cw, cn, pr, pw, pn;
static int muted, stopping, failed;

static int packet(unsigned char type, const void* data, unsigned length) {
    unsigned char header[5] = {type, length & 255, (length >> 8) & 255,
                              (length >> 16) & 255, (length >> 24) & 255};
    return fwrite(header, 1, 5, stdout) == 5 &&
           (!length || fwrite(data, 1, length, stdout) == length) && fflush(stdout) == 0;
}

static void audio(ma_device* device, void* output, const void* input, ma_uint32 count) {
    ma_int16* out = output;
    const ma_int16* in = input;
    (void)device;
    memset(output, 0, count * sizeof(ma_int16));
    ma_mutex_lock(&lock);
    for (ma_uint32 i = 0; i < count; i++) {
        out[i] = pn ? playback[pr] : 0;
        if (pn) { pr = (pr + 1) % CAPACITY; pn--; }
        if (!muted && in) {
            if (cn == CAPACITY) { failed = 1; break; }
            capture[cw] = in[i]; cw = (cw + 1) % CAPACITY; cn++;
        }
    }
    ma_mutex_unlock(&lock);
}

static void notification(const ma_device_notification* event) {
    if (event->type != ma_device_notification_type_stopped &&
        event->type != ma_device_notification_type_interruption_began) return;
    ma_mutex_lock(&lock);
    if (!stopping) failed = 1;
    ma_mutex_unlock(&lock);
}

/* miniaudio's pinned platform thread wrapper keeps the helper portable. */
static ma_thread_result MA_THREADCALL writer(void* unused) {
    ma_int16 frame[FRAME];
    (void)unused;
    for (;;) {
        unsigned n = 0;
        ma_mutex_lock(&lock);
        int done = stopping, error = failed;
        if (cn >= FRAME) {
            for (; n < FRAME; n++) { frame[n] = capture[cr]; cr = (cr + 1) % CAPACITY; }
            cn -= FRAME;
        }
        ma_mutex_unlock(&lock);
        if (error) exit(3);
        if (done) return 0;
        if (n && !packet(1, frame, sizeof(frame))) exit(3);
        ma_sleep(5);
    }
}

int main(int argc, char** argv) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    ma_context context;
    if (ma_context_init(NULL, 0, NULL, &context) != MA_SUCCESS) return 1;
    ma_device_info *outputs, *inputs;
    ma_uint32 outputCount, inputCount;
    if (ma_context_get_devices(&context, &outputs, &outputCount, &inputs, &inputCount) != MA_SUCCESS) {
        ma_context_uninit(&context); return 1;
    }
    ma_device_id *inputId = NULL, *outputId = NULL;
    for (ma_uint32 i = 0; i < inputCount; i++) {
        /* PulseAudio monitor sources represent speaker output. */
        if (context.backend == ma_backend_pulseaudio &&
            (strstr(inputs[i].id.pulse, ".monitor") || strstr(inputs[i].name, "Monitor of"))) continue;
        if (!inputId || inputs[i].isDefault) inputId = &inputs[i].id;
        if (inputs[i].isDefault) break;
    }
    for (ma_uint32 i = 0; i < outputCount; i++) {
        if (!outputId || outputs[i].isDefault) outputId = &outputs[i].id;
        if (outputs[i].isDefault) break;
    }
    if (!inputId || !outputId) { ma_context_uninit(&context); return 1; }
    if (argc == 2 && strcmp(argv[1], "--probe") == 0) {
        ma_context_uninit(&context); return 0;
    }
    if (ma_mutex_init(&lock) != MA_SUCCESS) { ma_context_uninit(&context); return 1; }
    ma_device_config config = ma_device_config_init(ma_device_type_duplex);
    config.capture.pDeviceID = inputId;
    config.playback.pDeviceID = outputId;
    config.capture.format = config.playback.format = ma_format_s16;
    config.capture.channels = config.playback.channels = 1;
    config.sampleRate = RATE;
    config.periodSizeInFrames = FRAME;
    config.dataCallback = audio;
    config.notificationCallback = notification;
    ma_device device;
    if (ma_device_init(&context, &config, &device) != MA_SUCCESS) {
        ma_mutex_uninit(&lock); ma_context_uninit(&context); return 2;
    }
    if (ma_device_start(&device) != MA_SUCCESS) {
        ma_device_uninit(&device); ma_mutex_uninit(&lock); ma_context_uninit(&context); return 2;
    }
    if (!packet(2, NULL, 0)) return 3;
    ma_thread thread;
    if (ma_thread_create(&thread, ma_thread_priority_normal, 0, writer, NULL, NULL) != MA_SUCCESS) return 3;
    unsigned char header[5], payload[48000];
    while (fread(header, 1, 5, stdin) == 5) {
        unsigned length = (unsigned)header[1] | ((unsigned)header[2] << 8) |
                          ((unsigned)header[3] << 16) | ((unsigned)header[4] << 24);
        if (length > sizeof(payload) || fread(payload, 1, length, stdin) != length) break;
        if (header[0] == 4) break;
        ma_mutex_lock(&lock);
        if (header[0] == 2) { pr = pw = pn = 0; }
        if (header[0] == 3 && length == 1) { muted = payload[0]; cr = cw = cn = 0; }
        if (header[0] == 1 && length % 2 == 0) {
            unsigned frames = length / 2;
            if (frames > CAPACITY - pn) failed = 1;
            else for (unsigned i = 0; i < frames; i++) {
                playback[pw] = (ma_int16)((unsigned)payload[i * 2] | ((unsigned)payload[i * 2 + 1] << 8));
                pw = (pw + 1) % CAPACITY; pn++;
            }
        }
        ma_mutex_unlock(&lock);
    }
    ma_mutex_lock(&lock); stopping = 1; ma_mutex_unlock(&lock);
    ma_device_uninit(&device);
    ma_thread_wait(&thread);
    ma_mutex_uninit(&lock);
    ma_context_uninit(&context);
    return 0;
}
