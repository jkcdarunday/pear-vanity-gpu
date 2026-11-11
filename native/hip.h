#pragma once

#include <array>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#include "cache.h"
#include "device.h"
#include "kernel.h"
#include "library.h"

// Minimal declarations of the stable HIP and hiprtc C ABI, so building the
// addon needs no ROCm headers. Enumerations are int-sized and success is zero.
namespace hipabi {
using Error = int;
using RtcResult = int;
using DevicePointer = void *;
using Module = struct ihipModule_t *;
using Function = struct ihipModuleSymbol_t *;
using Stream = struct ihipStream_t *;
using Event = struct ihipEvent_t *;
using Program = struct _hiprtcProgram *;
} // namespace hipabi

struct HipApi {
  hipabi::Error (*hipInit)(unsigned int flags) = nullptr;
  hipabi::Error (*hipGetDeviceCount)(int *count) = nullptr;
  hipabi::Error (*hipSetDevice)(int device) = nullptr;
  hipabi::Error (*hipDeviceGetName)(char *name, int length, int device) = nullptr;
  hipabi::Error (*hipDriverGetVersion)(int *version) = nullptr;
  hipabi::Error (*hipMalloc)(void **pointer, size_t size) = nullptr;
  hipabi::Error (*hipFree)(void *pointer) = nullptr;
  hipabi::Error (*hipMemcpyHtoD)(hipabi::DevicePointer destination, const void *source,
                                 size_t size) = nullptr;
  hipabi::Error (*hipMemcpyDtoH)(void *destination, hipabi::DevicePointer source,
                                 size_t size) = nullptr;
  hipabi::Error (*hipMemsetD32)(hipabi::DevicePointer destination, int value,
                                size_t count) = nullptr;
  hipabi::Error (*hipModuleLoadData)(hipabi::Module *module, const void *image) = nullptr;
  hipabi::Error (*hipModuleUnload)(hipabi::Module module) = nullptr;
  hipabi::Error (*hipModuleGetFunction)(hipabi::Function *function, hipabi::Module module,
                                        const char *name) = nullptr;
  hipabi::Error (*hipModuleLaunchKernel)(hipabi::Function function, unsigned int gridX,
                                         unsigned int gridY, unsigned int gridZ,
                                         unsigned int blockX, unsigned int blockY,
                                         unsigned int blockZ, unsigned int sharedBytes,
                                         hipabi::Stream stream, void **parameters,
                                         void **extra) = nullptr;
  hipabi::Error (*hipDeviceSynchronize)() = nullptr;
  const char *(*hipGetErrorString)(hipabi::Error error) = nullptr;
  hipabi::Error (*hipEventCreate)(hipabi::Event *event) = nullptr;
  hipabi::Error (*hipEventRecord)(hipabi::Event event, hipabi::Stream stream) = nullptr;
  hipabi::Error (*hipEventSynchronize)(hipabi::Event event) = nullptr;
  hipabi::Error (*hipEventElapsedTime)(float *milliseconds, hipabi::Event start,
                                       hipabi::Event stop) = nullptr;
  hipabi::Error (*hipEventDestroy)(hipabi::Event event) = nullptr;
  hipabi::Error (*hipStreamCreate)(hipabi::Stream *stream) = nullptr;
  hipabi::Error (*hipStreamDestroy)(hipabi::Stream stream) = nullptr;
  hipabi::Error (*hipMemsetD32Async)(hipabi::DevicePointer destination, int value,
                                     size_t count, hipabi::Stream stream) = nullptr;
  hipabi::Error (*hipMemcpyDtoHAsync)(void *destination, hipabi::DevicePointer source,
                                      size_t size, hipabi::Stream stream) = nullptr;
  hipabi::Error (*hipHostMalloc)(void **pointer, size_t size,
                                 unsigned int flags) = nullptr;
  hipabi::Error (*hipHostFree)(void *pointer) = nullptr;

  hipabi::RtcResult (*hiprtcVersion)(int *major, int *minor) = nullptr;
  hipabi::RtcResult (*hiprtcCreateProgram)(hipabi::Program *program, const char *source,
                                           const char *name, int headerCount,
                                           const char *const *headers,
                                           const char *const *includeNames) = nullptr;
  hipabi::RtcResult (*hiprtcCompileProgram)(hipabi::Program program, int optionCount,
                                            const char *const *options) = nullptr;
  hipabi::RtcResult (*hiprtcGetProgramLogSize)(hipabi::Program program,
                                               size_t *size) = nullptr;
  hipabi::RtcResult (*hiprtcGetProgramLog)(hipabi::Program program, char *log) = nullptr;
  hipabi::RtcResult (*hiprtcGetCodeSize)(hipabi::Program program, size_t *size) = nullptr;
  hipabi::RtcResult (*hiprtcGetCode)(hipabi::Program program, char *code) = nullptr;
  hipabi::RtcResult (*hiprtcDestroyProgram)(hipabi::Program *program) = nullptr;

  HipApi()
      : runtime(
#ifdef _WIN32
            {"amdhip64_7.dll", "amdhip64_6.dll", "amdhip64.dll"},
#else
            {"libamdhip64.so", "libamdhip64.so.7", "libamdhip64.so.6",
             "/opt/rocm/lib/libamdhip64.so"},
#endif
            "HIP"),
        compiler(
#ifdef _WIN32
            {"hiprtc0702.dll", "hiprtc0701.dll", "hiprtc0700.dll", "hiprtc0605.dll",
             "hiprtc.dll"},
#else
            {"libhiprtc.so", "libhiprtc.so.7", "libhiprtc.so.6",
             "/opt/rocm/lib/libhiprtc.so"},
#endif
            "HIP runtime compiler") {
    runtime.load(hipInit, "hipInit");
    runtime.load(hipGetDeviceCount, "hipGetDeviceCount");
    runtime.load(hipSetDevice, "hipSetDevice");
    runtime.load(hipDeviceGetName, "hipDeviceGetName");
    runtime.load(hipDriverGetVersion, "hipDriverGetVersion");
    runtime.load(hipMalloc, "hipMalloc");
    runtime.load(hipFree, "hipFree");
    runtime.load(hipMemcpyHtoD, "hipMemcpyHtoD");
    runtime.load(hipMemcpyDtoH, "hipMemcpyDtoH");
    runtime.load(hipMemsetD32, "hipMemsetD32");
    runtime.load(hipModuleLoadData, "hipModuleLoadData");
    runtime.load(hipModuleUnload, "hipModuleUnload");
    runtime.load(hipModuleGetFunction, "hipModuleGetFunction");
    runtime.load(hipModuleLaunchKernel, "hipModuleLaunchKernel");
    runtime.load(hipDeviceSynchronize, "hipDeviceSynchronize");
    runtime.load(hipGetErrorString, "hipGetErrorString");
    runtime.load(hipEventCreate, "hipEventCreate");
    runtime.load(hipEventRecord, "hipEventRecord");
    runtime.load(hipEventSynchronize, "hipEventSynchronize");
    runtime.load(hipEventElapsedTime, "hipEventElapsedTime");
    runtime.load(hipEventDestroy, "hipEventDestroy");
    runtime.load(hipStreamCreate, "hipStreamCreate");
    runtime.load(hipStreamDestroy, "hipStreamDestroy");
    runtime.load(hipMemsetD32Async, "hipMemsetD32Async");
    runtime.load(hipMemcpyDtoHAsync, "hipMemcpyDtoHAsync");
    runtime.load(hipHostMalloc, "hipHostMalloc");
    runtime.load(hipHostFree, "hipHostFree");
    compiler.load(hiprtcVersion, "hiprtcVersion");
    compiler.load(hiprtcCreateProgram, "hiprtcCreateProgram");
    compiler.load(hiprtcCompileProgram, "hiprtcCompileProgram");
    compiler.load(hiprtcGetProgramLogSize, "hiprtcGetProgramLogSize");
    compiler.load(hiprtcGetProgramLog, "hiprtcGetProgramLog");
    compiler.load(hiprtcGetCodeSize, "hiprtcGetCodeSize");
    compiler.load(hiprtcGetCode, "hiprtcGetCode");
    compiler.load(hiprtcDestroyProgram, "hiprtcDestroyProgram");
  }

private:
  Library runtime, compiler;
};

static const HipApi &hipApi() {
  static const HipApi api;
  return api;
}

class HipDevice : public Device {
public:
  explicit HipDevice(const DeviceOptions &options) : hip(hipApi()) {
    backend = "hip";
    try {
      init(options);
    } catch (...) {
      destroy();
      throw;
    }
  }

  ~HipDevice() override { destroy(); }

  void prepare(uint32_t batch) override {
    if (batch == 0 || batch > maxBatch)
      throw std::runtime_error("Invalid HIP batch size");
  }

  void upload(const uint32_t *config, const uint32_t *table, size_t tableBytes) override {
    if (!buffers[1]) {
      check(hip.hipMalloc(&buffers[1], tableBytes), "table allocation");
      tableSize = tableBytes;
    }
    if (tableBytes != tableSize)
      throw std::runtime_error("Unexpected basepoint table size");
    check(hip.hipMemcpyHtoD(buffers[0], config, configWords * sizeof(uint32_t)),
          "configuration upload");
    check(hip.hipMemcpyHtoD(buffers[1], table, tableBytes), "table upload");
  }

  // Work runs on a private stream with pinned readback buffers, so submission
  // returns immediately and both slots can be queued at once.
  void submit(unsigned slot, const Parameters &params) override {
    Slot &target = slots[slot];
    check(hip.hipMemsetD32Async(target.results, -1, 1, stream), "result reset");
    Parameters copy = params;
    void *arguments[] = {&buffers[0], &buffers[1], &target.results, &copy};
    const unsigned int blocks =
        unsigned((size_t(params.count) + localSize - 1) / localSize);
    if (timestamps)
      check(hip.hipEventRecord(target.start, stream), "timestamp");
    check(hip.hipModuleLaunchKernel(function, blocks, 1, 1, localSize, 1, 1, 0, stream,
                                    arguments, nullptr),
          "dispatch");
    if (timestamps)
      check(hip.hipEventRecord(target.stop, stream), "timestamp");
    check(hip.hipMemcpyDtoHAsync(target.output, target.results,
                                 resultWords * sizeof(uint32_t), stream),
          "readback");
    check(hip.hipEventRecord(target.done, stream), "submission");
  }

  const uint32_t *wait(unsigned slot) override {
    Slot &target = slots[slot];
    check(hip.hipEventSynchronize(target.done), "readback");
    if (timestamps) {
      float milliseconds = 0;
      check(hip.hipEventElapsedTime(&milliseconds, target.start, target.stop),
            "timestamp");
      lastGpuSeconds = double(milliseconds) * 1e-3;
    }
    return target.output;
  }

private:
  struct Slot {
    void *results = nullptr;
    uint32_t *output = nullptr;
    hipabi::Event start = nullptr, stop = nullptr, done = nullptr;
  };

  const HipApi &hip;
  hipabi::Module module = nullptr;
  hipabi::Function function = nullptr;
  hipabi::Stream stream = nullptr;
  // 0: configuration, 1: basepoint table.
  std::array<void *, 2> buffers{};
  std::array<Slot, deviceSlots> slots{};
  size_t tableSize = 0;
  unsigned int localSize = 64;

  void check(hipabi::Error error, const char *operation) const {
    if (error != 0) {
      const char *message = hip.hipGetErrorString(error);
      throw std::runtime_error(std::string("HIP ") + operation +
                               " failed: " + (message ? message : std::to_string(error)));
    }
  }

  void destroy() noexcept {
    // Overwrite the device copy of the search key before releasing it.
    if (buffers[0])
      hip.hipMemsetD32(buffers[0], 0, configWords);
    hip.hipDeviceSynchronize();
    for (auto &buffer : buffers) {
      if (buffer)
        hip.hipFree(buffer);
      buffer = nullptr;
    }
    for (auto &slot : slots) {
      if (slot.results)
        hip.hipFree(slot.results);
      if (slot.output)
        hip.hipHostFree(slot.output);
      for (auto *event : {&slot.start, &slot.stop, &slot.done}) {
        if (*event)
          hip.hipEventDestroy(*event);
      }
      slot = Slot{};
    }
    if (stream)
      hip.hipStreamDestroy(stream);
    stream = nullptr;
    if (module)
      hip.hipModuleUnload(module);
    module = nullptr;
  }

  void init(const DeviceOptions &options) {
    check(hip.hipInit(0), "initialization");
    int count = 0;
    if (hip.hipGetDeviceCount(&count) != 0 || count < 1)
      throw std::runtime_error("No HIP GPU is available");
    // Device 0 after HIP_VISIBLE_DEVICES / ROCR_VISIBLE_DEVICES filtering.
    check(hip.hipSetDevice(0), "device selection");
    char deviceName[256] = {};
    check(hip.hipDeviceGetName(deviceName, sizeof(deviceName) - 1, 0), "device query");
    name = deviceName;
    int driver = 0, major = 0, minor = 0;
    check(hip.hipDriverGetVersion(&driver), "driver query");
    if (hip.hiprtcVersion(&major, &minor) != 0)
      throw std::runtime_error("HIP runtime compiler is unavailable");

    // hiprtc targets the current device's architecture when none is given.
    const std::string source = std::string(hip_prelude) + kernel_source;
    const std::vector<std::string> flags = {"-O3", std::string("-DTOUCH=") +
                                                       (options.mode == 0 ? "1" : "0")};
    std::string identity = "pear-vanity-gpu hip kernel 1\n" + name + "\n" +
                           std::to_string(driver) + "\n" + std::to_string(major) + "." +
                           std::to_string(minor) + "\n";
    for (const auto &flag : flags)
      identity += flag + "\n";
    identity += source;
    KernelCache cache(options.cacheDirectory, identity);
    std::vector<unsigned char> code;
    if (cache.load(code) && hip.hipModuleLoadData(&module, code.data()) != 0)
      module = nullptr;
    if (!module) {
      code = compile(source, flags);
      check(hip.hipModuleLoadData(&module, code.data()), "module load");
      cache.store(code);
    }
    check(hip.hipModuleGetFunction(&function, module, "searchKernel"), "kernel lookup");
    localSize = options.mode == 0 ? 64 : 128;

    check(hip.hipMalloc(&buffers[0], configWords * sizeof(uint32_t)), "allocation");
    check(hip.hipStreamCreate(&stream), "stream creation");
    timestamps = options.benchmark;
    for (auto &slot : slots) {
      check(hip.hipMalloc(&slot.results, resultWords * sizeof(uint32_t)), "allocation");
      void *output = nullptr;
      check(hip.hipHostMalloc(&output, resultWords * sizeof(uint32_t), 0),
            "pinned allocation");
      slot.output = static_cast<uint32_t *>(output);
      check(hip.hipEventCreate(&slot.done), "event setup");
      if (timestamps) {
        check(hip.hipEventCreate(&slot.start), "timestamp setup");
        check(hip.hipEventCreate(&slot.stop), "timestamp setup");
      }
    }
  }

  std::vector<unsigned char> compile(const std::string &source,
                                     const std::vector<std::string> &flags) const {
    hipabi::Program program = nullptr;
    if (hip.hiprtcCreateProgram(&program, source.c_str(), "pear-vanity-gpu.hip", 0,
                                nullptr, nullptr) != 0)
      throw std::runtime_error("HIP kernel program creation failed");
    std::vector<const char *> options;
    for (const auto &flag : flags)
      options.push_back(flag.c_str());
    std::vector<unsigned char> code;
    std::string failure;
    if (hip.hiprtcCompileProgram(program, int(options.size()), options.data()) != 0) {
      size_t size = 0;
      hip.hiprtcGetProgramLogSize(program, &size);
      std::string log(size, '\0');
      if (size)
        hip.hiprtcGetProgramLog(program, log.data());
      failure =
          "HIP kernel compilation failed: " + std::string(log.c_str()).substr(0, 4096);
    } else {
      size_t size = 0;
      if (hip.hiprtcGetCodeSize(program, &size) == 0 && size) {
        code.resize(size);
        if (hip.hiprtcGetCode(program, reinterpret_cast<char *>(code.data())) != 0)
          code.clear();
      }
      if (code.empty())
        failure = "HIP kernel code retrieval failed";
    }
    hip.hiprtcDestroyProgram(&program);
    if (!failure.empty())
      throw std::runtime_error(failure);
    return code;
  }
};
